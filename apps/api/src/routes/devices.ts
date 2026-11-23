import type { FastifyInstance } from 'fastify'
import { can, channels, deviceProfileSchema } from '@dji/protocol'
import { z } from 'zod'
import type { RouteContext } from '../http/context'
import { iso } from '../store'

export function registerDeviceRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, registry, requireUser, requireViewer, requireAdmin } = ctx

  // A Pilot account only signs a controller in and holds `drones.view` on every drone for that
  // reason; its dashboard session must not list the fleet, which may be someone else's.
  app.get('/api/devices', { preHandler: requireUser }, async (req) => ({
    devices: (await registry.list())
      .filter((device) => req.user!.role !== 'pilot' && can(req.user!, 'drones.view', device.sn))
      .map((device) =>
        can(req.user!, 'telemetry.view', device.sn) ? device : { ...device, telemetry: null },
      ),
  }))

  app.delete('/api/devices/:sn', { preHandler: requireAdmin }, async (req, reply) => {
    const { sn } = req.params as { sn: string }
    if (!(await store.deleteDevice(sn, req.user!.id)))
      return reply.code(404).send({ error: 'unknown active drone' })
    // Tombstone first: concurrent topology/OSD/stream starts cannot resurrect it.
    ctx.hub.publish([channels.devices, channels.device(sn)], {
      type: 'device.removed',
      data: { sn },
    })
    await ctx.manager.stopDevice(sn, 'drone deleted', true)
    return reply.code(204).send()
  })

  app.patch('/api/devices/:sn', { preHandler: requireAdmin }, async (req, reply) => {
    const params = z.object({ sn: z.string().min(1) }).safeParse(req.params)
    const body = deviceProfileSchema.safeParse(req.body)
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'invalid request' })
    }
    const { sn } = params.data
    const { displayName, label, color } = body.data

    if (displayName !== undefined && !(await store.setDeviceName(sn, displayName?.trim() || null)))
      return reply.code(404).send({ error: 'unknown device' })
    if (label !== undefined && !(await store.setDeviceLabel(sn, label?.trim() || null)))
      return reply.code(404).send({ error: 'unknown device' })
    if (color !== undefined && !(await store.fleet.setDeviceColor(sn, color)))
      return reply.code(404).send({ error: 'unknown device' })

    const profile = await store.fleet.deviceProfile(sn)
    if (!profile) return reply.code(404).send({ error: 'unknown device' })
    ctx.hub.publish([channels.devices, channels.device(sn)], {
      type: 'device.profile',
      data: { sn, displayName: profile.displayName, label: profile.label, color: profile.color },
    })
    return {
      ok: true,
      displayName: profile.displayName,
      label: profile.label,
      color: profile.color,
    }
  })

  /**
   * Disable or re-enable an aircraft. This is the reversible pause: hidden from the fleet and
   * refused at the broker, but an admin brings it back with no controller involved. Deletion
   * is deliberately not reachable this way — it means the aircraft is gone, and only the
   * controller that owns it can undo that.
   */
  app.post('/api/devices/:sn/disable', { preHandler: requireAdmin }, async (req, reply) => {
    const params = z.object({ sn: z.string().min(1).max(64) }).safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid serial' })
    const { sn } = params.data
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled === true

    // True when the aircraft is in the requested state afterwards, so a repeat request is an
    // accepted no-op and only an unknown or deleted serial is a 404.
    const applied = await store.setDeviceDisabled(sn, !enabled, req.user!.id)
    if (!applied) return reply.code(404).send({ error: 'unknown active drone' })

    if (!enabled) {
      await ctx.manager.stopDevice(sn, 'drone disabled', true)
      // A video-only drone has no controller to tell: cut its push off the media server.
      if (await store.isVideoSource(sn)) await ctx.manager.disconnectSource(sn)
    }
    // Enabling leaves the aircraft offline: it must report again to prove it is back.
    ctx.hub.publish([channels.devices, channels.device(sn)], {
      type: 'device.status',
      data: { sn, gatewaySn: null, online: false, lastSeenAt: null },
    })
    return { ok: true, enabled }
  })

  app.get('/api/devices/:sn/telemetry', { preHandler: requireViewer }, async (req, reply) => {
    const params = z.object({ sn: z.string().min(1) }).safeParse(req.params)
    const query = z
      .object({ minutes: z.coerce.number().int().min(1).max(1440).default(30) })
      .safeParse(req.query)
    if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid request' })

    const since = new Date(Date.now() - query.data.minutes * 60_000).toISOString()
    const rows = await store.telemetry(params.data.sn, since)
    return { samples: rows.map((row) => ({ ...row, ts: iso(row.ts) })) }
  })

  app.get('/api/devices/:sn/trail', { preHandler: requireViewer }, async (req, reply) => {
    const params = z.object({ sn: z.string().min(1) }).safeParse(req.params)
    const query = z
      .object({ minutes: z.coerce.number().int().min(1).max(240).default(5) })
      .safeParse(req.query)
    if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid request' })

    const since = new Date(Date.now() - query.data.minutes * 60_000).toISOString()
    const rows = await store.trail(params.data.sn, since)
    return {
      points: rows.map((row) => ({
        ts: iso(row.ts),
        lat: row.lat,
        lon: row.lon,
        alt: row.alt_rel,
      })),
    }
  })
}
