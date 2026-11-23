import type { FastifyInstance } from 'fastify'
import { can, channels, zoneInputSchema } from '@dji/protocol'
import { z } from 'zod'
import type { CurrentUser } from '../auth'
import type { RouteContext } from '../http/context'
import { readableSns } from '../http/scope'
import { tenantOf } from '../http/tenant'

export function registerZoneRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, hub } = ctx
  let rev = 0

  /** Tell the alert engine and every open dashboard that the zones changed. */
  async function changed(): Promise<void> {
    await ctx.geo?.reload()
    rev += 1
    hub.publish([channels.devices], { type: 'zones.changed', data: { rev } })
  }

  /**
   * The accounts whose zones this account shares: undefined for a Developer, who sees and edits
   * every zone, otherwise its own team's. The built-in advisory zones are everyone's to read, but
   * only a Developer changes them.
   */
  async function teamIds(req: { user?: CurrentUser }): Promise<string[] | undefined> {
    const tenant = await tenantOf(store, req.user!)
    return tenant ? [...tenant.ids] : undefined
  }

  /**
   * An account with the zones screen sees the built-in zones and its own team's. A geofence
   * tied to particular aircraft is shown only to an account that can see at least one of them,
   * and only with the serials it can see.
   */
  app.get('/api/zones', async (req) => {
    const zones = await store.fleet.listZones(await teamIds(req))
    const readable = readableSns(req.user!, 'drones.view')
    if (readable === undefined) return { zones }
    const mine = new Set(readable)
    return {
      zones: zones
        .map((zone) =>
          zone.kind === 'geofence' && zone.deviceSns.length > 0
            ? { ...zone, deviceSns: zone.deviceSns.filter((sn) => mine.has(sn)) }
            : zone,
        )
        .filter(
          (zone, index) =>
            zone.kind === 'no_fly' ||
            zones[index]!.deviceSns.length === 0 ||
            zone.deviceSns.length > 0,
        ),
    }
  })

  /** Null when the account may change this zone. */
  async function mayChangeZone(
    req: { user?: CurrentUser },
    id: string,
  ): Promise<{ code: number; error: string } | null> {
    const owners = await teamIds(req)
    if (!owners) return null
    if (!(await store.fleet.getZone(id))) return { code: 404, error: 'unknown zone' }
    if (await store.fleet.zoneDrawnBy(id, owners)) return null
    return { code: 403, error: 'You can only change zones your own team drew.' }
  }

  app.post('/api/zones', async (req, reply) => {
    const body = zoneInputSchema.safeParse(req.body)
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: body.error.issues[0]?.message ?? 'invalid zone', issues: body.error.issues })
    }
    const zone = await store.fleet.createZone(body.data, req.user?.id ?? null)
    await changed()
    return reply.code(201).send({ zone })
  })

  app.put('/api/zones/:id', async (req, reply) => {
    const params = z.object({ id: z.string().min(1).max(80) }).safeParse(req.params)
    const body = zoneInputSchema.safeParse(req.body)
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: body.success ? 'invalid request' : (body.error.issues[0]?.message ?? 'invalid zone'),
      })
    }
    const refusal = await mayChangeZone(req, params.data.id)
    if (refusal) return reply.code(refusal.code).send({ error: refusal.error })
    const zone = await store.fleet.updateZone(params.data.id, body.data)
    if (!zone) return reply.code(404).send({ error: 'unknown zone' })
    await changed()
    return { zone }
  })

  app.delete('/api/zones/:id', async (req, reply) => {
    const params = z.object({ id: z.string().min(1).max(80) }).safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    const refusal = await mayChangeZone(req, params.data.id)
    if (refusal) return reply.code(refusal.code).send({ error: refusal.error })
    if (!(await store.fleet.deleteZone(params.data.id)))
      return reply.code(404).send({ error: 'unknown zone' })
    await changed()
    return reply.code(204).send()
  })

  app.get('/api/alerts', async (req, reply) => {
    const query = z
      .object({
        deviceSn: z.string().min(1).max(64).optional(),
        active: z.enum(['0', '1']).optional(),
        before: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid request' })
    const alerts = await store.fleet.listAlerts({
      allowedSns: readableSns(req.user!, 'drones.view'),
      deviceSn: query.data.deviceSn,
      activeOnly: query.data.active === '1',
      beforeIso: query.data.before,
      limit: query.data.limit,
    })
    // An alert about a zone this account may not see would name it: leave those out.
    const owners = await teamIds(req)
    if (!owners) return { alerts }
    const visible = await store.fleet.zoneIdsFor(owners)
    // An alert with no zone (link lost, battery) is about the aircraft, already limited to the ones this account sees.
    return { alerts: alerts.filter((alert) => alert.zoneId === null || visible.has(alert.zoneId)) }
  })

  app.post('/api/alerts/:id/ack', async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    const existing = await store.fleet.getAlert(params.data.id)
    const owners = await teamIds(req)
    if (
      !existing ||
      !can(req.user!, 'drones.view', existing.deviceSn) ||
      (owners &&
        existing.zoneId !== null &&
        !(await store.fleet.zoneIdsFor(owners)).has(existing.zoneId))
    )
      return reply.code(404).send({ error: 'not found' })
    const alert = await store.fleet.acknowledgeAlert(existing.id, req.user!.id)
    if (alert) ctx.geo?.publish(alert)
    return { alert }
  })
}
