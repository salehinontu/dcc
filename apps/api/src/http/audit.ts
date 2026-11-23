import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuditOutcome } from '@dji/protocol'
import type { AuditEntry } from '../audit'
import { stableStringify } from '../audit'
import type { CurrentUser } from '../auth'
import type { RouteContext } from './context'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** What an audited route is called, what it acts on, and how its caller is known. */
interface RouteAudit {
  action: string
  /** The kind of thing the route acts on, and the route parameter that names it. */
  target?: [type: string, param: string]
  /** For a GET: whether this request is worth a line (a play, a download), given its status. */
  when?: (req: FastifyRequest, status: number) => boolean
  /** The caller is not signed in: who they are comes from this field of the body. */
  loginField?: 'email' | 'username'
  /** A step of signing in whose 401 is a wrong answer (a wrong code), not a refusal. */
  signin?: boolean
  /** Leave the body out of the details (it carries a password, a file, or a list that says nothing). */
  noBody?: boolean
}

const isDownload = (req: FastifyRequest): boolean =>
  (req.query as { download?: string } | undefined)?.download === '1'

/**
 * Every route that changes something is in the trail whether or not it is listed here: an unlisted one is
 * recorded under a generic name, so a route added later cannot slip past. This table gives the routes people
 * ask about a readable code, says what each one acts on, and picks the views worth recording.
 */
