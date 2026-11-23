import { channels, type AlertKind, type AlertRecord, type TelemetrySample } from '@dji/protocol'
import { LANDED_ALT_M } from '../flights/tracker'
import type { Hub } from '../hub'
import type { Store } from '../store'

/** The thresholds the monitor judges by (see `config.alerts`). 0 switches a battery rule off. */
export interface AlertRules {
  /** Alert when an aircraft that is flying stops reporting or drops off its controller. */
  linkLost: boolean
  batteryLowPct: number
  batteryCriticalPct: number
  /** The aircraft's own flight-time-left estimate, in seconds, at or below which the battery is critical. */
  remainCriticalSeconds: number
}

export type BatteryLevel = 'ok' | 'low' | 'critical'

const RANK: Record<BatteryLevel, number> = { ok: 0, low: 1, critical: 2 }

/**
 * How low the battery is. Within one flight it only ever gets worse: a battery does not recharge in the
 * air, so a reading that bounces back (a calibration jump, a noisy sample) must not clear the alert and
 * raise it again a second later.
 */
export function batteryLevel(
  sample: Pick<TelemetrySample, 'batteryPct' | 'remainFlightS'>,
  previous: BatteryLevel,
  rules: Pick<AlertRules, 'batteryLowPct' | 'batteryCriticalPct' | 'remainCriticalSeconds'>,
): BatteryLevel {
  const pct = sample.batteryPct
  const remain = sample.remainFlightS
  let level: BatteryLevel = 'ok'
  if (pct != null && rules.batteryLowPct > 0 && pct <= rules.batteryLowPct) level = 'low'
  if (
    (pct != null && rules.batteryCriticalPct > 0 && pct <= rules.batteryCriticalPct) ||
    (remain != null && rules.remainCriticalSeconds > 0 && remain <= rules.remainCriticalSeconds)
  )
    level = 'critical'
  return RANK[level] > RANK[previous] ? level : previous
}

/** A last sample older than this says nothing about where the aircraft is now. */
const LAST_SEEN_MAX_MS = 5 * 60_000

interface LastSeen {
  sample: TelemetrySample
  at: number
}

interface BatteryState {
  level: BatteryLevel
  alertId: string | null
}

