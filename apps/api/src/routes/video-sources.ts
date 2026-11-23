import { randomBytes, randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  ACCOUNT_PERMISSIONS,
  can,
  PERMISSIONS,
  videoSourceCreateSchema,
  type VideoSourceInfo,
} from '@dji/protocol'
import { z } from 'zod'
import { rtmpUrl } from '../config'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { RouteContext } from '../http/context'

const snParams = z.object({ sn: z.string().regex(/^RTMP-[0-9A-F]{8}$/) })

/**
 * The key is typed by hand on a controller's small keyboard, so it is lower case and leaves out
 * the letters and digits that look alike (i, l, o, 0, 1). 31 symbols x 20 places is about 99 bits:
 * far beyond guessing.
 */
const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
function typeableKey(): string {
  return Array.from({ length: 20 }, () => KEY_ALPHABET[randomInt(KEY_ALPHABET.length)]).join('')
}

/** `rtmp://host/live/` and the key on its own: the two boxes in DJI Fly's livestream settings. */
function infoFor(sn: string, name: string | null, key: string): VideoSourceInfo {
  const url = rtmpUrl(key)
  return { sn, name: name ?? sn, address: url.slice(0, url.length - key.length), key, url }
}

/** A Pilot account only signs a controller in; the address and key are not for it. */
async function notPilot(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.user?.role === 'pilot') await reply.code(403).send({ error: 'forbidden' })
}

/**
 * Video-only drones: a drone with no controller whose pilot pushes RTMP from DJI Fly to a secret
 * address we hand out. It shows on the wall like any other drone, with no position, battery or
 * remote control. The key is the drone's identity, so everything here needs `drones.bind`.
 */
export function registerVideoSourceRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, manager } = ctx

  app.get('/api/video-sources', { preHandler: notPilot }, async (req) => ({
    sources: (await store.videoSources())
      .filter((source) => can(req.user!, 'drones.bind', source.sn))
      .map((source) => infoFor(source.sn, source.name, source.key)),
  }))

  app.post(
    '/api/video-sources',
    { preHandler: notPilot, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = videoSourceCreateSchema.safeParse(req.body)
      if (!body.success)
        return reply.code(400).send({ error: 'Give the drone a name (up to 40 letters).' })
      const sn = `RTMP-${randomBytes(4).toString('hex').toUpperCase()}`
      const key = typeableKey()
      await store.createVideoSource({ sn, name: body.data.name, key })
      // An account limited to selected drones must see what it makes, and so must its Admin: the
      // creator gets the rights it holds, the Admin the rights it has on its other drones. A
      // Developer, and an account that sees every drone, need nothing.
      const actor = req.user!
      if (actor.role !== 'developer') {
        await store.giveDrone(
          actor.id,
          sn,
          PERMISSIONS.filter((p) => !ACCOUNT_PERMISSIONS.includes(p) && can(actor, p)),
        )
        if (actor.adminId) await store.giveDroneToAdmin(actor.adminId, sn)
      }
      await store.fleet.assignMissingColors()
      await store
        .logDeviceEvent(sn, 'video_source.created', { by: req.user!.email })
        .catch(() => undefined)
      return reply.code(201).send({ source: infoFor(sn, body.data.name, key) })
    },
  )

  // A new key when the address leaked: the old one stops working and any push on it is cut.
  app.post('/api/video-sources/:sn/key', { preHandler: notPilot }, async (req, reply) => {
    const params = snParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    const key = typeableKey()
    const old = await store.rotateVideoSourceKey(params.data.sn, key)
    if (!old) return reply.code(404).send({ error: 'unknown video-only drone' })
    await manager.disconnectSource(params.data.sn, old)
    await store
      .logDeviceEvent(params.data.sn, 'video_source.rekeyed', { by: req.user!.email })
      .catch(() => undefined)
    const name = (await store.videoSources()).find((s) => s.sn === params.data.sn)?.name ?? null
    return { source: infoFor(params.data.sn, name, key) }
  })

  app.delete('/api/video-sources/:sn', { preHandler: notPilot }, async (req, reply) => {
    const params = snParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    // The address belongs to whoever may bind the drone, so that account may also take it away;
    // delete is the other right that has always allowed it.
    const actor = req.user!
    if (!can(actor, 'drones.bind', params.data.sn) && !can(actor, 'drones.delete', params.data.sn))
      return reply.code(403).send({ error: 'forbidden' })
    const key = await store.videoSourceKey(params.data.sn)
    if (!key) return reply.code(404).send({ error: 'unknown video-only drone' })
    await manager.disconnectSource(params.data.sn, key)
    await store.deleteVideoSource(params.data.sn)
    await store
      .logDeviceEvent(params.data.sn, 'video_source.deleted', { by: req.user!.email })
      .catch(() => undefined)
    return reply.code(204).send()
  })
}