const ROUTES: Record<string, RouteAudit> = {
  'POST:/api/auth/login': { action: 'auth.login', loginField: 'email', noBody: true },
  // The second step of a sign-in: the route names who it was, since nobody is signed in yet. Never the code.
  'POST:/api/auth/mfa': { action: 'auth.login', signin: true, noBody: true },
  'POST:/api/auth/mfa/setup': { action: 'auth.mfa_setup_started', noBody: true },
  'POST:/api/auth/mfa/enable': { action: 'auth.mfa_enabled', noBody: true },
  'POST:/api/auth/mfa/disable': { action: 'auth.mfa_disabled', noBody: true },
  'POST:/api/auth/mfa/recovery-codes': { action: 'auth.mfa_recovery_codes', noBody: true },
  'POST:/api/users/:id/mfa/reset': {
    action: 'user.mfa_reset',
    target: ['user', 'id'],
    noBody: true,
  },
  'POST:/api/auth/logout': { action: 'auth.logout', noBody: true },
  'POST:/api/auth/password': { action: 'auth.password_changed', noBody: true },
  'POST:/api/auth/email': { action: 'auth.email_changed', noBody: true },
  'POST:/api/pilot/auth': { action: 'pilot.login', loginField: 'username', noBody: true },
  'POST:/api/pilot/login': { action: 'pilot.controller_login' },
  'GET:/api/pilot/user-info': {
    action: 'pilot.credentials_issued',
    when: (_req, status) => status < 400,
  },
  'POST:/api/pilot/bind': { action: 'pilot.bind' },
  'POST:/api/users': { action: 'user.created', noBody: true },
  'PATCH:/api/users/:id': { action: 'user.updated', target: ['user', 'id'], noBody: true },
  'DELETE:/api/users/:id': { action: 'user.deleted', target: ['user', 'id'] },
  'POST:/api/admin/controllers/:sn/approve': {
    action: 'controller.approved',
    target: ['controller', 'sn'],
  },
  'POST:/api/admin/controllers/:sn/reject': {
    action: 'controller.rejected',
    target: ['controller', 'sn'],
  },
  'POST:/api/admin/controllers/:sn/unbind': {
    action: 'controller.unbound',
    target: ['controller', 'sn'],
  },
  'PATCH:/api/devices/:sn': { action: 'drone.updated', target: ['drone', 'sn'] },
  'DELETE:/api/devices/:sn': { action: 'drone.deleted', target: ['drone', 'sn'] },
  'POST:/api/devices/:sn/disable': { action: 'drone.disabled', target: ['drone', 'sn'] },
  'POST:/api/video-sources': { action: 'video_source.created' },
  'POST:/api/video-sources/:sn/key': {
    action: 'video_source.rekeyed',
    target: ['drone', 'sn'],
    noBody: true,
  },
  'DELETE:/api/video-sources/:sn': { action: 'video_source.deleted', target: ['drone', 'sn'] },
  'POST:/api/streams/:id/whep': { action: 'stream.viewed', target: ['stream', 'id'], noBody: true },
  'POST:/api/devices/:sn/stream/stop': { action: 'stream.stopped', target: ['drone', 'sn'] },
  'POST:/api/devices/:sn/stream/resume': { action: 'stream.resumed', target: ['drone', 'sn'] },
  'PATCH:/api/streams/:id': { action: 'stream.updated', target: ['stream', 'id'] },
  'POST:/api/devices/:sn/screenshots': {
    action: 'screenshot.captured',
    target: ['drone', 'sn'],
    noBody: true,
  },
  'DELETE:/api/screenshots/:id': { action: 'screenshot.deleted', target: ['screenshot', 'id'] },
  'POST:/api/screenshots/delete': { action: 'screenshot.deleted' },
  'POST:/api/screenshots/:id/people': {
    action: 'screenshot.people_counted',
    target: ['screenshot', 'id'],
  },
  'PUT:/api/screenshots/:id/people/verification': {
    action: 'screenshot.people_verified',
    target: ['screenshot', 'id'],
  },
  'GET:/api/screenshots/:id/image': {
    action: 'screenshot.downloaded',
    target: ['screenshot', 'id'],
    when: (req, status) => status < 400 && isDownload(req),
  },
  'POST:/api/devices/:sn/recording': { action: 'recording.started', target: ['drone', 'sn'] },
  'DELETE:/api/devices/:sn/recording': { action: 'recording.stopped', target: ['drone', 'sn'] },
  'PUT:/api/devices/:sn/recording/auto': {
    action: 'recording.auto_changed',
    target: ['drone', 'sn'],
  },
  'PUT:/api/recordings/upload': { action: 'recording.uploaded', noBody: true },
  'DELETE:/api/recordings/:id': { action: 'recording.deleted', target: ['recording', 'id'] },
  'PATCH:/api/recordings/:id': {
    action: 'recording.annotated',
    target: ['recording', 'id'],
    noBody: true,
  },
  'POST:/api/recordings/delete': { action: 'recording.deleted', noBody: true },
  // The route writes its own success line, before it deletes; this one only catches a refusal or a failure.
  'POST:/api/audit/delete': {
    action: 'audit.deleted',
    noBody: true,
    when: (_req, status) => status >= 400,
  },
  'GET:/api/recordings/:id/video': {
    action: 'recording.played',
    target: ['recording', 'id'],
    when: (_req, status) => status < 400,
  },
  'PUT:/api/recordings/location': { action: 'recording.location_changed' },
  'POST:/api/recordings/location/folder': { action: 'recording.folder_created' },
  'POST:/api/zones': { action: 'zone.created', noBody: true },
  'PUT:/api/zones/:id': { action: 'zone.updated', target: ['zone', 'id'], noBody: true },
  'DELETE:/api/zones/:id': { action: 'zone.deleted', target: ['zone', 'id'] },
  'POST:/api/alerts/:id/ack': { action: 'alert.acknowledged', target: ['alert', 'id'] },
  // API access: making and revoking tokens, and a program opening a drone's live video or taking pictures from it.
  'POST:/api/api-tokens': { action: 'api_token.created' },
  'DELETE:/api/api-tokens/:id': { action: 'api_token.revoked', target: ['api_token', 'id'] },
  'GET:/api/devices/:sn/live': {
    action: 'stream.viewed',
    target: ['drone', 'sn'],
    when: (_req, status) => status < 400,
  },
  // A program asks for pictures again and again: one line per credential and drone every ten minutes.
  'GET:/api/devices/:sn/frame': {
    action: 'stream.frame',
    target: ['drone', 'sn'],
    when: (_req, status) => status < 400,
  },
}

