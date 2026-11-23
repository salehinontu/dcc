import { createHash } from 'node:crypto'
import type {
  AuditEvent,
  AuditFilter,
  AuditIntegrity,
  AuditOutcome,
  AuditPage,
} from '@dji/protocol'
import type { Db } from './db'

/** The `prev_hash` of the first line. */
const GENESIS = '0'.repeat(64)

export interface AuditEntry {
  actorId?: string | null
  actorEmail?: string | null
  actorRole?: string | null
  /** The Admin whose team the line belongs to; null means only the vendor sees it. */
  tenantId?: string | null
  action: string
  outcome: AuditOutcome
  status?: number | null
  targetType?: string | null
  targetId?: string | null
  targetLabel?: string | null
  details?: Record<string, unknown> | null
  ip?: string | null
  userAgent?: string | null
}

/** Whose lines a reader may see: a Developer all of them, anyone else their own team's. */
export type AuditScope = { all: true } | { tenantId: string }

interface AuditRow {
  seq: string | number
  ts: Date | string
  actor_id: string | null
  actor_email: string | null
  actor_role: string | null
  tenant_id: string | null
  action: string
  outcome: string
  status: number | null
  target_type: string | null
  target_id: string | null
  target_label: string | null
  details: Record<string, unknown> | null
  ip: string | null
  user_agent: string | null
  prev_hash: string
  hash: string
  redacted_at: Date | string | null
}

/** JSON with the keys in order, so the same data always gives the same text. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The text a line's hash is made from. It is built the same way when the line is written and when it is checked. */
function canonical(f: {
  ts: string
  actorId: string | null
  actorEmail: string | null
  actorRole: string | null
  tenantId: string | null
  action: string
  outcome: string
  status: number | null
  targetType: string | null
  targetId: string | null
  targetLabel: string | null
  details: unknown
  ip: string | null
  userAgent: string | null
}): string {
  return JSON.stringify([
    f.ts,
    f.actorId,
    f.actorEmail,
    f.actorRole,
    f.tenantId,
    f.action,
    f.outcome,
    f.status,
    f.targetType,
    f.targetId,
    f.targetLabel,
    stableStringify(f.details),
    f.ip,
    f.userAgent,
  ])
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (char) => `\\${char}`)
const trim = (text: string | null | undefined, max: number): string | null =>
  text ? text.slice(0, max) : null

function toEvent(row: AuditRow): AuditEvent {
  return {
    seq: Number(row.seq),
    time: new Date(row.ts).toISOString(),
    actorEmail: row.actor_email,
    actorRole: row.actor_role,
    action: row.action,
    outcome: row.outcome as AuditOutcome,
    status: row.status,
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel: row.target_label,
    details: row.details,
    ip: row.ip,
    userAgent: row.user_agent,
    hash: row.hash,
  }
}

/**
 * The audit trail. Everything that changes something, and the sign-ins and refusals around it, is written here
 * as one line: who, what, to what, when, from where, how it ended. Lines are never changed or deleted (a trigger
 * refuses it) and each carries the hash of the line before it, so `verify()` finds an edit or a gap. Writing
 * never fails the request it describes: a line that cannot be written is logged and the request goes on.
 */
