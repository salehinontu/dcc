export function durationLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`
  if (m > 0) return `${m} min ${String(s).padStart(2, '0')} s`
  return `${s} s`
}

export function distanceLabel(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`
}

export function altitudeLabel(metres: number | null | undefined): string {
  return metres == null ? '—' : `${Math.round(metres * 10) / 10} m`
}

export function speedLabel(ms: number | null | undefined): string {
  return ms == null ? '—' : `${(ms * 3.6).toFixed(1)} km/h`
}

export function batteryLabel(pct: number | null | undefined): string {
  return pct == null ? '—' : `${Math.round(pct)}%`
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/** A heading in degrees as `NE 47°`. */
export function headingLabel(degrees: number | null | undefined): string {
  if (degrees == null || !Number.isFinite(degrees)) return '—'
  const normal = ((degrees % 360) + 360) % 360
  return `${COMPASS[Math.round(normal / 45) % 8]} ${Math.round(normal)}°`
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})
const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export const formatDateTime = (iso: string | number): string => dateTime.format(new Date(iso))
export const formatClock = (iso: string | number): string => clock.format(new Date(iso))

/** A file size the way an operator reads it: 740 KB, 12.4 MB, 1.8 GB. */
export function sizeLabel(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** A length the way a player shows it: 0:08, 12:40, 1:02:09. */
export function clockLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}
