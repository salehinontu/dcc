import type { DeviceSummary, StreamState } from '@dji/protocol'

const QUALITY_LABELS = ['Auto', 'Smooth', 'SD', 'HD', 'UHD'] as const

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function qualityLabel(quality: number | null | undefined): string {
  return QUALITY_LABELS[quality ?? 0] ?? 'Auto'
}

export function serialTail(sn: string): string {
  return sn.slice(-6)
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return '—'

  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`

  return `${Math.floor(hours / 24)} d ago`
}

interface MaybePosition {
  lat?: number | null
  lon?: number | null
}

/**
 * DJI reports 0/0 while the aircraft has no position fix, and stored history may still
 * hold such samples. Treat that pair, and out-of-range values, as "no position" so the
 * map never draws a marker or fits its bounds to null island.
 */
export function hasPosition<T extends MaybePosition>(
  sample: T | null | undefined,
): sample is T & { lat: number; lon: number } {
  const lat = sample?.lat
  const lon = sample?.lon
  if (lat == null || lon == null) return false
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false
  return lat !== 0 || lon !== 0
}

/** How long a drone that dropped off the link in the air keeps its last position on the map. */
const LOST_LINK_MS = 30 * 60_000

/**
 * The map shows drones that are connected. A drone that is off keeps no marker, or an old test
 * location would sit on the map for good, selected or not (the dashboard selects the first drone
 * by itself); the exception is one whose link dropped while it was in the air, because its last
 * fix is where to look.
 */
export function droneOnMap(device: DeviceSummary, now = Date.now()): boolean {
  if (device.online) return true
  const last = device.telemetry
  return last != null && (last.altRel ?? 0) >= 2 && now - last.ts < LOST_LINK_MS
}

export function formatCoord(
  lat: number | null | undefined,
  lon: number | null | undefined,
): string {
  const point = { lat, lon }
  if (!hasPosition(point)) return 'No position reported'

  const north = point.lat >= 0 ? 'N' : 'S'
  const east = point.lon >= 0 ? 'E' : 'W'
  return `${Math.abs(point.lat).toFixed(4)}° ${north} / ${Math.abs(point.lon).toFixed(4)}° ${east}`
}

export function metric(value: number | null | undefined, digits = 0): string {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits)
}

export function initials(email: string): string {
  return email.slice(0, 2).toUpperCase()
}

export function roleLabel(role: string): string {
  if (role === 'admin') return 'Administrator'
  if (role === 'subadmin') return 'Sub-admin'
  return titleCase(role)
}

export function batteryIsLow(battery: number | null | undefined): boolean {
  return battery != null && battery < 50
}

/**
 * The aircraft's own flight-time-left estimate (seconds) as "16 min" or "1 h 05 min". Whole
 * minutes on purpose: the raw value wobbles by a minute or two within seconds, and seconds would
 * make it look precise. "—" when the aircraft gives none (on the ground, or a model without it).
 */
export function flightTimeLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const minutes = Math.round(seconds / 60)
  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

export interface StreamMeta {
  camera: string
  lens: string
  quality: string
}

/** Camera/lens/quality labels derived from the stream's video id and the topology. */
export function streamMeta(
  device: DeviceSummary | undefined,
  stream: StreamState | undefined,
): StreamMeta {
  if (!stream) return { camera: 'Camera', lens: 'Camera', quality: 'Auto' }
  // Nothing to choose here: the pilot sets resolution and bitrate in DJI Fly.
  if (device?.videoOnly) return { camera: 'RTMP', lens: 'Video only', quality: 'DJI Fly' }

  const [, cameraIndex = '1', videoIndex = ''] = stream.videoId.split('/')
  const cameraPosition =
    device?.cameras.findIndex((entry) => entry.cameraIndex === cameraIndex) ?? -1
  const camera = device?.cameras[cameraPosition]
  const video = camera?.videos.find((entry) => entry.videoIndex === videoIndex)
  const lens = video?.videoType ? titleCase(video.videoType) : 'Camera'

  return {
    camera: cameraPosition >= 0 ? `Camera ${cameraPosition + 1}` : 'Camera',
    lens,
    quality: qualityLabel(stream.quality),
  }
}