export class AuditLog {
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly db: Db) {}

  /** Writes a line without making the caller wait. Use `flush()` to wait for the ones in flight. */
  record(entry: AuditEntry): void {
    const job = this.write(entry)
      .catch((error) => console.error('[audit] could not record', entry.action, error))
      .finally(() => this.pending.delete(job))
    this.pending.add(job)
  }

  /** Waits until every line handed to `record` has been written. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  /** Writes a line and waits for it. */
  async write(entry: AuditEntry): Promise<void> {
    const ts = new Date().toISOString()
    const fields = {
      ts,
      actorId: trim(entry.actorId, 64),
      actorEmail: trim(entry.actorEmail, 254),
      actorRole: trim(entry.actorRole, 32),
      tenantId: trim(entry.tenantId, 64),
      action: entry.action.slice(0, 80),
      outcome: entry.outcome,
      status: entry.status ?? null,
      targetType: trim(entry.targetType, 40),
      targetId: trim(entry.targetId, 200),
      targetLabel: trim(entry.targetLabel, 300),
      details: entry.details ?? null,
      ip: trim(entry.ip, 64),
      userAgent: trim(entry.userAgent, 300),
    }
    // The chain's head row is updated and the line inserted in one statement. Updating that one row makes a
    // second writer wait for the first and then read the new hash, so two lines can never take the same place.
    await this.db.query(
      `WITH h AS (
         UPDATE audit_head
            SET prev = hash, n = n + 1,
                hash = encode(sha256(convert_to(hash || $1::text, 'UTF8')), 'hex')
          WHERE id = 1
        RETURNING n, prev, hash
       )
       INSERT INTO audit_log (seq, ts, actor_id, actor_email, actor_role, tenant_id, action, outcome, status,
                              target_type, target_id, target_label, details, ip, user_agent, prev_hash, hash)
       SELECT h.n, $2::timestamptz, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::int,
              $10::text, $11::text, $12::text, $13::jsonb, $14::text, $15::text, h.prev, h.hash
         FROM h`,
      [
        canonical(fields),
        ts,
        fields.actorId,
        fields.actorEmail,
        fields.actorRole,
        fields.tenantId,
        fields.action,
        fields.outcome,
        fields.status,
        fields.targetType,
        fields.targetId,
        fields.targetLabel,
        fields.details === null ? null : JSON.stringify(fields.details),
        fields.ip,
        fields.userAgent,
      ],
    )
  }

  private where(filter: AuditFilter, scope: AuditScope, params: unknown[]): string {
    const p = (value: unknown): string => {
      params.push(value)
      return `$${params.length}`
    }
    // A line a Developer deleted is only a place-holder in the chain: no screen or export shows it.
    const where: string[] = ['redacted_at IS NULL']
    // A customer reads its own team's lines. What the vendor's Developer did is not part of them, even where it
    // concerned that team's accounts: the vendor's own work is the vendor's business.
    if (!('all' in scope))
      where.push(`tenant_id = ${p(scope.tenantId)}`, `actor_role IS DISTINCT FROM 'developer'`)
    if (filter.from) where.push(`ts >= ${p(filter.from)}::timestamptz`)
    if (filter.to) where.push(`ts <= ${p(filter.to)}::timestamptz`)
    // An account's trail is what it did and what was done to it.
    if (filter.actor) {
      const like = p(`%${likeEscape(filter.actor)}%`)
      where.push(
        `(actor_email ILIKE ${like} OR (target_type = 'user' AND target_label ILIKE ${like}))`,
      )
    }
    if (filter.category) where.push(`action LIKE ${p(`${likeEscape(filter.category)}.%`)}`)
    if (filter.outcome) where.push(`outcome = ${p(filter.outcome)}`)
    if (filter.q) {
      const like = p(`%${likeEscape(filter.q)}%`)
      where.push(
        `(actor_email ILIKE ${like} OR action ILIKE ${like} OR target_label ILIKE ${like} OR target_id ILIKE ${like} OR ip ILIKE ${like} OR details::text ILIKE ${like})`,
      )
    }
    return ` WHERE ${where.join(' AND ')}`
  }

  /** A page of the trail, newest first, with how many lines match and the categories present. */
  async list(
    filter: AuditFilter,
    scope: AuditScope,
    limit: number,
    offset: number,
  ): Promise<AuditPage> {
    const params: unknown[] = []
    const clause = this.where(filter, scope, params)
    const rows = await this.db.query<AuditRow>(
      `SELECT * FROM audit_log${clause} ORDER BY seq DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    )
    const counted = await this.db.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM audit_log${clause}`,
      params,
    )
    const scopeParams: unknown[] = []
    const scopeClause = this.where({}, scope, scopeParams)
    const categories = await this.db.query<{ category: string }>(
      `SELECT DISTINCT split_part(action, '.', 1) AS category FROM audit_log${scopeClause} ORDER BY 1`,
      scopeParams,
    )
    return {
      events: rows.map(toEvent),
      total: Number(counted[0]?.n ?? 0),
      categories: categories.map((row) => row.category),
    }
  }

  /** The numbers of the lines a filter matches, oldest first, for a deletion of everything that matches. */
  async seqsMatching(filter: AuditFilter, scope: AuditScope, max: number): Promise<number[]> {
    const params: unknown[] = []
    const clause = this.where(filter, scope, params)
    const rows = await this.db.query<{ seq: string | number }>(
      `SELECT seq FROM audit_log${clause} AND action <> 'audit.deleted' ORDER BY seq ASC LIMIT ${max}`,
      params,
    )
    return rows.map((row) => Number(row.seq))
  }

  /**
   * Deletes lines: each is blanked in place (see `audit_remove` in schema.sql) so the chain around it still checks
   * out. Returns how many were blanked. The caller records the deletion first (`audit.deleted`), because a line that
   * went without a record is what `verify()` reports.
   */
  async remove(seqs: number[]): Promise<number> {
    let blanked = 0
    for (let at = 0; at < seqs.length; at += 1000) {
      const rows = await this.db.query<{ n: number }>(`SELECT audit_remove($1::bigint[]) AS n`, [
        seqs.slice(at, at + 1000),
      ])
      blanked += Number(rows[0]?.n ?? 0)
    }
    return blanked
  }

  async count(filter: AuditFilter, scope: AuditScope): Promise<number> {
    const params: unknown[] = []
    const clause = this.where(filter, scope, params)
    const rows = await this.db.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM audit_log${clause}`,
      params,
    )
    return Number(rows[0]?.n ?? 0)
  }

  /** Every matching line, oldest first, a batch at a time, for an export that does not hold it all in memory. */
  async *iterate(filter: AuditFilter, scope: AuditScope, batch = 500): AsyncGenerator<AuditEvent> {
    let last = 0
    for (;;) {
      const params: unknown[] = []
      const clause = this.where(filter, scope, params)
      params.push(last)
      const rows = await this.db.query<AuditRow>(
        `SELECT * FROM audit_log${clause ? `${clause} AND` : ' WHERE'} seq > $${params.length}
          ORDER BY seq ASC LIMIT ${batch}`,
        params,
      )
      if (rows.length === 0) return
      for (const row of rows) yield toEvent(row)
      last = Number(rows[rows.length - 1]!.seq)
      if (rows.length < batch) return
    }
  }

  /** The last link of the chain: how many lines there are and the hash a copy of the log can be compared with. */
  async head(): Promise<{ seq: number; hash: string }> {
    const rows = await this.db.query<{ n: string | number; hash: string }>(
      `SELECT n, hash FROM audit_head WHERE id = 1`,
    )
    return { seq: Number(rows[0]?.n ?? 0), hash: rows[0]?.hash ?? GENESIS }
  }

  /**
   * Walks the whole chain: each line must name the one before it, its hash must be what its contents give,
   * no number may be missing, and the last line must be the head. An edited line, a removed one, or lines cut
   * from the end all fail it. A line a Developer deleted is only a place-holder: its content cannot be checked
   * any more, but the chain around it can, and the number of such lines must not exceed what the recorded
   * deletions (`audit.deleted`) say, so a line blanked behind the app's back is found. (Someone who can rewrite
   * the whole table and the head can still forge a chain, which is why an export carries the head hash: keep
   * one somewhere else.)
   */
  async verify(): Promise<AuditIntegrity> {
    const head = await this.head()
    let checked = 0
    let redacted = 0
    let firstRedacted = 0
    let prevHash: string | null = null
    let prevSeq = 0
    const broken = (seq: number, reason: string): AuditIntegrity => ({
      ok: false,
      checked,
      headSeq: head.seq,
      headHash: head.hash,
      brokenAt: seq,
      reason,
      ...(redacted > 0 ? { redacted } : {}),
    })
    let last = 0
    for (;;) {
      const rows = await this.db.query<AuditRow>(
        `SELECT * FROM audit_log WHERE seq > $1 ORDER BY seq ASC LIMIT 1000`,
        [last],
      )
      if (rows.length === 0) break
      for (const row of rows) {
        const seq = Number(row.seq)
        if (prevHash === null) {
          if (seq === 1 && row.prev_hash !== GENESIS)
            return broken(seq, 'the first line does not start the chain')
        } else {
          if (seq !== prevSeq + 1) return broken(seq, `line ${prevSeq + 1} is missing`)
          if (row.prev_hash !== prevHash)
            return broken(seq, 'it does not follow the line before it')
        }
        if (row.redacted_at !== null) {
          // Blanked on purpose: only its place in the chain is left to check, and that was checked above.
          if (redacted === 0) firstRedacted = seq
          redacted++
          prevHash = row.hash
          prevSeq = seq
          checked++
          continue
        }
        const expected = sha256(
          row.prev_hash +
            canonical({
              ts: new Date(row.ts).toISOString(),
              actorId: row.actor_id,
              actorEmail: row.actor_email,
              actorRole: row.actor_role,
              tenantId: row.tenant_id,
              action: row.action,
              outcome: row.outcome,
              status: row.status,
              targetType: row.target_type,
              targetId: row.target_id,
              targetLabel: row.target_label,
              details: row.details,
              ip: row.ip,
              userAgent: row.user_agent,
            }),
        )
        if (expected !== row.hash) return broken(seq, 'its contents were changed')
        prevHash = row.hash
        prevSeq = seq
        checked++
      }
      last = prevSeq
    }
    if (head.seq !== prevSeq) return broken(head.seq, 'lines are missing from the end')
    if (prevHash !== null && head.hash !== prevHash)
      return broken(head.seq, 'the head does not match the last line')
    if (redacted > 0) {
      // Every deletion writes its own line first, saying how many it meant to remove.
      const declared = await this.db.query<{ n: string | number }>(
        `SELECT coalesce(sum((details->>'count')::int), 0) AS n FROM audit_log
          WHERE action = 'audit.deleted' AND redacted_at IS NULL AND details->>'count' ~ '^[0-9]+$'`,
      )
      if (redacted > Number(declared[0]?.n ?? 0))
        return broken(firstRedacted, 'a line was blanked without a record of deleting it')
    }
    return {
      ok: true,
      checked,
      headSeq: head.seq,
      headHash: head.hash,
      ...(redacted > 0 ? { redacted } : {}),
    }
  }

  /** When each account last signed in, by lower-case email, for the users list. */
  async lastLogins(): Promise<Map<string, string>> {
    const rows = await this.db.query<{ email: string; at: Date | string }>(
      `SELECT lower(actor_email) AS email, max(ts) AS at FROM audit_log
        WHERE action = 'auth.login' AND outcome = 'success' AND actor_email IS NOT NULL
        GROUP BY 1`,
    )
    return new Map(rows.map((row) => [row.email, new Date(row.at).toISOString()]))
  }

  /** The account behind an email, for the line of someone who is not signed in (a sign-in attempt). */
  async userByEmail(
    email: string,
  ): Promise<{ id: string; role: string; tenantId: string | null } | null> {
    const rows = await this.db.query<{ id: string; role: string; admin_id: string | null }>(
      `SELECT id, role, admin_id FROM users WHERE lower(email) = lower($1)`,
      [email.slice(0, 254)],
    )
    const row = rows[0]
    return row
      ? { id: row.id, role: row.role, tenantId: row.role === 'developer' ? null : row.admin_id }
      : null
  }

  /** What a target is called now, for a line written before the thing is changed or deleted. */
  async labelFor(
    type: string,
    id: string,
  ): Promise<{
    label: string | null
    tenantId?: string | null
    row?: Record<string, unknown>
  } | null> {
    const one = async <T>(sql: string): Promise<T | null> =>
      (await this.db.query<T>(sql, [id]))[0] ?? null
    switch (type) {
      case 'user': {
        const row = await one<{
          email: string
          role: string
          permissions: string[]
          all_drones: boolean
          drone_permissions: unknown
          disabled: boolean
          admin_id: string | null
        }>(
          `SELECT email, role, permissions, all_drones, drone_permissions, disabled, admin_id FROM users WHERE id = $1`,
        )
        return row ? { label: row.email, tenantId: row.admin_id, row: { ...row } } : null
      }
      case 'drone': {
        const row = await one<{ label: string }>(
          `SELECT coalesce(display_name, model, sn) AS label FROM devices WHERE sn = $1`,
        )
        return row ? { label: row.label } : null
      }
      case 'controller':
        return (await one(`SELECT sn AS label FROM gateways WHERE sn = $1`)) ?? { label: id }
      case 'zone':
        return one(`SELECT name AS label FROM zones WHERE id = $1`)
      case 'api_token':
        return one(`SELECT name AS label FROM api_tokens WHERE id = $1`)
      case 'recording':
        return one(`SELECT coalesce(title, file) AS label FROM recordings WHERE id = $1`)
      case 'screenshot':
        return one(`SELECT filename AS label FROM screenshots WHERE id = $1`)
      case 'stream':
        return one(
          `SELECT coalesce(d.display_name, d.model, d.sn) AS label FROM streams s
             JOIN devices d ON d.sn = s.device_sn WHERE s.id = $1`,
        )
      default:
        return null
    }
  }
}
