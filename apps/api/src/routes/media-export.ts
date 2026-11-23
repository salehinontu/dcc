import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../config'
import type { RouteContext } from '../http/context'
import { FrameFailed, MediaExport, NotStreaming, TooManyLive } from '../streams/export'

const params = z.object({ sn: z.string().min(1).max(64) })

/**
 * A picture or the live video of a drone, for a program of the customer's own (see `streams/export.ts`). Both need
 * `streams.view` on the drone, like watching it, and an API token may call them (`http/access.ts`).
 */
export function registerMediaExportRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store } = ctx
  const exporter =
    ctx.mediaExport ??
    new MediaExport(
      { store, manager: ctx.manager },
      {
        ffmpegPath: config.recordings.ffmpegPath,
        inputUrl: (key) =>
          config.media.rtmpInternalTemplate.replace('{key}', encodeURIComponent(key)),
        waitMs: config.apiAccess.waitSeconds * 1000,
        maxLive: config.apiAccess.liveMax,
      },
    )

  const notStreaming = (reply: import('fastify').FastifyReply) =>
    reply.code(503).header('retry-after', '5').send({
      error: 'drone_not_streaming',
      message: 'The drone is not sending video yet. Ask again in a few seconds.',
      retryAfterSeconds: 5,
    })

  // One JPEG of what the drone sees now.
  app.get(
    '/api/devices/:sn/frame',
    { exposeHeadRoute: false, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = params.safeParse(req.params)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid request' })
      const { sn } = parsed.data
      if (!(await store.deviceExists(sn))) return reply.code(404).send({ error: 'unknown drone' })
      if (await store.deviceUnavailable(sn)) return reply.code(410).send({ error: 'drone deleted' })
      try {
        const frame = await exporter.frame(sn)
        return reply
          .header('content-type', 'image/jpeg')
          .header('cache-control', 'no-store')
          .header('x-frame-time', new Date(frame.at).toISOString())
          .send(frame.jpeg)
      } catch (error) {
        if (error instanceof NotStreaming) return notStreaming(reply)
        if (error instanceof FrameFailed) {
          req.log.warn({ sn, reason: error.message }, 'frame export failed')
          return reply.code(502).send({ error: 'frame_failed' })
        }
        throw error
      }
    },
  )

  // The live video, MPEG-TS over HTTP: ffmpeg, VLC, OpenCV (through ffmpeg) and GStreamer read it as it is.
  app.get(
    '/api/devices/:sn/live',
    { exposeHeadRoute: false, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = params.safeParse(req.params)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid request' })
      const { sn } = parsed.data
      if (!(await store.deviceExists(sn))) return reply.code(404).send({ error: 'unknown drone' })
      if (await store.deviceUnavailable(sn)) return reply.code(410).send({ error: 'drone deleted' })
      let handle: Awaited<ReturnType<MediaExport['openLive']>>
      try {
        handle = await exporter.openLive(sn)
      } catch (error) {
        if (error instanceof NotStreaming) return notStreaming(reply)
        if (error instanceof TooManyLive)
          return reply.code(429).header('retry-after', '10').send({
            error: 'too_many_live_feeds',
            message: 'The server is at its live feed limit.',
          })
        throw error
      }
      // The program went away (or the connection dropped): let go of the drone and the media server.
      reply.raw.on('close', handle.close)
      return (
        reply
          .header('content-type', 'video/mp2t')
          .header('cache-control', 'no-store')
          // Nginx must pass the video on as it arrives, not collect it.
          .header('x-accel-buffering', 'no')
          .send(handle.stream)
      )
    },
  )
}
