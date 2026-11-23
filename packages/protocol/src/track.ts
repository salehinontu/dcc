import { haversineM } from './geo'
import type { TrackStats } from './fleet'

/** One recorded sample of a flight; fields the aircraft did not report are null. */
export interface TrackSample {
  ts: number
  lat: number | null
  lon: number | null
  altRel: number | null
  speedH: number | null
  batteryPct: number | null
}

/**
 * Distance, height, speed and range of a recorded path. Samples with no position still count
 * towards duration, height and battery, but not towards distance or range. The distance of a
 * jump larger than `maxJumpM` between two samples is ignored: it is a GPS glitch or a gap in
 * the recording, not flying.
 */
export function summarizeTrack(samples: TrackSample[], maxJumpM = 2000): TrackStats {
  const ordered = [...samples].sort((a, b) => a.ts - b.ts)
  let distanceM = 0
  let maxAltM: number | null = null
  let maxSpeedMs: number | null = null
  let minBatteryPct: number | null = null
  let speedSum = 0
  let speedCount = 0
  let start: { lat: number; lon: number } | null = null
  let end: { lat: number; lon: number } | null = null
  let maxRangeM = 0
  let previous: [number, number] | null = null

  for (const sample of ordered) {
    if (sample.altRel != null)
      maxAltM = maxAltM == null ? sample.altRel : Math.max(maxAltM, sample.altRel)
    if (sample.speedH != null) {
      maxSpeedMs = maxSpeedMs == null ? sample.speedH : Math.max(maxSpeedMs, sample.speedH)
      speedSum += sample.speedH
      speedCount += 1
    }
    if (sample.batteryPct != null)
      minBatteryPct =
        minBatteryPct == null ? sample.batteryPct : Math.min(minBatteryPct, sample.batteryPct)

    if (sample.lat == null || sample.lon == null) continue
    const here: [number, number] = [sample.lon, sample.lat]
    if (!start) start = { lat: sample.lat, lon: sample.lon }
    end = { lat: sample.lat, lon: sample.lon }
    if (previous) {
      const step = haversineM(previous, here)
      if (step <= maxJumpM) distanceM += step
    }
    maxRangeM = Math.max(maxRangeM, haversineM([start.lon, start.lat], here))
    previous = here
  }

  const first = ordered[0]?.ts
  const last = ordered[ordered.length - 1]?.ts
  return {
    durationS: first != null && last != null ? Math.max(0, Math.round((last - first) / 1000)) : 0,
    distanceM: Math.round(distanceM),
    maxAltM,
    maxSpeedMs,
    avgSpeedMs: speedCount > 0 ? speedSum / speedCount : null,
    minBatteryPct,
    maxRangeM: Math.round(maxRangeM),
    start,
    end,
  }
}

/** Keep at most `limit` points, always including the first and the last. */
export function thin<T>(items: T[], limit: number): T[] {
  if (items.length <= limit || limit < 2) return items
  const out: T[] = []
  const step = (items.length - 1) / (limit - 1)
  for (let i = 0; i < limit; i += 1) out.push(items[Math.round(i * step)]!)
  return out
}
