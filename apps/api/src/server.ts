import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { config } from './config'
import { createAuthGuards } from './http/auth'
import type { Deps, RouteContext } from './http/context'
import { sameOrigin } from './http/origin'
import { registerAccessMiddleware } from './http/access'
import { registerAuditHooks } from './http/audit'
import { registerAuditRoutes } from './routes/audit'
import { registerAdminRoutes } from './routes/admin'
import { registerFlightRoutes } from './routes/flights'
import { registerZoneRoutes } from './routes/zones'
import { registerUserRoutes } from './routes/users'
import { registerAuthRoutes } from './routes/auth'
import { registerMfaRoutes } from './routes/mfa'
import { registerBrandingRoutes } from './routes/branding'
import { registerDeviceRoutes } from './routes/devices'
import { registerInternalRoutes } from './routes/internal'
import { registerPilotRoutes } from './routes/pilot'
import { registerApiTokenRoutes } from './routes/api-tokens'
import { registerMediaExportRoutes } from './routes/media-export'
import { registerRecordingRoutes } from './routes/recordings'
import { registerScreenshotRoutes } from './routes/screenshots'
import { registerStreamRoutes } from './routes/streams'
import { registerSystemRoutes } from './routes/system'
import { registerVideoSourceRoutes } from './routes/video-sources'
import { registerWsRoutes } from './routes/ws'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export async function buildServer(deps: Deps) {
  const app = Fastify({
    trustProxy: ['false', '0', 'off', ''].includes(config.trustProxy.toLowerCase())
      ? false
      : config.trustProxy,
    logger: {
      level: 'info',
      serializers: {
        // MediaMTX reports the stream key in the callback query string; request logs must
        // never carry it (or any future token in a URL).
        req: (req: { method?: string; url?: string; host?: string; ip?: string }) => ({
          method: req.method,
          url: req.url?.split('?')[0],
          host: req.host,
          // With a trusted proxy the address is worked out from the socket, and a request without one (an injected
          // WebSocket in the tests, a socket already gone) would throw here and stall the request: never let a log line
          // do that.
          remoteAddress: (() => {
            try {
              return req.ip
            } catch {
              return undefined
            }
          })(),
        }),
      },
    },
  })

  await app.register(cookie)
  if (config.corsOrigins.length > 0) {
    await app.register(cors, { origin: config.corsOrigins, credentials: true })
  }
  await app.register(rateLimit, { global: false })
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } })

  // WHEP requests carry a raw SDP offer, not JSON.
  app.addContentTypeParser(
    'application/sdp',
    { parseAs: 'string', bodyLimit: 32 * 1024 },
    (_req, body, done) => done(null, body),
  )

  // Defence in depth for cookie-authenticated writes: a cross-site form or fetch cannot
  // ride an existing session. `/api/pilot/*` is exempt because Pilot 2's WebView does not
  // guarantee an Origin header.
  app.addHook('onRequest', async (req, reply) => {
    if (!MUTATING_METHODS.has(req.method)) return
    if (!req.url.startsWith('/api/')) return
    if (req.url.startsWith('/api/pilot/')) return
    if (sameOrigin(req)) return
    await reply.code(403).send({ error: 'cross-origin request blocked' })
  })

  const ctx: RouteContext = { ...deps, ...createAuthGuards(deps.store) }

  let checkingPlayback = false
  const playbackAccess = setInterval(() => {
    if (checkingPlayback) return
    checkingPlayback = true
    void deps.whep
      .revalidate(deps.store)
      .catch((error) => {
        deps.whep.closeAll()
        app.log.error(error, 'playback access check failed')
      })
      .finally(() => {
        checkingPlayback = false
      })
  }, 2000)
  playbackAccess.unref()
  app.addHook('onClose', async () => {
    clearInterval(playbackAccess)
    deps.whep.closeAll()
  })

  // Pilot and admin responses carry controller serials, MQTT credentials and the DJI
  // licence. None of it may sit in a browser or intermediary cache (security review M-03).
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/pilot/') || req.url.startsWith('/api/admin/')) {
      reply.header('cache-control', 'no-store')
      reply.header('pragma', 'no-cache')
    }
    return payload
  })

  registerAccessMiddleware(app, ctx)
  // After the access check, so it knows who asked; it records the refusals too.
  registerAuditHooks(app, ctx)
  registerUserRoutes(app, ctx)
  registerAuditRoutes(app, ctx)
  registerAdminRoutes(app, ctx)
  registerAuthRoutes(app, ctx)
  registerMfaRoutes(app, ctx)
  registerDeviceRoutes(app, ctx)
  registerStreamRoutes(app, ctx)
  registerVideoSourceRoutes(app, ctx)
  registerScreenshotRoutes(app, ctx)
  registerRecordingRoutes(app, ctx)
  registerApiTokenRoutes(app, ctx)
  registerMediaExportRoutes(app, ctx)
  registerZoneRoutes(app, ctx)
  registerFlightRoutes(app, ctx)
  registerPilotRoutes(app, ctx)
  registerInternalRoutes(app, ctx)
  registerWsRoutes(app, ctx)
  registerSystemRoutes(app, ctx)
  registerBrandingRoutes(app)

  return app
}