const duration = (seconds: number) =>
  seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`

/**
 * Alerts about the aircraft itself, next to the zone alerts of `GeoEngine`:
 *
 *  - **Link lost**: an aircraft that was in the air stops reporting (its controller says it is gone, or
 *    45 s pass with no data). The alert keeps the last position heard and stays open until the aircraft
 *    reports again, so it is still there when somebody looks. An aircraft that was on the ground (the
 *    normal power-off after landing) never raises it.
 *  - **Low battery** (warning) and **critical battery** (critical): at the configured percentages, and
 *    critical too when the aircraft's own flight-time-left estimate runs short. It ends with the flight.
 *
 * Like the zone alerts, it judges only aircraft that are flying: a drone parked on a charger at 10 %
 * is not an emergency.
 */
export class AlertMonitor {
  private readonly last = new Map<string, LastSeen>()
  private readonly battery = new Map<string, BatteryState>()
  /** Open link-lost alert per aircraft. */
  private readonly linkAlerts = new Map<string, string>()
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly flightId: (sn: string) => string | null,
    private readonly rules: AlertRules,
    private readonly now: () => number = Date.now,
  ) {}

  /** Judge one telemetry sample. `airborne` says whether the aircraft is in a flight. */
  onSample(sample: TelemetrySample, airborne: boolean): Promise<void> {
    return this.serial(sample.sn, async () => {
      const sn = sample.sn
      // Back in contact: whatever was open for the lost link is over.
      const open = this.linkAlerts.get(sn)
      if (open) {
        this.linkAlerts.delete(sn)
        await this.clear(open)
      }

      const inAir = airborne && (sample.altRel ?? 0) >= LANDED_ALT_M
      if (inAir) this.last.set(sn, { sample, at: this.now() })
      else this.last.delete(sn)
      if (airborne) await this.checkBattery(sample)
    })
  }

  /**
   * The aircraft went away: its controller reported it gone (`disconnected`) or it stopped sending
   * (`silent`). Raises the alert only if it was in the air a moment ago. Pass the flight id from
   * before the flight tracker closes the flight.
   */
  onOffline(sn: string, reason: 'disconnected' | 'silent', flightId: string | null): Promise<void> {
    if (!this.rules.linkLost) return Promise.resolve()
    return this.serial(sn, async () => {
      // Two paths can report the same loss; the first one raises it.
      if (this.linkAlerts.has(sn)) return
      const last = this.last.get(sn)
      this.last.delete(sn)
      if (!last || this.now() - last.at > LAST_SEEN_MAX_MS) return

      const { sample } = last
      const label = (await this.store.deviceLabel(sn)) ?? sn
      const seen = [
        sample.altRel != null ? `last seen ${Math.round(sample.altRel)} m above take-off` : null,
        sample.batteryPct != null ? `battery ${Math.round(sample.batteryPct)} %` : null,
      ].filter(Boolean)
      const detail = seen.length > 0 ? ` (${seen.join(', ')})` : ''
      const message =
        reason === 'disconnected'
          ? `${label} lost contact while flying: it dropped off its controller${detail}.`
          : `${label} lost contact while flying: no data for ${duration((this.now() - last.at) / 1000)}${detail}.`
      const alert = await this.store.fleet.createAlert({
        kind: 'link_lost',
        severity: 'critical',
        deviceSn: sn,
        zoneId: null,
        zoneName: null,
        flightId: flightId ?? this.flightId(sn),
        lat: sample.lat,
        lon: sample.lon,
        altRel: sample.altRel,
        distanceM: null,
        message,
      })
      this.linkAlerts.set(sn, alert.id)
      this.publish(alert)
    })
  }

  /** The flight is over (landed, or dropped off): the battery warnings of that flight are over too. */
  onFlightEnd(sn: string): Promise<void> {
    return this.serial(sn, async () => {
      const state = this.battery.get(sn)
      this.battery.delete(sn)
      if (state?.alertId) await this.clear(state.alertId)
    })
  }

  private async checkBattery(sample: TelemetrySample): Promise<void> {
    const sn = sample.sn
    const state = this.battery.get(sn) ?? { level: 'ok' as BatteryLevel, alertId: null }
    const level = batteryLevel(sample, state.level, this.rules)
    if (level === state.level) return

    // Low gives way to critical: the old warning is over, the new one carries on.
    if (state.alertId) await this.clear(state.alertId)
    const label = (await this.store.deviceLabel(sn)) ?? sn
    const facts = [
      sample.batteryPct != null ? `${Math.round(sample.batteryPct)} % left` : null,
      sample.remainFlightS != null
        ? `about ${duration(sample.remainFlightS)} of flight time`
        : null,
    ].filter(Boolean)
    const kind: AlertKind = level === 'critical' ? 'battery_critical' : 'battery_low'
    const message =
      level === 'critical'
        ? `${label} battery is critical: ${facts.join(', ')}.`
        : `${label} battery is low: ${facts.join(', ')}.`
    const alert = await this.store.fleet.createAlert({
      kind,
      severity: level === 'critical' ? 'critical' : 'warning',
      deviceSn: sn,
      zoneId: null,
      zoneName: null,
      flightId: this.flightId(sn),
      lat: sample.lat,
      lon: sample.lon,
      altRel: sample.altRel,
      distanceM: null,
      message,
    })
    this.battery.set(sn, { level, alertId: alert.id })
    this.publish(alert)
  }

  private serial(sn: string, work: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(sn) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.chains.set(sn, next)
    void next
      .finally(() => {
        if (this.chains.get(sn) === next) this.chains.delete(sn)
      })
      .catch(() => undefined)
    return next
  }

  private async clear(alertId: string): Promise<void> {
    const alert = await this.store.fleet.clearAlert(alertId).catch(() => null)
    if (alert) this.publish(alert)
  }

  private publish(alert: AlertRecord): void {
    this.hub.publish([channels.devices, channels.device(alert.deviceSn)], {
      type: 'alert',
      data: alert,
    })
  }
}
