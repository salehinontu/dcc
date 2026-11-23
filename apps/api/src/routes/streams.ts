import type { FastifyInstance, FastifyRequest } from 'fastify'
import { can, VIDEO_TYPE } from '@dji/protocol'
import { z } from 'zod'
import type { RouteContext } from '../http/context'
import { streamState } from '../streams/state'
import type { StreamRow } from '../store'

const idParams = z.object({ id: z.string().uuid() })
const deviceParams = z.object({ sn: z.string().min(1).max(64) })
const sessionParams = z.object({ id: z.string().uuid(), session: z.string().uuid() })

export function registerStreamRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, manager, whep, requireViewer, requireAdmin } = ctx

  app.get('/api/streams', { preHandler: requireViewer }, async (req) => ({
    streams: (await store.snapshotStreams())
      .filter((row) => can(req.user!, 'streams.view', row.device_sn))
      .map(streamState),
  }))

  app.get('/api/streams/:id', { preHandler: requireViewer }, async (req, reply) => {
    const params = idParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })

    const row = await store.getStream(params.data.id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    return { stream: streamState(row) }
  })

  const videoOnlyMessage = 'This is a video-only drone: start, stop and quality are set in DJI Fly.'

  app.patch('/api/streams/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const params = idParams.safeParse(req.params)
    const body = z
      .object({
        quality: z.number().int().min(0).max(4).optional(),
        videoType: z.enum(VIDEO_TYPE).optional(),
      })
      .safeParse(req.body)
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid request' })
    if (body.data.quality === undefined && body.data.videoType === undefined) {
      return reply.code(400).send({ error: 'nothing to change' })
    }
    const target = await store.getStream(params.data.id)
    if (target && (await store.isVideoSource(target.device_sn)))
      return reply.code(409).send({ error: videoOnlyMessage })

    try {
      let row: StreamRow | null = null

      if (body.data.quality !== undefined) {
        row = await manager.setQuality(params.data.id, body.data.quality)
        if (!row) return reply.code(409).send({ error: 'stream is not active' })
      }

      if (body.data.videoType !== undefined) {
        const changed = await manager.setLens(params.data.id, body.data.videoType)
        if (!changed) return reply.code(409).send({ error: 'stream is not active' })
        if (!row) row = await store.getStream(params.data.id)
      }

      return { stream: row ? streamState(row) : null }
    } catch {
      return reply.code(502).send({ error: 'controller rejected the command' })
    }
  })

  app.post('/api/devices/:sn/stream/stop', { preHandler: requireAdmin }, async (req, reply) => {
    const params = deviceParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    if (await store.isVideoSource(params.data.sn))
      return reply.code(409).send({ error: videoOnlyMessage })

    await manager.adminStop(params.data.sn, req.user?.email ?? 'admin')
    return reply.code(204).send()
  })

  app.post('/api/devices/:sn/stream/resume', { preHandler: requireAdmin }, async (req, reply) => {
    const params = deviceParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    if (await store.isVideoSource(params.data.sn))
      return reply.code(409).send({ error: videoOnlyMessage })

    await manager.adminResume(params.data.sn)
    return reply.code(204).send()
  })

  app.post(
    '/api/streams/:id/network',
    {
      preHandler: requireViewer,
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const params = idParams.safeParse(req.params)
      const body = z
        .object({
          sessionId: z.string().uuid(),
          downlinkMbps: z.number().min(0).max(10000).optional(),
          concurrentStreams: z.number().int().min(1).max(64),
          loss: z.number().min(0).max(1),
          stalled: z.boolean(),
        })
        .safeParse(req.body)
      if (!params.success || !body.success)
        return reply.code(400).send({ error: 'invalid network report' })
      if (!whep.owns(params.data.id, body.data.sessionId, req.user!.id))
        return reply.code(403).send({ error: 'playback session required' })
      try {
        await manager.reportNetwork(params.data.id, body.data.sessionId, body.data)
      } catch {
        return reply.code(502).send({ error: 'controller rejected quality change' })
      }
      return reply.code(204).send()
    },
  )

  // ---------- WHEP playback ----------

  app.post(
    '/api/streams/:id/whep',
    {
      preHandler: requireViewer,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const params = idParams.safeParse(req.params)
      const offer = req.body
      if (!params.success || typeof offer !== 'string' || !offer.startsWith('v=0')) {
        return reply.code(400).send({ error: 'invalid SDP offer' })
      }

      const row = await store.getStream(params.data.id)
      if (!row) return reply.code(404).send({ error: 'not found' })
      if (row.state !== 'live') return reply.code(409).send({ error: 'not live' })

      const result = await whep.open(
        row,
        offer,
        req.user!.id,
        req.user!.sessionVersion,
        (req.user!.exp ?? 0) * 1000,
      )
      if (!result.ok) return reply.code(502).send({ error: 'media server unavailable' })

      const latest = await store.findUserById(req.user!.id)
      if (
        !latest ||
        latest.session_version !== req.user!.sessionVersion ||
        (await store.deviceUnavailable(row.device_sn))
      ) {
        await whep.close(row.id, result.sessionId, req.user!.id)
        return reply.code(403).send({ error: 'access changed' })
      }
      return reply
        .code(201)
        .header('content-type', 'application/sdp')
        .header('cache-control', 'no-store')
        .header('location', `whep/${result.sessionId}`)
        .send(result.answer)
    },
  )

  app.delete(
    '/api/streams/:id/whep/:session',
    { preHandler: requireViewer },
    async (req, reply) => {
      const params = sessionParams.safeParse(req.params)
      if (!params.success) return reply.code(400).send({ error: 'invalid request' })

      const closed = await whep.close(params.data.id, params.data.session, req.user!.id)
      if (!closed) return reply.code(404).send({ error: 'not found' })
      return reply.code(204).send()
    },
  )

  // ---------- Media server callbacks (internal network only) ----------

  const hookBody = z.object({ stream: z.string().optional() })

  function publishedKey(req: FastifyRequest): string | null {
    const body = hookBody.safeParse(req.body ?? {})
    const query = (req.query as { stream?: string } | undefined)?.stream
    // MediaMTX reports the full path ("live/<key>"); SRS reports only the stream name.
    return (body.success ? (body.data.stream ?? query) : query)?.replace(/^live\//, '') || null
  }

  app.post('/internal/srs/on_publish', async (req, reply) => {
    const key = publishedKey(req)
    const accepted = key ? await manager.onPublish(key) : false
    // SRS treats any body other than '0' as a rejection.
    return reply.type('text/plain').send(accepted ? '0' : '1')
  })

  app.post('/internal/srs/on_unpublish', async (req, reply) => {
    const key = publishedKey(req)
    if (key) await manager.onUnpublish(key)
    return reply.type('text/plain').send('0')
  })
}
