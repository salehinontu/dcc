import { randomUUID } from 'node:crypto'
import {
  DRONE_COLORS,
  type AlertKind,
  type AlertRecord,
  type FlightSummary,
  type TrackStats,
  type Zone,
  type ZoneCategory,
  type ZoneInput,
  type ZoneKind,
  type ZoneShape,
} from '@dji/protocol'
import type { Db } from './db'

type Stamp = Date | string | null

const iso = (value: Stamp | undefined): string | null => {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

/* ---------------------------------------------------------------- row types */

interface ZoneRow {
  id: string
  kind: string
  name: string
  category: string
  shape: ZoneShape
  buffer_m: number
  enabled: boolean
  device_sns: string[]
  notes: string
  source: string
  created_at: Stamp
  updated_at: Stamp
}

interface AlertRow {
  id: string
  kind: string
  severity: string
  device_sn: string
  device_label: string | null
  zone_id: string | null
  zone_name: string | null
  flight_id: string | null
  lat: number | null
  lon: number | null
  alt_rel: number | null
  distance_m: number | null
  message: string
  raised_at: Stamp
  cleared_at: Stamp
  acknowledged_at: Stamp
  acknowledged_by: string | null
}

interface FlightRow {
  id: string
  device_sn: string
  device_label: string | null
  device_color: string | null
  operator_email: string | null
  controller_sn: string | null
  status: string
  started_at: Stamp
  ended_at: Stamp
  duration_s: number
  distance_m: number
  max_alt_m: number | null
  max_speed_ms: number | null
  avg_speed_ms: number | null
  min_battery_pct: number | null
  start_lat: number | null
  start_lon: number | null
  end_lat: number | null
  end_lon: number | null
  max_range_m: number
  alert_count: string | number
}

export interface FlightFilter {
  deviceSn?: string
  fromIso?: string
  toIso?: string
  beforeIso?: string
  allowedSns?: string[]
  limit: number
}

export interface AlertFilter {
  deviceSn?: string
  activeOnly?: boolean
  flightId?: string
  beforeIso?: string
  allowedSns?: string[]
  limit: number
}

export interface DeviceProfile {
  sn: string
  displayName: string | null
  label: string | null
  color: string
}

/* ----------------------------------------------------------------- mappers */

const toZone = (row: ZoneRow): Zone => ({
  id: row.id,
  kind: row.kind as ZoneKind,
  name: row.name,
  category: row.category as ZoneCategory,
  shape: row.shape,
  bufferM: Number(row.buffer_m),
  enabled: row.enabled,
  deviceSns: Array.isArray(row.device_sns) ? row.device_sns : [],
  notes: row.notes,
  source: row.source === 'builtin' ? 'builtin' : 'custom',
  createdAt: iso(row.created_at) ?? '',
  updatedAt: iso(row.updated_at) ?? '',
})

const toAlert = (row: AlertRow): AlertRecord => ({
  id: row.id,
  kind: row.kind as AlertKind,
  severity: row.severity === 'critical' ? 'critical' : 'warning',
  deviceSn: row.device_sn,
  deviceLabel: row.device_label,
  zoneId: row.zone_id,
  zoneName: row.zone_name,
  flightId: row.flight_id,
  lat: row.lat,
  lon: row.lon,
  altRel: row.alt_rel,
  distanceM: row.distance_m == null ? null : Number(row.distance_m),
  message: row.message,
  raisedAt: iso(row.raised_at) ?? '',
  clearedAt: iso(row.cleared_at),
  acknowledgedAt: iso(row.acknowledged_at),
  acknowledgedBy: row.acknowledged_by,
})

const toFlight = (row: FlightRow): FlightSummary => ({
  id: row.id,
  deviceSn: row.device_sn,
  deviceLabel: row.device_label,
  deviceColor: row.device_color,
  operatorEmail: row.operator_email,
  controllerSn: row.controller_sn,
  startedAt: iso(row.started_at) ?? '',
  endedAt: iso(row.ended_at),
  status: row.status === 'active' ? 'active' : 'completed',
  durationS: Number(row.duration_s),
  distanceM: Number(row.distance_m),
  maxAltM: num(row.max_alt_m),
  maxSpeedMs: num(row.max_speed_ms),
  avgSpeedMs: num(row.avg_speed_ms),
  minBatteryPct: num(row.min_battery_pct),
  startLat: num(row.start_lat),
  startLon: num(row.start_lon),
  endLat: num(row.end_lat),
  endLon: num(row.end_lon),
  maxRangeM: Number(row.max_range_m),
  alertCount: Number(row.alert_count),
})

/**
 * How an aircraft is named in a list or a record: its name (or model), then its nickname when it
 * has one. The web's `deviceLabel()` builds the same text from a live device.
 */
export const DEVICE_NAME_SQL = `NULLIF(CONCAT_WS(' · ', COALESCE(d.display_name, d.model), d.label), '')`

const FLIGHT_SELECT = `
  SELECT f.*, ${DEVICE_NAME_SQL} AS device_label, d.color AS device_color,
         (SELECT count(*) FROM alerts a WHERE a.flight_id = f.id) AS alert_count
  FROM flights f
  LEFT JOIN devices d ON d.sn = f.device_sn`

const ALERT_SELECT = `
  SELECT a.*, ${DEVICE_NAME_SQL} AS device_label
  FROM alerts a LEFT JOIN devices d ON d.sn = a.device_sn`

/** Zones, flights, alerts and aircraft colours: what the map features keep in the database. */
export class FleetStore {
  constructor(private readonly db: Db) {}

  /* ------------------------------------------------------------------ zones */

  /**
   * Every zone, or with `ownerIds` the ones a customer may see: the built-in advisory zones
   * and the custom zones drawn by those accounts. Another customer's zones, and the Developer's
   * own, are not theirs to read or change.
   */
  async listZones(ownerIds?: string[]): Promise<Zone[]> {
    const rows = ownerIds
      ? await this.db.query<ZoneRow>(
          `SELECT * FROM zones
           WHERE deleted_at IS NULL AND (source = 'builtin' OR created_by = ANY($1::text[]))
           ORDER BY kind, name`,
          [ownerIds],
        )
      : await this.db.query<ZoneRow>(
          `SELECT * FROM zones WHERE deleted_at IS NULL ORDER BY kind, name`,
        )
    return rows.map(toZone)
  }

  /** Ids of every zone, deleted ones too, that these accounts may see: built-in or their own. */
  async zoneIdsFor(ownerIds: string[]): Promise<Set<string>> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM zones WHERE source = 'builtin' OR created_by = ANY($1::text[])`,
      [ownerIds],
    )
    return new Set(rows.map((row) => row.id))
  }

  /** A custom zone drawn by one of these accounts. Built-in zones never are. */
  async zoneDrawnBy(id: string, ownerIds: string[]): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT 1 FROM zones
       WHERE id = $1 AND deleted_at IS NULL AND source <> 'builtin' AND created_by = ANY($2::text[])`,
      [id, ownerIds],
    )
    return rows.length > 0
  }

  async getZone(id: string): Promise<Zone | null> {
    const rows = await this.db.query<ZoneRow>(
      `SELECT * FROM zones WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    )
    return rows[0] ? toZone(rows[0]) : null
  }

  async createZone(input: ZoneInput, userId: string | null): Promise<Zone> {
    const id = randomUUID()
    await this.db.query(
      `INSERT INTO zones (id, kind, name, category, shape, buffer_m, enabled, device_sns, notes,
         source, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, 'custom', $10)`,
      [
        id,
        input.kind,
        input.name,
        input.category,
        JSON.stringify(input.shape),
        input.kind === 'no_fly' ? input.bufferM : 0,
        input.enabled,
        JSON.stringify(input.kind === 'geofence' ? input.deviceSns : []),
        input.notes,
        userId,
      ],
    )
    return (await this.getZone(id))!
  }

  async updateZone(id: string, input: ZoneInput): Promise<Zone | null> {
    const rows = await this.db.query(
      `UPDATE zones SET kind = $2, name = $3, category = $4, shape = $5::jsonb, buffer_m = $6,
         enabled = $7, device_sns = $8::jsonb, notes = $9, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [
        id,
        input.kind,
        input.name,
        input.category,
        JSON.stringify(input.shape),
        input.kind === 'no_fly' ? input.bufferM : 0,
        input.enabled,
        JSON.stringify(input.kind === 'geofence' ? input.deviceSns : []),
        input.notes,
      ],
    )
    return rows.length > 0 ? this.getZone(id) : null
  }

  async deleteZone(id: string): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE zones SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [id],
    )
    return rows.length > 0
  }

  /**
   * Insert the built-in zones that are not in the table yet. A built-in zone that an
   * administrator deleted is still there with `deleted_at` set, so it is not added back.
   */
  async seedBuiltinZones(
    zones: {
      id: string
      name: string
      category: ZoneCategory
      shape: ZoneShape
      bufferM: number
      notes: string
    }[],
  ): Promise<number> {
    let added = 0
    for (const zone of zones) {
      const rows = await this.db.query(
        `INSERT INTO zones (id, kind, name, category, shape, buffer_m, enabled, device_sns, notes,
           source)
         VALUES ($1, 'no_fly', $2, $3, $4::jsonb, $5, TRUE, '[]'::jsonb, $6, 'builtin')
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [zone.id, zone.name, zone.category, JSON.stringify(zone.shape), zone.bufferM, zone.notes],
      )
      added += rows.length
    }
    return added
  }

  /* ---------------------------------------------------------------- devices */

  /** Name, nickname and colour of an aircraft; null when the aircraft does not exist. */
  async deviceProfile(sn: string): Promise<DeviceProfile | null> {
    const rows = await this.db.query<{
      display_name: string | null
      label: string | null
      color: string | null
    }>(`SELECT display_name, label, color FROM devices WHERE sn = $1 AND deleted_at IS NULL`, [sn])
    const row = rows[0]
    if (!row) return null
    return {
      sn,
      displayName: row.display_name,
      label: row.label,
      color: row.color ?? DRONE_COLORS[0],
    }
  }

  async setDeviceColor(sn: string, color: string): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE devices SET color = $2 WHERE sn = $1 AND deleted_at IS NULL RETURNING sn`,
      [sn, color.toLowerCase()],
    )
    return rows.length > 0
  }

  /**
   * Give every aircraft without a colour the first palette colour nobody else uses (cycling
   * once they run out), in a stable order so a restart changes nothing.
   */
  async assignMissingColors(): Promise<number> {
    const rows = await this.db.query<{ sn: string; color: string | null }>(
      `SELECT sn, color FROM devices WHERE deleted_at IS NULL ORDER BY sn`,
    )
    const used = new Set(rows.map((row) => row.color).filter((color): color is string => !!color))
    let assigned = 0
    for (const row of rows) {
      if (row.color) continue
      const free = DRONE_COLORS.find((color) => !used.has(color))
      const color = free ?? DRONE_COLORS[(used.size + assigned) % DRONE_COLORS.length]!
      await this.db.query(`UPDATE devices SET color = $2 WHERE sn = $1 AND color IS NULL`, [
        row.sn,
        color,
      ])
      used.add(color)
      assigned += 1
    }
    return assigned
  }

  /** The sign-in account behind the controller an aircraft is bound to, when there is one. */
  async operatorFor(sn: string): Promise<{ email: string | null; controllerSn: string | null }> {
    const rows = await this.db.query<{ email: string | null; controller_sn: string | null }>(
      `SELECT u.email, d.gateway_sn AS controller_sn
       FROM devices d
       LEFT JOIN controller_enrollments e ON e.controller_sn = d.gateway_sn
       LEFT JOIN users u ON u.id = e.user_id
       WHERE d.sn = $1`,
      [sn],
    )
    return { email: rows[0]?.email ?? null, controllerSn: rows[0]?.controller_sn ?? null }
  }

  /** The time of the newest telemetry sample at or after `since`, or null when there is none. */
  async lastSampleAt(sn: string, since: Date): Promise<Date | null> {
    const rows = await this.db.query<{ ts: Date | string | null }>(
      `SELECT max(ts) AS ts FROM telemetry_samples WHERE device_sn = $1 AND ts >= $2`,
      [sn, since],
    )
    return rows[0]?.ts ? new Date(rows[0].ts) : null
  }

  /* ---------------------------------------------------------------- flights */

  async createFlight(input: {
    id: string
    deviceSn: string
    operatorEmail: string | null
    controllerSn: string | null
    startedAt: Date
    startLat: number | null
    startLon: number | null
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO flights (id, device_sn, operator_email, controller_sn, status,
         started_at, start_lat, start_lon)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)`,
      [
        input.id,
        input.deviceSn,
        input.operatorEmail,
        input.controllerSn,
        input.startedAt,
        input.startLat,
        input.startLon,
      ],
    )
  }

  async finishFlight(id: string, endedAt: Date, stats: TrackStats): Promise<void> {
    await this.db.query(
      `UPDATE flights SET status = 'completed', ended_at = $2, duration_s = $3, distance_m = $4,
         max_alt_m = $5, max_speed_ms = $6, avg_speed_ms = $7, min_battery_pct = $8,
         start_lat = COALESCE($9, start_lat), start_lon = COALESCE($10, start_lon),
         end_lat = $11, end_lon = $12, max_range_m = $13
       WHERE id = $1`,
      [
        id,
        endedAt,
        stats.durationS,
        stats.distanceM,
        stats.maxAltM,
        stats.maxSpeedMs,
        stats.avgSpeedMs,
        stats.minBatteryPct,
        stats.start?.lat ?? null,
        stats.start?.lon ?? null,
        stats.end?.lat ?? null,
        stats.end?.lon ?? null,
        stats.maxRangeM,
      ],
    )
  }

  /** A flight too short to be a real flight (a hop, a GPS blip) is removed, not kept. */
  async discardFlight(id: string): Promise<void> {
    await this.db.query(`UPDATE alerts SET flight_id = NULL WHERE flight_id = $1`, [id])
    await this.db.query(`DELETE FROM flights WHERE id = $1`, [id])
  }

  async activeFlights(): Promise<{ id: string; deviceSn: string; startedAt: Date }[]> {
    const rows = await this.db.query<{ id: string; device_sn: string; started_at: Date | string }>(
      `SELECT id, device_sn, started_at FROM flights WHERE status = 'active'`,
    )
    return rows.map((row) => ({
      id: row.id,
      deviceSn: row.device_sn,
      startedAt: new Date(row.started_at),
    }))
  }

  async listFlights(filter: FlightFilter): Promise<FlightSummary[]> {
    const where: string[] = []
    const params: unknown[] = []
    const add = (clause: string, value: unknown) => {
      params.push(value)
      where.push(clause.replace('?', `$${params.length}`))
    }
    if (filter.allowedSns) add('f.device_sn = ANY(?::text[])', filter.allowedSns)
    if (filter.deviceSn) add('f.device_sn = ?', filter.deviceSn)
    if (filter.fromIso) add('f.started_at >= ?::timestamptz', filter.fromIso)
    if (filter.toIso) add('f.started_at < ?::timestamptz', filter.toIso)
    if (filter.beforeIso) add('f.started_at < ?::timestamptz', filter.beforeIso)
    params.push(filter.limit)
    const rows = await this.db.query<FlightRow>(
      `${FLIGHT_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY f.started_at DESC, f.id DESC LIMIT $${params.length}`,
      params,
    )
    return rows.map(toFlight)
  }

  async getFlight(id: string): Promise<FlightSummary | null> {
    const rows = await this.db.query<FlightRow>(`${FLIGHT_SELECT} WHERE f.id = $1`, [id])
    return rows[0] ? toFlight(rows[0]) : null
  }

  /** Telemetry between two instants, oldest first, for drawing and summarising a flight. */
  async flightSamples(
    sn: string,
    from: Date,
    to: Date,
    limit = 20_000,
  ): Promise<
    {
      ts: Date | string
      lat: number | null
      lon: number | null
      alt_rel: number | null
      speed_h: number | null
      heading: number | null
      battery_pct: number | null
    }[]
  > {
    return this.db.query(
      `SELECT ts, lat, lon, alt_rel, speed_h, heading, battery_pct
       FROM telemetry_samples
       WHERE device_sn = $1 AND ts >= $2 AND ts <= $3
       ORDER BY ts ASC LIMIT $4`,
      [sn, from, to, limit],
    )
  }

  /* ----------------------------------------------------------------- alerts */

  async createAlert(input: {
    kind: AlertKind
    severity: 'warning' | 'critical'
    deviceSn: string
    zoneId: string | null
    zoneName: string | null
    flightId: string | null
    lat: number | null
    lon: number | null
    altRel: number | null
    distanceM: number | null
    message: string
  }): Promise<AlertRecord> {
    const id = randomUUID()
    await this.db.query(
      `INSERT INTO alerts (id, kind, severity, device_sn, zone_id, zone_name, flight_id, lat, lon,
         alt_rel, distance_m, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        input.kind,
        input.severity,
        input.deviceSn,
        input.zoneId,
        input.zoneName,
        input.flightId,
        input.lat,
        input.lon,
        input.altRel,
        input.distanceM,
        input.message,
      ],
    )
    return (await this.getAlert(id))!
  }

  async getAlert(id: string): Promise<AlertRecord | null> {
    const rows = await this.db.query<AlertRow>(`${ALERT_SELECT} WHERE a.id = $1`, [id])
    return rows[0] ? toAlert(rows[0]) : null
  }

  /** Mark the alert as no longer applying. Returns the updated record, or null if unchanged. */
  async clearAlert(id: string): Promise<AlertRecord | null> {
    const rows = await this.db.query(
      `UPDATE alerts SET cleared_at = now() WHERE id = $1 AND cleared_at IS NULL RETURNING id`,
      [id],
    )
    return rows.length > 0 ? this.getAlert(id) : null
  }

  async acknowledgeAlert(id: string, userId: string): Promise<AlertRecord | null> {
    const rows = await this.db.query(
      `UPDATE alerts SET acknowledged_at = COALESCE(acknowledged_at, now()),
         acknowledged_by = COALESCE(acknowledged_by, $2)
       WHERE id = $1 RETURNING id`,
      [id, userId],
    )
    return rows.length > 0 ? this.getAlert(id) : null
  }

  async listAlerts(filter: AlertFilter): Promise<AlertRecord[]> {
    const where: string[] = []
    const params: unknown[] = []
    const add = (clause: string, value: unknown) => {
      params.push(value)
      where.push(clause.replace('?', `$${params.length}`))
    }
    if (filter.allowedSns) add('a.device_sn = ANY(?::text[])', filter.allowedSns)
    if (filter.deviceSn) add('a.device_sn = ?', filter.deviceSn)
    if (filter.flightId) add('a.flight_id = ?', filter.flightId)
    if (filter.beforeIso) add('a.raised_at < ?::timestamptz', filter.beforeIso)
    if (filter.activeOnly) where.push('a.cleared_at IS NULL')
    params.push(filter.limit)
    const rows = await this.db.query<AlertRow>(
      `${ALERT_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.raised_at DESC, a.id DESC LIMIT $${params.length}`,
      params,
    )
    return rows.map(toAlert)
  }

  /** Alerts still open when the process stopped have no one left to clear them. */
  async clearAllOpenAlerts(): Promise<void> {
    await this.db.query(`UPDATE alerts SET cleared_at = now() WHERE cleared_at IS NULL`)
  }
}
