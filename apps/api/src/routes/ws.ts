import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { can, wsClientMessageSchema } from '@dji/protocol'
import { resolveCredential } from '../api-tokens'
import { addressOf, requestCredential } from '../http/auth'
import type { RouteContext } from '../http/context'
import { sameOrigin } from '../http/origin'
import { tenantOf } from '../http/tenant'
import { streamState } from '../streams/state'

const MAX_MESSAGES_PER_SECOND = 20
const KEEPALIVE_MS = 25_000
const OPEN = 1

export function registerWsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { hub, manager, store } = ctx

  app.get(
    '/ws',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        await ctx.requireViewer(req, reply)
        if (!reply.sent && req.user?.mustChangePassword)
          await reply.code(403).send({ error: 'password_change_required' })
        if (!reply.sent && req.user?.mfaEnrolRequired)
          await reply.code(403).send({ error: 'mfa_enrolment_required' })
      },
    },
    (socket, req) => {
      // Cross-site WebSocket hijacking: a page on another origin must not ride the cookie.
      if (!sameOrigin(req)) {
        socket.close(4003, 'origin not allowed')
        return
      }

      // A cookie or Authorization header only; a token in the query string leaks into logs.
      const token = requestCredential(req)
      const user = req.user
      if (!user) {
        socket.close(4001, 'unauthorized')
        return
      }
      if (user.gatewaySn || user.mustChangePassword || user.mfaEnrolRequired) {
        socket.close(4003, 'controller token')
        return
      }

      const expiresAt = user.exp !== undefined ? user.exp * 1000 : null
      const id = randomUUID()
      // Runs on every inbound message and on a 2 s timer, so a session revoked anywhere —
      // including by the CLI, which cannot reach this process — is closed here within two
      // seconds. `resolveUser` now consults the sessions table as well as the account row.
      const fresh = async () => {
        const current = await resolveCredential(token!, store, addressOf(req))
        if (!current) {
          ctx.whep.closeForUser(user.id)
          manager.dropConnection(id)
          socket.close(4001, 'session revoked')
          return null
        }
        if (
          current.mustChangePassword ||
          current.mfaEnrolRequired ||
          (current.exp && Date.now() >= current.exp * 1000)
        ) {
          ctx.whep.closeForUser(user.id)
          manager.dropConnection(id)
          socket.close(4003, 'access changed')
          return null
        }
        return current
      }
      hub.add(
        id,
        socket,
        user.id,
        async (message) => {
          const current = await fresh()
          if (!current) return false
          // A Pilot account holds `drones.view` for its controller, not for the dashboard.
          if (current.role === 'pilot') return false
          // Zone changes concern the whole map, not one aircraft.
          if (message.type === 'zones.changed') return can(current, 'zones.view')
          if (!('data' in message) || Array.isArray(message.data)) return false
          const data = message.data as { sn?: string; deviceSn?: string }
          const sn = data.sn ?? data.deviceSn
          if (
            !sn ||
            !can(
              current,
              message.type === 'telemetry'
                ? 'telemetry.view'
                : message.type === 'stream.state'
                  ? 'streams.view'
                  : 'drones.view',
              sn,
            )
          )
            return false
          // An alert names its zone, so it only goes to accounts that may see that zone. One with no zone
          // (link lost, battery) is about the aircraft, which the check above already limited.
          if (message.type === 'alert' && message.data.zoneId !== null) {
            const tenant = await tenantOf(store, current)
            if (tenant && !(await store.fleet.zoneIdsFor([...tenant.ids])).has(message.data.zoneId))
              return false
          }
          return message.type === 'device.removed' || !(await store.deviceUnavailable(sn))
        },
        user.jti,
      )
      const accessTimer = setInterval(() => {
        void fresh().catch(() => socket.close(4003, 'access unavailable'))
      }, 2000)
      accessTimer.unref()
      socket.send(JSON.stringify({ type: 'ready' }))

      let tokens = MAX_MESSAGES_PER_SECOND
      let refilledAt = Date.now()
      const allowMessage = (): boolean => {
        const now = Date.now()
        tokens = Math.min(
          MAX_MESSAGES_PER_SECOND,
          tokens + ((now - refilledAt) / 1000) * MAX_MESSAGES_PER_SECOND,
        )
        refilledAt = now
        if (tokens < 1) return false
        tokens -= 1
        return true
      }

      let alive = true
      const keepalive = setInterval(() => {
        if (!alive) {
          socket.terminate()
          return
        }
        alive = false
        try {
          socket.ping()
        } catch {
          socket.terminate()
        }
      }, KEEPALIVE_MS)
      keepalive.unref()
      socket.on('pong', () => {
        alive = true
      })

      const sendSnapshot = (): void => {
        void store
          .snapshotStreams()
          .then(async (rows) => {
            const current = await fresh()
            if (!current) return
            rows = rows.filter((row) => can(current, 'streams.view', row.device_sn))
            if (socket.readyState !== OPEN) return
            socket.send(JSON.stringify({ type: 'streams.snapshot', data: rows.map(streamState) }))
          })
          .catch((error) => console.error('[ws] snapshot failed', error))
      }

      socket.on('message', (raw) => {
        void (async () => {
          if (!allowMessage()) return
          const current = await fresh()
          if (!current) return
          if (expiresAt !== null && Date.now() >= expiresAt) {
            socket.close(4001, 'session expired')
            return
          }
          let message: unknown
          try {
            message = JSON.parse(raw.toString())
          } catch {
            return
          }

          const parsed = wsClientMessageSchema.safeParse(message)
          if (!parsed.success) return

          switch (parsed.data.type) {
            case 'subscribe':
              hub.setChannels(id, 'add', parsed.data.channels)
              if (parsed.data.channels.includes('devices')) sendSnapshot()
              return
            case 'unsubscribe':
              hub.setChannels(id, 'remove', parsed.data.channels)
              return
            case 'watch':
              manager.watch(
                id,
                parsed.data.sns.filter((sn) => can(current, 'streams.view', sn)),
              )
              return
            case 'unwatch':
              manager.unwatch(id, parsed.data.sns)
              return
            case 'retry':
              if (can(current, 'streams.view', parsed.data.sn)) manager.retry(id, parsed.data.sn)
              return
            case 'ping':
              if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'pong' }))
              return
          }
        })().catch(() => socket.close(4003, 'access unavailable'))
      })

      socket.on('close', () => {
        clearInterval(accessTimer)
        clearInterval(keepalive)
        hub.remove(id)
        manager.dropConnection(id)
      })
    },
  )
}
