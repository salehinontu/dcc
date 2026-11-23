import { z } from 'zod'

/**
 * OSD is model-specific in its detail, but the fields below are common to the Pilot 2
 * thing model. Unknown fields are preserved in `raw` so nothing is lost before the
 * model-specific mapper is confirmed on hardware.
 */
export const osdSchema = z
  .object({
    latitude: z.number().finite().optional(),
    longitude: z.number().finite().optional(),
    height: z.number().finite().optional(),
    elevation: z.number().finite().optional(),
    horizontal_speed: z.number().finite().optional(),
    vertical_speed: z.number().finite().optional(),
    attitude_head: z.number().finite().optional(),
    attitude_pitch: z.number().finite().optional(),
    attitude_roll: z.number().finite().optional(),
    battery: z
      .object({
        capacity_percent: z.number().finite().optional(),
        remain_flight_time: z.number().finite().optional(),
      })
      .catchall(z.unknown())
      .optional(),
    mode_code: z.number().int().optional(),
    gps_number: z.number().int().optional(),
    rtk_number: z.number().int().optional(),
    position_state: z
      .object({
        is_fixed: z.number().int().optional(),
        quality: z.number().int().optional(),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown())

export type OsdData = z.infer<typeof osdSchema>

export interface TelemetrySample {
  sn: string
  ts: number
  lat: number | null
  lon: number | null
  altRel: number | null
  altAbs: number | null
  heading: number | null
  speedH: number | null
  speedV: number | null
  batteryPct: number | null
  /**
   * Flight time left in seconds, as the aircraft itself estimates it (`battery.remain_flight_time`).
   * null while it is unknown: DJI reports 0 on the ground, so 0 means "not flying", not "no time left".
   */
  remainFlightS: number | null
  mode: number | null
  gnss: number | null
  rtk: number | null
  raw: Record<string, unknown>
}

/** A day is far beyond any battery; anything outside 1 s to 24 h is a bad reading, not a forecast. */
export const REMAIN_FLIGHT_MAX_S = 86_400

export function remainFlightSeconds(value: unknown): number | null {
  const seconds = num(value)
  return seconds != null && seconds >= 1 && seconds <= REMAIN_FLIGHT_MAX_S
    ? Math.round(seconds)
    : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * DJI publishes `latitude`/`longitude` as 0/0 while the aircraft has no position fix. That
 * is a sentinel, not a location: storing it puts the aircraft in the Gulf of Guinea and
 * makes the dashboard fit its map to null island. Out-of-range values are equally unusable.
 * The untouched payload stays in `raw`, so nothing is lost for the model-specific mapper.
 */
function positionFix(data: Record<string, unknown>): { lat: number | null; lon: number | null } {
  const lat = num(data.latitude)
  const lon = num(data.longitude)
  if (lat == null || lon == null) return { lat: null, lon: null }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { lat: null, lon: null }
  if (lat === 0 && lon === 0) return { lat: null, lon: null }
  return { lat, lon }
}

/**
 * Canonical sample. Model-specific differences are handled here; the raw payload is kept
 * alongside so the mapper can be corrected from real captures without re-collecting data.
 */
export function toTelemetrySample(
  sn: string,
  data: Record<string, unknown>,
  ts: number,
): TelemetrySample {
  const battery = asRecord(data.battery)
  const position = asRecord(data.position_state)
  const fix = positionFix(data)

  return {
    sn,
    ts,
    lat: fix.lat,
    lon: fix.lon,
    // Checked against three days of real Matrice captures (2026-10-28..30): `elevation` sits at
    // 0 while the aircraft stands on the ground, which is the height above the take-off point,
    // and `height` is an ellipsoid height that wandered from -60 m to +27 m without moving, as in
    // DJI's own sample (`height` 38.4, `elevation` 0, standby). `altRel` drives flight and
    // zone logic, so it must be the one that reads 0 on the ground. No fallback to `height`:
    // a wrong altitude is worse than none.
    altRel: num(data.elevation),
    altAbs: num(data.height),
    heading: num(data.attitude_head),
    speedH: num(data.horizontal_speed),
    speedV: num(data.vertical_speed),
    batteryPct: num(battery.capacity_percent) ?? num(data.capacity_percent),
    // Present in every sample of the real Matrice captures (2026-10-28..30), in seconds, around
    // 960 s at 43 % in the air and 0 once landed. The aircraft computes it, so we do not estimate.
    remainFlightS: remainFlightSeconds(battery.remain_flight_time),
    mode: num(data.mode_code),
    gnss: num(data.gps_number),
    rtk: num(position.is_fixed),
    raw: data,
  }
}

export const MODE_NAMES: Record<number, string> = {
  0: 'Standby',
  1: 'Takeoff',
  2: 'Auto takeoff',
  3: 'Auto landing',
  4: 'Manual',
  5: 'Auto flight',
  6: 'Return home',
  7: 'Landing',
  8: 'Hover',
  9: 'Wayline',
}
