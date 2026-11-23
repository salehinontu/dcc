import type { RecordingFolder, RecordingSort, RecordingTagCount } from '@dji/protocol'
import type { Db } from '../db'
import { DEVICE_NAME_SQL } from '../store-fleet'

export interface RecordingRow {
  id: string
  session_id: string
  source: string
  device_sn: string | null
  device_label: string | null
  mode: string
  title: string | null
  folder: string | null
  state: string
  error: string | null
  file: string
  started_at: Date | string
  ended_at: Date | string
  duration_s: number
  /** float8 in the query: a clip can pass 2 GB, which an INTEGER column could not hold. */
  size_bytes: number
  operator_email: string | null
  tenant_id: string | null
  tags: string[] | null
  note: string | null
}

export interface NewRecording {
  id: string
  sessionId: string
  deviceSn: string | null
  mode: string
  source?: 'drone' | 'upload'
  title?: string | null
  folder?: string | null
  state?: 'processing' | 'ready' | 'failed'
  tenantId?: string | null
  file: string
  startedAt: Date
  endedAt: Date
  durationS: number
  sizeBytes: number
  operatorEmail: string | null
}

/**
 * What an account may see. A recorded clip follows the drone grants (`allowedSns`, undefined for
 * every drone). An upload belongs to one customer (`tenantId`, undefined for a Developer, who
 * sees all) and, when it is tied to a drone, also needs that drone's grant.
 */
export interface RecordingScope {
  allowedSns?: string[]
  tenantId?: string
}

export interface RecordingFilter {
  scope: RecordingScope
  deviceSn?: string
  source?: 'drone' | 'upload'
  /** An exact folder name. */
  folder?: string
  /** Words from the title, folder, drone name, file name, a tag or the note. */
  q?: string
  /** A tag, whatever its case. */
  tag?: string
  /** A video is returned when it overlaps [from, to]: it ends at or after `from` and starts at or before `to`. */
  fromIso?: string
  toIso?: string
  sort?: RecordingSort
  limit: number
  offset: number
}

const SELECT = `
  SELECT r.id, r.session_id, r.source, r.device_sn, ${DEVICE_NAME_SQL} AS device_label, r.mode,
         r.title, r.folder, r.state, r.error, r.file, r.started_at, r.ended_at, r.duration_s,
         r.size_bytes::float8 AS size_bytes, r.operator_email, r.tenant_id, r.tags, r.note
  FROM recordings r
  LEFT JOIN devices d ON d.sn = r.device_sn`

/** True when `row` may be seen with `scope`: the same rule the list query applies, for one row. */
export function visibleTo(
  row: Pick<RecordingRow, 'source' | 'device_sn' | 'tenant_id'>,
  scope: RecordingScope,
): boolean {
  const droneOk =
    !scope.allowedSns || (row.device_sn != null && scope.allowedSns.includes(row.device_sn))
  if (row.source !== 'upload') return droneOk
  if (scope.tenantId && row.tenant_id !== scope.tenantId) return false
  return row.device_sn == null || droneOk
}

/** `%`, `_` and `\` in a search are letters, not wildcards. */
function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export interface AutoDeviceRow {
  sn: string
  /** The choice made for the drone; null follows the installation's default. */
  auto_record: boolean | null
  online: boolean
}

/** A clip the server may delete by itself, oldest first. */
export interface AutoClipRow {
  id: string
  file: string
  size_bytes: number
}

export interface RecordingUsage {
  usedBytes: number
  autoBytes: number
  clips: number
  oldestAutoAt: Date | string | null
  newestAt: Date | string | null
  bytesLast24h: number
}

/** Only automatic clips are ever deleted without a person asking: a manual recording or an upload stays. */
const AUTO = `source = 'drone' AND mode = 'continuous'`

/** The archive of videos: what the server recorded and what people uploaded, and where it is on disk. */
export class RecordingStore {
  constructor(private readonly db: Db) {}

  async insert(row: NewRecording): Promise<void> {
    await this.db.query(
      `INSERT INTO recordings
         (id, session_id, device_sn, mode, source, title, folder, state, tenant_id, file,
          started_at, ended_at, duration_s, size_bytes, operator_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (file) DO NOTHING`,
      [
        row.id,
        row.sessionId,
        row.deviceSn,
        row.mode,
        row.source ?? 'drone',
        row.title ?? null,
        row.folder ?? null,
        row.state ?? 'ready',
        row.tenantId ?? null,
        row.file,
        row.startedAt,
        row.endedAt,
        row.durationS,
        row.sizeBytes,
        row.operatorEmail,
      ],
    )
  }

  /** An upload that was made playable (or failed): its final file, length and state. */
  async finishUpload(
    id: string,
    patch:
      | {
          state: 'ready'
          file: string
          startedAt: Date
          endedAt: Date
          durationS: number
          sizeBytes: number
        }
      | { state: 'failed'; error: string },
  ): Promise<void> {
    if (patch.state === 'failed') {
      await this.db.query(`UPDATE recordings SET state = 'failed', error = $2 WHERE id = $1`, [
        id,
        patch.error,
      ])
      return
    }
    await this.db.query(
      `UPDATE recordings SET state = 'ready', error = NULL, file = $2, started_at = $3, ended_at = $4,
         duration_s = $5, size_bytes = $6 WHERE id = $1`,
      [id, patch.file, patch.startedAt, patch.endedAt, patch.durationS, patch.sizeBytes],
    )
  }