/** Plumbing the browser or the media server calls on its own, not something a person did. */
const NOT_AUDITED = new Set([
  'POST:/api/streams/:id/network',
  'DELETE:/api/streams/:id/whep/:session',
])

/** A key that may hold a secret: its value is never written down. */
const SECRET_KEY =
  /pass|secret|token|key|credential|authorization|cookie|licen[sc]e|sdp|totp|otp|recovery|^code$/i

/** A request body or query, cut down to what is worth reading and with every secret removed. */
export function summarize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.length > 20
      ? { count: value.length, first: value.slice(0, 5).map((item) => summarize(item, depth + 1)) }
      : value.map((item) => summarize(item, depth + 1))
  }
  if (typeof value === 'object') {
    if (depth >= 3) return '[object]'
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40))
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : summarize(item, depth + 1)
    return out
  }
  return String(value)
}

const INSIDE =
  /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01]))\.|f[cd])/i

/**
 * Where a request came from. Reached from outside the server (the usual case is straight from the internet
 * to Nginx), the address is the connection's own. Reached through Nginx, it is what Nginx saw: it adds the
 * peer's address to the END of X-Forwarded-For, after whatever the client wrote there, so the address is read
 * from the right, skipping our own network. A client that fills the header with a false address only puts it
 * on the left, where it is never read.
 */
export function clientIp(req: FastifyRequest): string {
  const direct = req.ip
  if (!INSIDE.test(direct)) return direct
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^[0-9a-f:.]{3,45}$/i.test(part))
  for (let i = forwarded.length - 1; i >= 0; i--)
    if (!INSIDE.test(forwarded[i]!)) return forwarded[i]!
  return forwarded.at(-1) ?? direct
}

/** What changed in an account: the grants it gained and lost, a role, a disable, a password reset. */
function accountChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  passwordReset: boolean,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {}
  for (const [key, label] of [
    ['role', 'role'],
    ['disabled', 'disabled'],
    ['all_drones', 'allDrones'],
  ] as const)
    if (before[key] !== after[key]) changes[label] = [before[key], after[key]]
  const was = new Set((before.permissions as string[]) ?? [])
  const now = new Set((after.permissions as string[]) ?? [])
  const added = [...now].filter((p) => !was.has(p))
  const removed = [...was].filter((p) => !now.has(p))
  if (added.length > 0) changes.permissionsAdded = added
  if (removed.length > 0) changes.permissionsRemoved = removed
  if (stableStringify(before.drone_permissions) !== stableStringify(after.drone_permissions))
    changes.droneAccessChanged = true
  if (passwordReset) changes.passwordReset = true
  return changes
}

const tenantOf = (user: CurrentUser): string | null =>
  user.role === 'developer' ? null : (user.adminId ?? user.id)

/** What a handler adds to its own audit line, because only it knows (the names of what a bulk delete removed). */
export interface AuditNote {
  /** Replaces the action the route is listed under (a sign-in that has only got as far as its password). */
  action?: string
  /** Who it was, for a request that is not signed in yet (the second step of a sign-in). */
  actor?: { id: string; email: string; role: string; tenantId: string | null }
  targetType?: string
  targetLabel?: string
  details?: Record<string, unknown>
}
const notes = new WeakMap<FastifyRequest, AuditNote>()
export function noteAudit(req: FastifyRequest, note: AuditNote): void {
  notes.set(req, note)
}

/**
 * Writes the audit trail for every request that changes something, every refusal, every sign-in and the views
 * worth keeping (opening a live feed, playing or downloading a recording). It runs on the response, so it
 * records how the request ended, and it never delays or fails the request.
 */
