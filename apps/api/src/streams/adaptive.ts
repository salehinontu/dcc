import { QUALITY_BITRATE_KBPS } from '@dji/protocol'

export interface NetworkReport {
  downlinkMbps?: number
  concurrentStreams: number
  loss: number
  stalled: boolean
}

/**
 * The highest downlink, in Mbps, still read as a real limit. Browsers estimate
 * `navigator.connection.downlink` from recent HTTP transfers, not from the WebRTC media, so a
 * healthy wall routinely read 1.5–3 Mbps and was pushed down to Smooth. Only an explicit
 * low-data signal (data saver or 2G, which the client sends as 0.5) sizes the wall now.
 */
export const SLOW_LINK_MBPS = 1

/**
 * After a quality change or a publisher (re)start the controller re-encodes and the player
 * waits for a keyframe, so a stall then says nothing about the network. Reports in this window
 * are not counted; acting on them is what made the stream step down and up every minute.
 */
export const SETTLE_MS = 30_000

/** Consecutive bad reports (one every 10 s) from one viewer before the stream steps down. */
export const BAD_REPORTS_TO_DOWNGRADE = 2

/** How long every viewer must want more before the stream steps back up. */
export const RECOVER_MS = 120_000

/** Reports older than this are forgotten: the viewer left or stopped reporting. */
const REPORT_TTL_MS = 30_000

function isBad(report: NetworkReport): boolean {
  return report.stalled || report.loss >= 0.05
}

/** An explicit slow link sizes the whole wall; RTP loss and stalls lower one level. */
export function suggestedQuality(current: number, ceiling: number, report: NetworkReport): number {
  let quality = ceiling
  if (report.downlinkMbps !== undefined && report.downlinkMbps <= SLOW_LINK_MBPS) {
    const budgetKbps = (report.downlinkMbps * 1000 * 0.65) / report.concurrentStreams
    quality = 1
    for (let candidate = 1; candidate <= ceiling; candidate++) {
      if ((QUALITY_BITRATE_KBPS[candidate] ?? Infinity) <= budgetKbps) quality = candidate
    }
  }
  if (isBad(report)) quality = Math.min(quality, Math.max(1, current - 1))
  return quality
}

interface StreamState {
  ceiling: number
  /** The last quality change or publisher (re)start: it opens a settle window. */
  changedAt: number
  /** Since when every viewer has wanted more than the current quality. */
  healthySince: number
  reports: Map<string, { report: NetworkReport; at: number; streak: number }>
}

/**
 * Stream-wide minimum over expiring viewer reports. A step down needs trouble that lasts (two
 * reports in a row from one viewer, outside a settle window); a step back up needs two healthy
 * minutes. Every change makes the controller re-encode, so fewer changes means fewer freezes.
 */
export class AdaptiveQuality {
  private readonly states = new Map<string, StreamState>()

  /** An admin chose `ceiling`: never go above it, and let the change settle first. */
  reset(id: string, ceiling: number, now = Date.now()): void {
    this.states.set(id, { ceiling, changedAt: now, healthySince: now, reports: new Map() })
  }

  /** The publisher went live (again): start a settle window, keeping the admin's ceiling. */
  settle(id: string, quality: number, now = Date.now()): void {
    const state = this.states.get(id)
    if (!state) return this.reset(id, quality, now)
    state.changedAt = now
    state.healthySince = now
    state.reports.clear()
  }

  remove(id: string): void {
    this.states.delete(id)
  }

  report(
    id: string,
    viewer: string,
    current: number,
    report: NetworkReport,
    now = Date.now(),
  ): number | null {
    if (current === 0) return null // DJI owns adaptive/custom mode when explicitly selected.
    if (!this.states.has(id)) this.reset(id, current, now - SETTLE_MS)
    const state = this.states.get(id)!
    const settling = now - state.changedAt < SETTLE_MS

    const previous = state.reports.get(viewer)
    const streak =
      !settling && isBad(report)
        ? (previous && now - previous.at <= REPORT_TTL_MS ? previous.streak : 0) + 1
        : 0
    state.reports.set(viewer, { report, at: now, streak })
    if (settling) return null

    let target = state.ceiling
    for (const [key, entry] of state.reports) {
      if (now - entry.at > REPORT_TTL_MS) {
        state.reports.delete(key)
        continue
      }
      // A single bad report is a blip: count it only once the trouble has lasted.
      const counted =
        entry.streak >= BAD_REPORTS_TO_DOWNGRADE
          ? entry.report
          : { ...entry.report, stalled: false, loss: 0 }
      target = Math.min(target, suggestedQuality(current, state.ceiling, counted))
    }
    if (target <= current) state.healthySince = now
    if (target === current) return null
    if (
      target > current &&
      (now - state.healthySince < RECOVER_MS || now - state.changedAt < RECOVER_MS)
    )
      return null

    state.changedAt = now
    state.healthySince = now
    for (const entry of state.reports.values()) entry.streak = 0
    return target < current ? target : current + 1
  }
}
