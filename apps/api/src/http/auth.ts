import type { IncomingHttpHeaders } from 'node:http'
import type { FastifyRequest } from 'fastify'
import { API_TOKEN_PREFIX } from '@dji/protocol'
import type { CurrentUser } from '../auth'
import { resolveCredential } from '../api-tokens'
import type { Store } from '../store'
import type { RouteGuard } from './context'

declare module 'fastify' {
  interface FastifyRequest {
    user?: CurrentUser
  }
}

export function bearerToken(headers: IncomingHttpHeaders): string | null {
  const header = headers.authorization
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null
}

/**
 * The credential a request carries. An API token (`ne_...`) always travels in the Authorization header and wins over
 * a cookie; a Pilot's controller token only in the header; everything else may ride the session cookie.
 */
export function requestCredential(req: {
  headers: IncomingHttpHeaders
  url: string
  cookies?: Record<string, string | undefined>
}): string | null {
  const bearer = bearerToken(req.headers)
  if (bearer?.startsWith(API_TOKEN_PREFIX)) return bearer
  return req.url.startsWith('/api/pilot/') ? bearer : (req.cookies?.dji_session ?? bearer)
}

/** The visitor's address, or undefined where there is none to read (a socket-less test request makes `req.ip` throw). */
export function addressOf(req: { ip: string }): string | undefined {
  try {
    return req.ip
  } catch {
    return undefined
  }
}

export function createAuthGuards(store: Store): {
  requireUser: RouteGuard
  requireViewer: RouteGuard
  requireOperator: RouteGuard
  requireAdmin: RouteGuard
  requirePilotPreauth: RouteGuard
  requirePilot: RouteGuard
} {
  const currentUser = async (req: FastifyRequest): Promise<CurrentUser | null> => {
    const token = requestCredential(req)
    return token ? resolveCredential(token, store, addressOf(req)) : null
  }

  const requireUser: RouteGuard = async (req, reply): Promise<void> => {
    const user = await currentUser(req)
    if (!user) {
      await reply.code(401).send({ error: 'unauthorized' })
      return
    }
    req.user = user
  }

  /** A human dashboard session. Controller tokens carry `gatewaySn` and cannot watch. */
  const requireViewer: RouteGuard = async (req, reply): Promise<void> => {
    const user = await currentUser(req)
    if (!user) {
      await reply.code(401).send({ error: 'unauthorized' })
      return
    }
    if (user.gatewaySn) {
      await reply.code(403).send({ error: 'forbidden' })
      return
    }
    req.user = user
  }

  // Resource permissions are enforced centrally for every protected route
  // (`http/access.ts`). These two stay as aliases so a route registered before that
  // middleware existed cannot accidentally become admin-only or open.
  const requireOperator = requireViewer
  const requireAdmin = requireViewer

  /**
   * Pilot 2 before the licence check: the operator's credentials are verified but the
   * controller is not yet bound. Enough to read the DJI config, nothing else.
   */
  const requirePilotPreauth: RouteGuard = async (req, reply): Promise<void> => {
    const user = await currentUser(req)
    if (!user) {
      await reply.code(401).send({ error: 'unauthorized' })
      return
    }
    if (user.role !== 'pilot') {
      await reply.code(403).send({ error: 'forbidden' })
      return
    }
    req.user = user
  }

  /** A pilot session bound to a controller; this is what may issue MQTT credentials. */
  const requirePilot: RouteGuard = async (req, reply): Promise<void> => {
    const user = await currentUser(req)
    if (!user) {
      await reply.code(401).send({ error: 'unauthorized' })
      return
    }
    if (user.role !== 'pilot' || !user.gatewaySn || user.stage === 'preauth') {
      await reply.code(403).send({ error: 'forbidden' })
      return
    }
    req.user = user
  }

  return {
    requireUser,
    requireViewer,
    requireOperator,
    requireAdmin,
    requirePilotPreauth,
    requirePilot,
  }
}