export function registerAuditHooks(app: FastifyInstance, ctx: RouteContext): void {
  const audit = ctx.audit
  if (!audit) return

  // What the target was before the handler ran: a delete removes it, an edit changes it.
  const before = new WeakMap<
    FastifyRequest,
    { label: string | null; tenantId?: string | null; row?: Record<string, unknown> }
  >()
  // A play asks for the file in many ranges: one line per person and recording every ten minutes.
  const recentPlays = new Map<string, number>()

  function routeOf(req: FastifyRequest): { key: string; spec: RouteAudit | null } | null {
    const url = req.routeOptions.url
    if (!url || !url.startsWith('/api/')) return null
    const method = req.method === 'HEAD' ? 'GET' : req.method
    const key = `${method}:${url}`
    if (NOT_AUDITED.has(key)) return null
    const spec = ROUTES[key] ?? null
    if (spec) return { key, spec }
    // Anything else that changes something is recorded under a generic name.
    return MUTATING.has(method) ? { key, spec: null } : null
  }

  app.addHook('preHandler', async (req) => {
    const found = routeOf(req)
    if (!found?.spec?.target || !MUTATING.has(req.method)) return
    const [type, param] = found.spec.target
    const id = (req.params as Record<string, string> | undefined)?.[param]
    if (!id) return
    try {
      const label = await audit.labelFor(type, id)
      if (label) before.set(req, label)
    } catch {
      // A line without a label is better than a request that fails.
    }
  })

  app.addHook('onResponse', async (req, reply) => {
    try {
      const found = routeOf(req)
      if (!found) return
      const { key, spec } = found
      const status = reply.statusCode
      if (spec?.when && !spec.when(req, status)) return

      const params = (req.params ?? {}) as Record<string, string>
      // One play line per person, recording and ten minutes; seeking inside it adds nothing.
      if (spec?.action === 'stream.frame') {
        const seen = `${req.user?.apiToken?.id ?? req.user?.id ?? req.ip}:${params.sn}:frame`
        const last = recentPlays.get(seen) ?? 0
        if (Date.now() - last < 10 * 60_000) return
        recentPlays.set(seen, Date.now())
        if (recentPlays.size > 5000) recentPlays.clear()
      }
      if (spec?.action === 'recording.played') {
        const download = isDownload(req)
        const play = `${req.user?.id ?? req.ip}:${params.id}:${download ? 'd' : 'p'}`
        const last = recentPlays.get(play) ?? 0
        if (Date.now() - last < 10 * 60_000) return
        recentPlays.set(play, Date.now())
        if (recentPlays.size > 5000) recentPlays.clear()
      }

      const jsonBody =
        typeof req.body === 'object' &&
        req.body !== null &&
        !Array.isArray(req.body) &&
        String(req.headers['content-type'] ?? '').includes('json')
          ? (req.body as Record<string, unknown>)
          : null

      let action = spec?.action ?? `request.${key.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`
      if (action === 'recording.played' && isDownload(req)) action = 'recording.downloaded'
      // 401 and 403 are a refusal, except at a sign-in, where 401 is a wrong password: a failure, not a denial.
      const outcome: AuditOutcome =
        status < 400
          ? 'success'
          : (status === 401 || status === 403) && !spec?.loginField && !spec?.signin
            ? 'denied'
            : 'failure'

      const entry: AuditEntry = {
        action,
        outcome,
        status,
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] ?? '') || null,
      }

      // Who: the signed-in account, or for a sign-in the account the attempt names.
      const user = req.user
      if (user) {
        entry.actorId = user.id
        entry.actorEmail = user.email
        entry.actorRole = user.role
        entry.tenantId = tenantOf(user)
      } else if (spec?.loginField && jsonBody) {
        const named = String(jsonBody[spec.loginField] ?? '')
          .trim()
          .toLowerCase()
          .slice(0, 254)
        entry.actorEmail = named || null
        const known = named ? await audit.userByEmail(named) : null
        if (known) {
          entry.actorId = known.id
          entry.actorRole = known.role
          entry.tenantId = known.tenantId
        }
      }

      // What: the thing acted on, as it was named when it happened.
      const details: Record<string, unknown> = {}
      if (spec?.target) {
        const [type, param] = spec.target
        entry.targetType = type
        entry.targetId = params[param] ?? null
        const named = before.get(req)
        // What a Developer does is the vendor's own business, even to a customer's account: its lines carry no
        // tenant, so no customer reads them (and `AuditLog.where` leaves them out of a team's view regardless).
        if (named) entry.targetLabel = named.label
      }

      if (key === 'POST:/api/users' && jsonBody && status < 400) {
        const made = await audit.userByEmail(String(jsonBody.email ?? ''))
        entry.targetType = 'user'
        entry.targetLabel = String(jsonBody.email ?? '').toLowerCase()
        if (made) entry.targetId = made.id
        details.role = jsonBody.role ?? null
        details.allDrones = jsonBody.allDrones ?? null
        details.permissions = Array.isArray(jsonBody.permissions) ? jsonBody.permissions.length : 0
      }

      // A zone is named in what was drawn or changed, though the line has no id for a zone that was not made.
      if ((key === 'POST:/api/zones' || key === 'PUT:/api/zones/:id') && jsonBody) {
        const name = String(jsonBody.name ?? '').slice(0, 200)
        if (key === 'POST:/api/zones') {
          entry.targetType = 'zone'
          entry.targetLabel = name || null
        }
        details.zone = summarize({
          name,
          kind: jsonBody.kind,
          enabled: jsonBody.enabled,
          bufferM: jsonBody.bufferM,
        })
      }

      if (key === 'PATCH:/api/users/:id' && status < 400 && params.id) {
        const after = await audit.labelFor('user', params.id)
        const was = before.get(req)?.row
        if (after?.row && was) {
          Object.assign(details, {
            changes: accountChanges(was, after.row, Boolean(jsonBody?.password)),
          })
        }
      }

      if (key === 'POST:/api/auth/login' && status === 429) details.throttled = true
      if ((key === 'POST:/api/pilot/login' || key === 'POST:/api/pilot/bind') && jsonBody) {
        if (typeof jsonBody.controllerSn === 'string') details.controllerSn = jsonBody.controllerSn
        if (typeof jsonBody.deviceSn === 'string') details.deviceSn = jsonBody.deviceSn
      }
      if (!spec) details.route = req.routeOptions.url
      if (spec && !spec.noBody && jsonBody) details.request = summarize(jsonBody)
      const query = req.query as Record<string, unknown> | undefined
      if (key === 'PUT:/api/recordings/upload' && query)
        details.request = summarize({
          folder: query.folder,
          title: query.title,
          file: query.file,
          sn: query.sn,
        })
      // Who did it with a token: the account that owns it, and which token.
      if (req.user?.apiToken) details.apiToken = req.user.apiToken.name
      if (status >= 400) {
        const body = jsonBody
        if (body === null && !spec?.loginField && !spec?.signin) details.failed = true
      }
      const note = notes.get(req)
      if (note) {
        if (note.action) entry.action = note.action
        if (note.actor && !entry.actorId) {
          entry.actorId = note.actor.id
          entry.actorEmail = note.actor.email
          entry.actorRole = note.actor.role
          entry.tenantId = note.actor.role === 'developer' ? null : note.actor.tenantId
        }
        if (note.targetType) entry.targetType = note.targetType
        if (note.targetLabel) entry.targetLabel = note.targetLabel
        Object.assign(details, note.details)
      }
      if (Object.keys(details).length > 0) entry.details = details

      audit.record(entry)
    } catch (error) {
      req.log.error(error, 'audit hook failed')
    }
  })
}
