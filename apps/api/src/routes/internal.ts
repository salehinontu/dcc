import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { RouteContext } from '../http/context'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

// EMQX hooks and the MediaMTX auth hook: internal network only, never routed through Nginx.
export function registerInternalRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { authorizer, manager } = ctx

  app.post('/internal/mqtt/auth', async (req) => {
    const parsed = z
      .object({
        username: z.string().default(''),
        password: z.string().default(''),
      })
      .safeParse(req.body ?? {})
    if (!parsed.success) return { result: 'deny' }

    const allowed = await authorizer.authenticate(parsed.data.username, parsed.data.password)
    return { result: allowed ? 'allow' : 'deny' }
  })

  app.post('/internal/mqtt/acl', async (req) => {
    const parsed = z
      .object({
        username: z.string().default(''),
        topic: z.string().min(1),
        action: z.string().default(''),
        access: z.string().optional(),
      })
      .safeParse(req.body ?? {})
    if (!parsed.success) return { result: 'deny' }

    const action = parsed.data.action || parsed.data.access || ''
    const allowed = await authorizer.authorize(parsed.data.username, parsed.data.topic, action)
    return { result: allowed ? 'allow' : 'deny' }
  })

  // MediaMTX calls this for every publish and read. Any 2xx allows; anything else denies.
  app.post('/internal/media/auth', async (req, reply) => {
    const parsed = z
      .object({
        user: z.string().optional(),
        password: z.string().optional(),
        ip: z.string().optional(),
        action: z.string().optional(),
        path: z.string().optional(),
        protocol: z.string().optional(),
        id: z.string().optional(),
        query: z.string().optional(),
      })
      .catchall(z.unknown())
      .safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(401).send()

    const { action, ip, path } = parsed.data
    if (action === 'publish') {
      const key = path?.startsWith('live/') ? path.slice('live/'.length) : ''
      // Auth does not change state: runOnAvailable -> on_publish does that.
      if (!key || !(await manager.canPublish(key))) return reply.code(401).send()
      return reply.code(204).send()
    }

    // Only the API's WHEP proxy reads from the media server.
    if (action === 'read') {
      if (ip && LOOPBACK.has(ip)) return reply.code(204).send()
      return reply.code(401).send()
    }

    return reply.code(401).send()
  })
}