  /** The upload names already used in a folder of a customer, to number a repeat ("name (2)"). */
  async titleTaken(
    tenantId: string | null,
    folder: string | null,
    title: string,
  ): Promise<boolean> {
    const rows = await this.db.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM recordings
       WHERE source = 'upload' AND tenant_id IS NOT DISTINCT FROM $1::text AND folder IS NOT DISTINCT FROM $2::text
         AND lower(title) = lower($3::text)`,
      [tenantId, folder, title],
    )
    return Number(rows[0]?.n ?? 0) > 0
  }

  /** The name the dashboard shows for each of these drones: name, then the nickname after a dot. */
  async deviceNames(sns: string[]): Promise<Map<string, string | null>> {
    if (sns.length === 0) return new Map()
    const rows = await this.db.query<{ sn: string; name: string | null }>(
      `SELECT d.sn, ${DEVICE_NAME_SQL} AS name FROM devices d WHERE d.sn = ANY($1::text[])`,
      [sns],
    )
    return new Map(rows.map((row) => [row.sn, row.name]))
  }

  async get(id: string): Promise<RecordingRow | null> {
    const rows = await this.db.query<RecordingRow>(`${SELECT} WHERE r.id = $1`, [id])
    return rows[0] ?? null
  }

  /** The WHERE part that applies a scope; `param` adds a value and returns its `$n`. */
  private scopeSql(scope: RecordingScope, param: (value: unknown) => string): string {
    const drone = scope.allowedSns
      ? `r.device_sn = ANY(${param(scope.allowedSns)}::text[])`
      : 'TRUE'
    const upload = ["r.source = 'upload'"]
    if (scope.tenantId) upload.push(`r.tenant_id = ${param(scope.tenantId)}`)
    if (scope.allowedSns)
      upload.push(`(r.device_sn IS NULL OR r.device_sn = ANY(${param(scope.allowedSns)}::text[]))`)
    return `((r.source = 'drone' AND ${drone}) OR (${upload.join(' AND ')}))`
  }

  async list(filter: RecordingFilter): Promise<{ rows: RecordingRow[]; total: number }> {
    const params: unknown[] = []
    const param = (value: unknown): string => {
      params.push(value)
      return `$${params.length}`
    }
    const where: string[] = [this.scopeSql(filter.scope, param)]
    if (filter.deviceSn) where.push(`r.device_sn = ${param(filter.deviceSn)}`)
    if (filter.source) where.push(`r.source = ${param(filter.source)}`)
    if (filter.folder) where.push(`r.folder = ${param(filter.folder)}`)
    if (filter.fromIso) where.push(`r.ended_at >= ${param(filter.fromIso)}::timestamptz`)
    if (filter.toIso) where.push(`r.started_at <= ${param(filter.toIso)}::timestamptz`)
    if (filter.tag)
      where.push(
        `EXISTS (SELECT 1 FROM unnest(r.tags) t WHERE lower(t) = lower(${param(filter.tag)}))`,
      )
    if (filter.q) {
      const like = param(`%${likeEscape(filter.q)}%`)
      where.push(
        `(r.title ILIKE ${like} OR r.folder ILIKE ${like} OR r.file ILIKE ${like} OR ${DEVICE_NAME_SQL} ILIKE ${like}
          OR r.note ILIKE ${like} OR EXISTS (SELECT 1 FROM unnest(r.tags) t WHERE t ILIKE ${like}))`,
      )
    }
    const clause = ` WHERE ${where.join(' AND ')}`

    // By when the footage was recorded (newest or oldest first), or by when it was added to the archive.
    const order =
      filter.sort === 'oldest'
        ? 'r.started_at ASC, r.id'
        : filter.sort === 'added'
          ? 'r.created_at DESC, r.id'
          : 'r.started_at DESC, r.id'
    const rows = await this.db.query<RecordingRow>(
      `${SELECT}${clause} ORDER BY ${order} LIMIT ${param(filter.limit)} OFFSET ${param(filter.offset)}`,
      params,
    )
    // The count reuses the filter, not the paging values (the last two parameters).
    const counted = await this.db.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM recordings r LEFT JOIN devices d ON d.sn = r.device_sn${clause}`,
      params.slice(0, params.length - 2),
    )
    return { rows, total: Number(counted[0]?.n ?? 0) }
  }

  /** Changes the tags and/or the note of one video; what is left out stays. Null when there is no such video. */
  async annotate(
    id: string,
    change: { tags?: string[]; note?: string | null },
  ): Promise<RecordingRow | null> {
    const sets: string[] = []
    const params: unknown[] = [id]
    if (change.tags !== undefined) {
      params.push(change.tags)
      sets.push(`tags = $${params.length}::text[]`)
    }
    if (change.note !== undefined) {
      params.push(change.note)
      sets.push(`note = $${params.length}`)
    }
    if (sets.length === 0) return this.get(id)
    const done = await this.db.query(
      `UPDATE recordings SET ${sets.join(', ')} WHERE id = $1 RETURNING id`,
      params,
    )
    return done.length > 0 ? this.get(id) : null
  }

  /** The tags in use on the videos a scope may see, most used first; the same word in another case is one tag. */
  async tags(scope: RecordingScope): Promise<RecordingTagCount[]> {
    const params: unknown[] = []
    const param = (value: unknown): string => {
      params.push(value)
      return `$${params.length}`
    }
    const rows = await this.db.query<{ name: string; count: number | string }>(
      `SELECT min(t) AS name, count(*) AS count
       FROM recordings r, unnest(r.tags) AS t
       WHERE ${this.scopeSql(scope, param)}
       GROUP BY lower(t) ORDER BY count(*) DESC, lower(min(t)) LIMIT 500`,
      params,
    )
    return rows.map((row) => ({ name: row.name, count: Number(row.count) }))
  }

  /** The folders uploads are in, for the folder picker and filter. */
  async folders(scope: RecordingScope): Promise<RecordingFolder[]> {
    const params: unknown[] = []
    const param = (value: unknown): string => {
      params.push(value)
      return `$${params.length}`
    }
    const rows = await this.db.query<{ name: string; count: number | string }>(
      `SELECT r.folder AS name, count(*) AS count FROM recordings r
       WHERE r.folder IS NOT NULL AND ${this.scopeSql(scope, param)} AND r.source = 'upload'
       GROUP BY r.folder ORDER BY lower(r.folder), r.folder`,
      params,
    )
    return rows.map((row) => ({ name: row.name, count: Number(row.count) }))
  }

  /** Uploads still being made playable, to carry on after a restart. */
  async processing(): Promise<RecordingRow[]> {
    return this.db.query<RecordingRow>(
      `${SELECT} WHERE r.state = 'processing' ORDER BY r.created_at`,
    )
  }

  /** Removes the row and returns it, so the caller can delete the file it pointed to. */
  async remove(id: string): Promise<RecordingRow | null> {
    const row = await this.get(id)
    if (!row) return null
    await this.db.query(`DELETE FROM recordings WHERE id = $1`, [id])
    return row
  }

  /** The drones in service, with the automatic-recording choice made for each. */
  async autoDevices(): Promise<AutoDeviceRow[]> {
    return this.db.query<AutoDeviceRow>(
      `SELECT sn, auto_record, online FROM devices
       WHERE deleted_at IS NULL AND disabled_at IS NULL ORDER BY sn`,
    )
  }

  /** Sets the choice for a drone (null: follow the default). False when there is no such drone. */
  async setAuto(sn: string, value: boolean | null): Promise<boolean> {
    const rows = await this.db.query<{ sn: string }>(
      `UPDATE devices SET auto_record = $2 WHERE sn = $1 AND deleted_at IS NULL RETURNING sn`,
      [sn, value],
    )
    return rows.length > 0
  }

  async usage(): Promise<RecordingUsage> {
    const rows = await this.db.query<{
      used: number
      auto_bytes: number
      clips: number
      oldest_auto: Date | string | null
      newest: Date | string | null
      last24: number
    }>(
      `SELECT coalesce(sum(size_bytes), 0)::float8 AS used,
              coalesce(sum(size_bytes) FILTER (WHERE ${AUTO}), 0)::float8 AS auto_bytes,
              count(*)::int AS clips,
              min(started_at) FILTER (WHERE ${AUTO}) AS oldest_auto,
              max(started_at) AS newest,
              coalesce(sum(size_bytes) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::float8 AS last24
       FROM recordings`,
    )
    const row = rows[0]
    return {
      usedBytes: row?.used ?? 0,
      autoBytes: row?.auto_bytes ?? 0,
      clips: row?.clips ?? 0,
      oldestAutoAt: row?.oldest_auto ?? null,
      newestAt: row?.newest ?? null,
      bytesLast24h: row?.last24 ?? 0,
    }
  }

  /** The oldest automatic clips, for cleanup that needs room. */
  async oldestAuto(limit: number): Promise<AutoClipRow[]> {
    return this.db.query<AutoClipRow>(
      `SELECT id, file, size_bytes::float8 AS size_bytes FROM recordings
       WHERE ${AUTO} ORDER BY started_at ASC, id LIMIT $1`,
      [limit],
    )
  }

  /** Automatic clips that ended before `cutoff`. */
  async expiredAuto(cutoff: Date, limit: number): Promise<AutoClipRow[]> {
    return this.db.query<AutoClipRow>(
      `SELECT id, file, size_bytes::float8 AS size_bytes FROM recordings
       WHERE ${AUTO} AND ended_at < $1 ORDER BY started_at ASC, id LIMIT $2`,
      [cutoff, limit],
    )
  }

  /** Every `file` the archive knows, to find clips on disk that were never indexed. */
  async files(): Promise<Set<string>> {
    const rows = await this.db.query<{ file: string }>(`SELECT file FROM recordings`)
    return new Set(rows.map((row) => row.file))
  }
}
