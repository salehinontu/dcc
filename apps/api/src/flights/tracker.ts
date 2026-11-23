import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { summarizeTrack, type TelemetrySample } from '@dji/protocol'
import type { Store } from '../store'

/** Height above the take-off point at which an aircraft counts as flying. */
export const TAKEOFF_ALT_M = 2
/** Below this height the aircraft is back on the ground... */
export const LANDED_ALT_M = 1
/** ...once it has stayed there this long. */
export const LAND_CONFIRM_MS = 20_000
/** An aircraft that reports nothing for this long (wall-clock) is no longer flying. */
export const SILENCE_MS = 60_000
/** A flight shorter than this is a hop or a glitch and is not kept. */
export const MIN_FLIGHT_MS = 20_000

export function isAirborne(sample: Pick<TelemetrySample, 'altRel'>): boolean {
  return (sample.altRel ?? 0) >= TAKEOFF_ALT_M
}

interface Active {
  id: string
  startedAt: number
  lastAirborneAt: number
  groundSince: number | null
  lastSeenWall: number
}

export interface FlightEnded {
  sn: string
  flightId: string
  kept: boolean
}

/**
 * Turns the stream of telemetry into flights: one row from take-off to landing. The path
 * itself is the telemetry that is already stored; the row holds who flew and the summary.
 * Time inside a flight follows the aircraft's own sample times, so it lines up with the
 * stored samples; only "has it gone silent" uses the server clock.
 */
export class FlightTracker {
  readonly events = new EventEmitter()
  private readonly active = new Map<string, Active>()
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  activeFlightId(sn: string): string | null {
    return this.active.get(sn)?.id ?? null
  }

  /** Feed one telemetry sample. Resolves true while the aircraft is in a flight. */
  onSample(sample: TelemetrySample): Promise<boolean> {
    return this.serial(sample.sn, () => this.handle(sample))
  }

  /** The aircraft dropped off the link: a flight in progress is over. */
  onOffline(sn: string): Promise<void> {
    return this.serial(sn, async () => {
      const flight = this.active.get(sn)
      if (flight) await this.finish(sn, flight)
    })
  }

  /** End flights whose aircraft have gone silent; call this every few seconds. */
  async sweep(): Promise<void> {
    const now = this.now()
    for (const [sn, flight] of [...this.active]) {
      if (now - flight.lastSeenWall >= SILENCE_MS) await this.onOffline(sn)
    }
  }

  /** After a restart no flight is in progress: close the ones the old process left open. */
  async recover(): Promise<number> {
    const open = await this.store.fleet.activeFlights()
    for (const flight of open) {
      const last = await this.store.fleet.lastSampleAt(flight.deviceSn, flight.startedAt)
      await this.close(flight.id, flight.deviceSn, flight.startedAt, last ?? flight.startedAt)
    }
    return open.length
  }

  private serial<T>(sn: string, work: () => Promise<T>): Promise<T> {
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

  private async handle(sample: TelemetrySample): Promise<boolean> {
    const sn = sample.sn
    const flight = this.active.get(sn)
    const airborne = isAirborne(sample)

    if (!flight) {
      if (!airborne) return false
      await this.begin(sample)
      return true
    }

    flight.lastSeenWall = this.now()
    if (airborne) {
      flight.lastAirborneAt = sample.ts
      flight.groundSince = null
      return true
    }

    if ((sample.altRel ?? 0) < LANDED_ALT_M) {
      flight.groundSince ??= sample.ts
      if (sample.ts - flight.groundSince >= LAND_CONFIRM_MS) {
        await this.finish(sn, flight)
        return false
      }
    }
    return true
  }

  private async begin(sample: TelemetrySample): Promise<void> {
    const id = randomUUID()
    const operator = await this.store.fleet.operatorFor(sample.sn)
    await this.store.fleet.createFlight({
      id,
      deviceSn: sample.sn,
      operatorEmail: operator.email,
      controllerSn: operator.controllerSn,
      startedAt: new Date(sample.ts),
      startLat: sample.lat,
      startLon: sample.lon,
    })
    this.active.set(sample.sn, {
      id,
      startedAt: sample.ts,
      lastAirborneAt: sample.ts,
      groundSince: null,
      lastSeenWall: this.now(),
    })
  }

  private async finish(sn: string, flight: Active): Promise<void> {
    this.active.delete(sn)
    await this.close(flight.id, sn, new Date(flight.startedAt), new Date(flight.lastAirborneAt))
  }

  private async close(id: string, sn: string, startedAt: Date, endedAt: Date): Promise<void> {
    let kept = false
    try {
      const rows = await this.store.fleet.flightSamples(sn, startedAt, endedAt)
      const stats = summarizeTrack(
        rows.map((row) => ({
          ts: new Date(row.ts).getTime(),
          lat: row.lat,
          lon: row.lon,
          altRel: row.alt_rel,
          speedH: row.speed_h,
          batteryPct: row.battery_pct,
        })),
      )
      const hasPath = rows.filter((row) => row.lat != null && row.lon != null).length >= 2
      if (stats.durationS * 1000 >= MIN_FLIGHT_MS && hasPath) {
        await this.store.fleet.finishFlight(id, endedAt, stats)
        kept = true
      } else {
        await this.store.fleet.discardFlight(id)
      }
    } catch (error) {
      console.error('[flights] could not close flight', id, error)
    }
    this.events.emit('ended', { sn, flightId: id, kept } satisfies FlightEnded)
  }
}
