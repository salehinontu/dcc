import {
  channels,
  nearBounds,
  signedDistanceM,
  type AlertKind,
  type AlertRecord,
  type LngLat,
  type TelemetrySample,
  type Zone,
} from '@dji/protocol'
import type { Hub } from '../hub'
import type { Store } from '../store'

/** Metres an aircraft must move past a boundary before the alert state flips back. */
export const HYSTERESIS_M = 10

type Phase = 'clear' | 'warning' | 'breach' | 'inside' | 'outside'

interface Tracked {
  phase: Phase
  alertId: string | null
  /** The zone version this state was computed for; an edited zone starts over. */
  zoneStamp: string
}

/** What a position means for a no-fly zone, given where the aircraft was a moment ago. */
export function noFlyPhase(distanceM: number, bufferM: number, previous: Phase): Phase {
  const inside = previous === 'breach' ? distanceM <= HYSTERESIS_M : distanceM <= 0
  if (inside) return 'breach'
  const margin = Math.max(HYSTERESIS_M, bufferM * 0.05)
  const warn =
    previous === 'warning' || previous === 'breach'
      ? distanceM <= bufferM + margin
      : distanceM <= bufferM
  return warn && bufferM > 0 ? 'warning' : 'clear'
}

/** What a position means for a geofence, given where the aircraft was a moment ago. */
export function geofencePhase(distanceM: number, previous: Phase | undefined): Phase {
  if (previous === 'inside') return distanceM > HYSTERESIS_M ? 'outside' : 'inside'
  if (previous === 'outside') return distanceM < -HYSTERESIS_M ? 'inside' : 'outside'
  return distanceM > 0 ? 'outside' : 'inside'
}

const metres = (value: number) =>
  Math.abs(value) >= 1000
    ? `${(Math.abs(value) / 1000).toFixed(1)} km`
    : `${Math.round(Math.abs(value))} m`

/**
 * Watches every airborne aircraft against the zones and raises alerts: a warning when it
 * comes within a no-fly zone's warning distance, a breach when it enters, and an exit when it
 * leaves a geofence. An alert stays open until the aircraft is back to normal (or lands).
 * It judges only aircraft that are flying, so a drone parked inside an airport or outside its
 * fence does not sound the alarm until it takes off.
 */
export class GeoEngine {
  private zones: Zone[] = []
  private readonly state = new Map<string, Tracked>()
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly flightId: (sn: string) => string | null,
  ) {}

  /** Load the zones again, and drop the state of any zone that changed or went away. */
  async reload(): Promise<void> {
    const all = await this.store.fleet.listZones()
    this.zones = all.filter((zone) => zone.enabled)
    const stamps = new Map(this.zones.map((zone) => [zone.id, zone.updatedAt]))
    for (const [key, tracked] of [...this.state]) {
      const zoneId = key.slice(key.indexOf('|') + 1)
      if (stamps.get(zoneId) === tracked.zoneStamp) continue
      this.state.delete(key)
      if (tracked.alertId) await this.clear(tracked.alertId)
    }
  }

  get zoneCount(): number {
    return this.zones.length
  }

  /** Judge one telemetry sample. `airborne` says whether the aircraft is in a flight. */
  onSample(sample: TelemetrySample, airborne: boolean): Promise<void> {
    if (!airborne || sample.lat == null || sample.lon == null) return Promise.resolve()
    return this.serial(sample.sn, () => this.evaluate(sample))
  }

  /** The aircraft landed or dropped off: whatever was open for it is over. */
  onFlightEnd(sn: string): Promise<void> {
    return this.serial(sn, async () => {
      for (const [key, tracked] of [...this.state]) {
        if (!key.startsWith(`${sn}|`)) continue
        this.state.delete(key)
        if (tracked.alertId) await this.clear(tracked.alertId)
      }
    })
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

  private async evaluate(sample: TelemetrySample): Promise<void> {
    const position: LngLat = [sample.lon!, sample.lat!]
    for (const zone of this.zones) {
      if (
        zone.kind === 'geofence' &&
        zone.deviceSns.length > 0 &&
        !zone.deviceSns.includes(sample.sn)
      )
        continue
      const key = `${sample.sn}|${zone.id}`
      const tracked = this.state.get(key)

      // Far from a no-fly zone and not already near it: skip the exact distance.
      if (
        zone.kind === 'no_fly' &&
        (!tracked || tracked.phase === 'clear') &&
        !nearBounds(zone.shape, position, zone.bufferM + HYSTERESIS_M + 5)
      )
        continue

      const distance = signedDistanceM(zone.shape, position)
      const previous = tracked?.phase
      const next =
        zone.kind === 'no_fly'
          ? noFlyPhase(distance, zone.bufferM, previous ?? 'clear')
          : geofencePhase(distance, previous)

      if (next === previous) continue
      await this.transition(sample, zone, key, tracked, next, distance)
    }
  }

  private async transition(
    sample: TelemetrySample,
    zone: Zone,
    key: string,
    tracked: Tracked | undefined,
    next: Phase,
    distance: number,
  ): Promise<void> {
    if (tracked?.alertId) await this.clear(tracked.alertId)

    let alertId: string | null = null
    const raise =
      zone.kind === 'no_fly' ? next === 'warning' || next === 'breach' : next === 'outside'
    if (raise) {
      const label = (await this.store.deviceLabel(sample.sn)) ?? sample.sn
      const kind: AlertKind =
        zone.kind === 'geofence'
          ? 'geofence_exit'
          : next === 'breach'
            ? 'no_fly_breach'
            : 'no_fly_warning'
      const message =
        kind === 'geofence_exit'
          ? `${label} left the geofence "${zone.name}" (${metres(distance)} outside).`
          : kind === 'no_fly_breach'
            ? `${label} entered the no-fly zone "${zone.name}".`
            : `${label} is approaching the no-fly zone "${zone.name}" (${metres(distance)} from its edge).`
      const alert = await this.store.fleet.createAlert({
        kind,
        severity: kind === 'no_fly_warning' ? 'warning' : 'critical',
        deviceSn: sample.sn,
        zoneId: zone.id,
        zoneName: zone.name,
        flightId: this.flightId(sample.sn),
        lat: sample.lat,
        lon: sample.lon,
        altRel: sample.altRel,
        distanceM: Math.round(distance),
        message,
      })
      alertId = alert.id
      this.publish(alert)
    }

    if (next === 'clear' && zone.kind === 'no_fly') this.state.delete(key)
    else this.state.set(key, { phase: next, alertId, zoneStamp: zone.updatedAt })
  }

  private async clear(alertId: string): Promise<void> {
    const alert = await this.store.fleet.clearAlert(alertId).catch(() => null)
    if (alert) this.publish(alert)
  }

  publish(alert: AlertRecord): void {
    this.hub.publish([channels.devices, channels.device(alert.deviceSn)], {
      type: 'alert',
      data: alert,
    })
  }
}
