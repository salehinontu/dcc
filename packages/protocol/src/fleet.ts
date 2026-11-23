import { z } from 'zod'
import { validateShape, type ZoneShape } from './geo'

/* ------------------------------------------------------------------ zones */

/** A no-fly zone warns and alerts near and inside it; a geofence alerts when leaving it. */
export const ZONE_KINDS = ['no_fly', 'geofence'] as const
export type ZoneKind = (typeof ZONE_KINDS)[number]

export const ZONE_CATEGORIES = [
  'airport',
  'military',
  'government',
  'critical',
  'border',
  'custom',
] as const
export type ZoneCategory = (typeof ZONE_CATEGORIES)[number]

/** The warning distance suggested for a new zone of each category, in metres. */
export const DEFAULT_BUFFER_M: Record<ZoneCategory, number> = {
  airport: 3000,
  military: 600,
  government: 500,
  critical: 2000,
  border: 500,
  custom: 300,
}

export const MAX_BUFFER_M = 50_000

export interface Zone {
  id: string
  kind: ZoneKind
  name: string
  category: ZoneCategory
  shape: ZoneShape
  /**
   * No-fly zones: how far outside the edge an aircraft is warned that it is approaching.
   * Geofences: unused (0).
   */
  bufferM: number
  enabled: boolean
  /** Geofences: the aircraft the fence applies to. Empty means every aircraft. */
  deviceSns: string[]
  notes: string
  /** `builtin` zones were seeded with the app; they are edited like any other. */
  source: 'builtin' | 'custom'
  createdAt: string
  updatedAt: string
}

const lngLat = z.tuple([z.number().finite(), z.number().finite()])

export const zoneShapeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('circle'), center: lngLat, radiusM: z.number().finite() }),
  z.object({ type: z.literal('polygon'), ring: z.array(lngLat).min(3).max(500) }),
])

export const zoneInputSchema = z
  .object({
    kind: z.enum(ZONE_KINDS),
    name: z.string().trim().min(1).max(80),
    category: z.enum(ZONE_CATEGORIES).default('custom'),
    shape: zoneShapeSchema,
    bufferM: z.number().finite().min(0).max(MAX_BUFFER_M).default(0),
    enabled: z.boolean().default(true),
    deviceSns: z.array(z.string().min(1).max(64)).max(200).default([]),
    notes: z.string().trim().max(500).default(''),
  })
  .superRefine((zone, ctx) => {
    const problem = validateShape(zone.shape)
    if (problem) ctx.addIssue({ code: 'custom', path: ['shape'], message: problem })
  })

export type ZoneInput = z.infer<typeof zoneInputSchema>

/* ------------------------------------------------------------------ alerts */

export const ALERT_KINDS = [
  'no_fly_warning',
  'no_fly_breach',
  'geofence_exit',
  'link_lost',
  'battery_low',
  'battery_critical',
] as const
export type AlertKind = (typeof ALERT_KINDS)[number]

/** The alerts that are about a zone; the rest (link lost, battery) are about the aircraft itself. */
export const ZONE_ALERT_KINDS: readonly AlertKind[] = [
  'no_fly_warning',
  'no_fly_breach',
  'geofence_exit',
]
export const isZoneAlert = (kind: AlertKind): boolean => ZONE_ALERT_KINDS.includes(kind)

export interface AlertRecord {
  id: string
  kind: AlertKind
  severity: 'warning' | 'critical'
  deviceSn: string
  deviceLabel: string | null
  /** null for an alert about the aircraft itself (link lost, battery). */
  zoneId: string | null
  zoneName: string | null
  flightId: string | null
  /** Where the aircraft was when the alert was raised (for link lost: the last position heard). */
  lat: number | null
  lon: number | null
  altRel: number | null
  /** Metres to the zone edge when the alert was raised; negative means inside a no-fly zone. null for a non-zone alert. */
  distanceM: number | null
  message: string
  raisedAt: string
  /** Set when the aircraft is no longer in that state (left the warning area, came back in). */
  clearedAt: string | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
}

/* ---------------------------------------------------------------- aircraft */

/** Colours offered for an aircraft. Reds are left out on purpose: red means a no-fly zone. */
export const DRONE_COLORS = [
  '#2563eb',
  '#16a34a',
  '#9333ea',
  '#0891b2',
  '#c026d3',
  '#d97706',
  '#4f46e5',
  '#65a30d',
  '#0d9488',
  '#475569',
] as const

export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)

/** A video-only drone's name when it is added; the server makes the serial and the key. */
export const videoSourceCreateSchema = z.object({ name: z.string().trim().min(1).max(40) })

/** What a pilot types into DJI Fly. `url` is the two joined, for the Address box alone. */
export interface VideoSourceInfo {
  sn: string
  name: string
  /** `rtmp://host/live/`: the RTMP Address box. */
  address: string
  /** The secret that names the stream: the Stream Key box. */
  key: string
  url: string
}

/** Longest nickname an aircraft may carry; the map pill and the rail truncate beyond this. */
export const DEVICE_LABEL_MAX = 30

export const deviceProfileSchema = z
  .object({
    displayName: z.string().max(40).nullable().optional(),
    label: z.string().max(DEVICE_LABEL_MAX).nullable().optional(),
    color: hexColorSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to change' })

/* ----------------------------------------------------------------- flights */

export interface FlightSummary {
  id: string
  deviceSn: string
  deviceLabel: string | null
  deviceColor: string | null
  /** The controller's sign-in account, when known. */
  operatorEmail: string | null
  controllerSn: string | null
  startedAt: string
  endedAt: string | null
  status: 'active' | 'completed'
  durationS: number
  distanceM: number
  maxAltM: number | null
  maxSpeedMs: number | null
  avgSpeedMs: number | null
  minBatteryPct: number | null
  startLat: number | null
  startLon: number | null
  endLat: number | null
  endLon: number | null
  /** The furthest the aircraft got from where it took off. */
  maxRangeM: number
  alertCount: number
}

export interface FlightPoint {
  ts: number
  lat: number
  lon: number
  alt: number | null
  speed: number | null
  heading: number | null
  battery: number | null
}

export interface FlightDetail {
  flight: FlightSummary
  /** The path, thinned to at most a couple of thousand points. */
  points: FlightPoint[]
  alerts: AlertRecord[]
}

/** The numbers worked out from a recorded path. */
export interface TrackStats {
  durationS: number
  distanceM: number
  maxAltM: number | null
  maxSpeedMs: number | null
  avgSpeedMs: number | null
  minBatteryPct: number | null
  maxRangeM: number
  start: { lat: number; lon: number } | null
  end: { lat: number; lon: number } | null
}
