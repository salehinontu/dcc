import type { FastifyInstance } from 'fastify'
import {
  can,
  summarizeTrack,
  thin,
  type FlightDetail,
  type FlightPoint,
  type FlightSummary,
} from '@dji/protocol'
import { z } from 'zod'
import type { RouteContext } from '../http/context'
import { readableSns } from '../http/scope'

const MAX_POINTS = 1500

export function registerFlightRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store } = ctx

  type Sample = Awaited<ReturnType<typeof readSamples>>[number]

  async function readSamples(flight: FlightSummary) {
    const start = new Date(flight.startedAt)
    // A flight still in progress has no end yet: everything recorded since take-off is its path.
    const end = flight.endedAt ? new Date(flight.endedAt) : new Date('9999-12-31T00:00:00Z')
    const rows = await store.fleet.flightSamples(flight.deviceSn, start, end)
    return rows.map((row) => ({
      ts: new Date(row.ts).getTime(),
      lat: row.lat,
      lon: row.lon,
      altRel: row.alt_rel,
      speedH: row.speed_h,
      heading: row.heading,
      batteryPct: row.battery_pct,
    }))
  }

  function summarise(flight: FlightSummary, samples: Sample[]): FlightSummary {
    const stats = summarizeTrack(samples)
    return {
      ...flight,
      durationS: stats.durationS,
      distanceM: stats.distanceM,
      maxAltM: stats.maxAltM,
      maxSpeedMs: stats.maxSpeedMs,
      avgSpeedMs: stats.avgSpeedMs,
      minBatteryPct: stats.minBatteryPct,
      maxRangeM: stats.maxRangeM,
      endLat: stats.end?.lat ?? null,
      endLon: stats.end?.lon ?? null,
    }
  }

  async function withLiveSummary(flight: FlightSummary): Promise<FlightSummary> {
    return flight.status === 'active' ? summarise(flight, await readSamples(flight)) : flight
  }

  app.get('/api/flights', async (req, reply) => {
    const query = z
      .object({
        deviceSn: z.string().min(1).max(64).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        before: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid request' })
    const flights = await store.fleet.listFlights({
      allowedSns: readableSns(req.user!, 'flights.view'),
      deviceSn: query.data.deviceSn,
      fromIso: query.data.from,
      toIso: query.data.to,
      beforeIso: query.data.before,
      limit: query.data.limit,
    })
    // A flight in the air has no stored summary yet: show what has been recorded so far.
    return { flights: await Promise.all(flights.map(withLiveSummary)) }
  })

  app.get('/api/flights/:id', async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    const flight = await store.fleet.getFlight(params.data.id)
    if (!flight || !can(req.user!, 'flights.view', flight.deviceSn))
      return reply.code(404).send({ error: 'not found' })

    const samples = await readSamples(flight)
    const summary = flight.status === 'active' ? summarise(flight, samples) : flight

    const points: FlightPoint[] = thin(
      samples.filter((sample) => sample.lat != null && sample.lon != null),
      MAX_POINTS,
    ).map((sample) => ({
      ts: sample.ts,
      lat: sample.lat!,
      lon: sample.lon!,
      alt: sample.altRel,
      speed: sample.speedH,
      heading: sample.heading,
      battery: sample.batteryPct,
    }))

    const alerts = await store.fleet.listAlerts({ flightId: flight.id, limit: 200 })
    const detail: FlightDetail = { flight: summary, points, alerts }
    return detail
  })
}
