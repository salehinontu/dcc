import type { FastifyInstance } from 'fastify'
import { can, type Permission } from '@dji/protocol'
import type { RouteContext } from './context'

const publicRoutes = new Set([
  'GET:/api/health',
  // What the installation calls itself and its logo: drawn on the sign-in and Pilot pages.
  'GET:/api/branding',
  'GET:/api/branding/logo',
  'POST:/api/auth/login',
  // The second step of a sign-in: the caller holds only the password's proof, not a session yet.
  'POST:/api/auth/mfa',
  'POST:/api/auth/logout',
  // Pilot 2 signs in before the DJI licence is verified, so these three cannot require a
  // session. `/api/pilot/auth` issues the short-lived token the config needs; the routes
  // themselves carry `requirePilotPreauth`.
  'POST:/api/pilot/auth',
  'POST:/api/pilot/login',
  'GET:/api/pilot/config',
])
const policies: Record<string, Permission> = {
  'GET:/api/users': 'users.manage',
  'POST:/api/users': 'users.manage',
  'PATCH:/api/users/:id': 'users.manage',
  'DELETE:/api/users/:id': 'users.manage',
  'GET:/api/devices': 'drones.view',
  'PATCH:/api/devices/:sn': 'drones.rename',
  'DELETE:/api/devices/:sn': 'drones.delete',
  'GET:/api/devices/:sn/telemetry': 'telemetry.view',
  'GET:/api/devices/:sn/trail': 'telemetry.view',
  'POST:/api/devices/:sn/screenshots': 'screenshots.capture',
  'POST:/api/devices/:sn/stream/stop': 'streams.control',
  'POST:/api/devices/:sn/stream/resume': 'streams.control',
  'GET:/api/streams': 'streams.view',
  'GET:/api/streams/:id': 'streams.view',
  'PATCH:/api/streams/:id': 'streams.control',
  'POST:/api/streams/:id/whep': 'streams.view',
  'DELETE:/api/streams/:id/whep/:session': 'streams.view',
  'POST:/api/streams/:id/network': 'streams.view',
  'GET:/api/screenshots': 'screenshots.view',
  'GET:/api/screenshots/:id': 'screenshots.view',
  'GET:/api/screenshots/:id/image': 'screenshots.view',
  'GET:/api/screenshots/:id/thumbnail': 'screenshots.view',
  'GET:/api/screenshots/:id/people': 'screenshots.view',
  // The handlers also require screenshots.view on each still, and answer 404 for one the
  // account may not see.
  'DELETE:/api/screenshots/:id': 'screenshots.delete',
  'POST:/api/screenshots/delete': 'screenshots.delete',
  'POST:/api/screenshots/:id/people': 'screenshots.view',
  // The handler also requires screenshots.capture. It is not the policy here because that
  // would refuse a count on stills of an aircraft that has since been disabled.
  'PUT:/api/screenshots/:id/people/verification': 'screenshots.view',
  // Video the server records itself. The handlers filter by the drones the account may see, and a
  // clip's own routes are checked against its drone below, like a still's.
  'POST:/api/devices/:sn/recording': 'recordings.record',
  'DELETE:/api/devices/:sn/recording': 'recordings.record',
  'GET:/api/recordings': 'recordings.view',
  'GET:/api/recordings/active': 'recordings.view',
  'GET:/api/recordings/folders': 'recordings.view',
  // The tags in use, and a video's tags and note. The handler decides who may change them (whoever may record on its
  // drone, or upload); anyone who may watch the video reads them.
  'GET:/api/recordings/tags': 'recordings.view',
  'PATCH:/api/recordings/:id': 'recordings.view',
  // Automatic recording and the storage figures are for whoever may record: they decide what runs.
  'GET:/api/recordings/auto': 'recordings.record',
  'GET:/api/recordings/storage': 'recordings.record',
  'PUT:/api/devices/:sn/recording/auto': 'recordings.record',
  // Where the videos are kept is the Developer's (the vendor installs the server); see `developerOnly`.
  'GET:/api/recordings/location': 'recordings.record',
  'PUT:/api/recordings/location': 'recordings.record',
  'GET:/api/recordings/location/browse': 'recordings.record',
  'POST:/api/recordings/location/folder': 'recordings.record',
  // The audit trail: reading, exporting and checking it are one grant, and what a reader sees is scoped to their team.
  'GET:/api/audit': 'audit.view',
  'GET:/api/audit/export': 'audit.view',
  'GET:/api/audit/verify': 'audit.view',
  // Deleting lines is the vendor's alone: see `developerOnly`.
  'POST:/api/audit/delete': 'audit.view',
  'GET:/api/recordings/:id/thumbnail': 'recordings.view',
  // Uploading belongs to no drone: it is an account grant (`ACCOUNT_PERMISSIONS`).
  'PUT:/api/recordings/upload': 'recordings.upload',
  'GET:/api/recordings/:id': 'recordings.view',
  'GET:/api/recordings/:id/video': 'recordings.view',
  'DELETE:/api/recordings/:id': 'recordings.delete',
  // The handler checks each video: the grant on its drone, and an upload only for its own customer.
  'POST:/api/recordings/delete': 'recordings.delete',
  // An account's two-step sign-in, reset by whoever may manage that account (the handler checks the same limits as an edit).
  'POST:/api/users/:id/mfa/reset': 'users.manage',
  'POST:/api/zones': 'zones.manage',
  'PUT:/api/zones/:id': 'zones.manage',
  'DELETE:/api/zones/:id': 'zones.manage',
  // Reading zones is its own screen grant now; the handler still hides what the account's
  // tenant does not own (see `zoneScope`).
  'GET:/api/zones': 'zones.view',
  'GET:/api/alerts': 'alerts.view',
  'POST:/api/alerts/:id/ack': 'alerts.view',
  'GET:/api/flights': 'flights.view',
  'GET:/api/flights/:id': 'flights.view',
  'GET:/api/debug/messages': 'system.debug',
  'GET:/api/admin/controllers': 'inventory.manage',
  'POST:/api/admin/controllers/:sn/approve': 'inventory.manage',
  'POST:/api/admin/controllers/:sn/reject': 'inventory.manage',
  'POST:/api/admin/controllers/:sn/unbind': 'inventory.manage',
  'GET:/api/admin/devices': 'inventory.manage',
  'POST:/api/devices/:sn/disable': 'drones.delete',
  // Video-only drones (DJI Fly pushing RTMP). The address and key are the drone's secret, so
  // only accounts that may bind it see them.
  'GET:/api/video-sources': 'drones.bind',
  'POST:/api/video-sources': 'drones.bind',
  'POST:/api/video-sources/:sn/key': 'drones.bind',
  // The handler also needs drones.bind or drones.delete on the drone: whoever may add it may remove it.
  'DELETE:/api/video-sources/:sn': 'drones.view',
  // API access for the customer's own programs. Making and revoking tokens is its own account grant.
  'GET:/api/api-tokens': 'api.manage',
  'POST:/api/api-tokens': 'api.manage',
  'DELETE:/api/api-tokens/:id': 'api.manage',
  // What a program reads: who it is, the API's description, and a picture or the live video of a drone.
  'GET:/api/v1/whoami': 'drones.view',
  'GET:/api/v1/openapi.json': 'drones.view',
  'GET:/api/devices/:sn/frame': 'streams.view',
  'GET:/api/devices/:sn/live': 'streams.view',
}

/**
 * The only routes an API token may call, and only with GET. A token is a program's credential, not a person's: it
 * reads data (drones, telemetry, flights, alerts, zones, pictures, recordings, live video) and changes nothing, so a
 * leaked one costs the customer a view, not a drone or an account. Everything else answers 403, even where the
 * token's owner could do it.
 */
const apiTokenRoutes = new Set([
  'GET:/api/devices',
  'GET:/api/devices/:sn/telemetry',
  'GET:/api/devices/:sn/trail',
  'GET:/api/devices/:sn/frame',
  'GET:/api/devices/:sn/live',
  'GET:/api/streams',
  'GET:/api/streams/:id',
  'GET:/api/flights',
  'GET:/api/flights/:id',
  'GET:/api/alerts',
  'GET:/api/zones',
  'GET:/api/screenshots',
  'GET:/api/screenshots/:id',
  'GET:/api/screenshots/:id/image',
  'GET:/api/screenshots/:id/thumbnail',
  'GET:/api/screenshots/:id/people',
  'GET:/api/recordings',
  'GET:/api/recordings/tags',
  'GET:/api/recordings/:id',
  'GET:/api/recordings/:id/video',
  'GET:/api/recordings/:id/thumbnail',
  'GET:/api/v1/whoami',
  'GET:/api/v1/openapi.json',
])

/**
 * Routes that only one screen uses also need that screen's grant, on top of the drone right in
 * `policies`: turning a screen off for an account must close its data, not just hide the menu.
 * The Live wall, Drones and Operations map screens share their data with other screens, so they
 * are menu-only grants and are not listed.
 */
const screenPolicies: Record<string, Permission> = {
  'GET:/api/screenshots': 'shots.view',
  'GET:/api/screenshots/:id': 'shots.view',
  'GET:/api/screenshots/:id/image': 'shots.view',
  'GET:/api/screenshots/:id/thumbnail': 'shots.view',
  'GET:/api/screenshots/:id/people': 'shots.view',
  'DELETE:/api/screenshots/:id': 'shots.view',
  'POST:/api/screenshots/delete': 'shots.view',
  'POST:/api/screenshots/:id/people': 'shots.view',
  'PUT:/api/screenshots/:id/people/verification': 'shots.view',
  'GET:/api/flights': 'history.view',
  'GET:/api/flights/:id': 'history.view',
  // The Recordings screen. Its data is closed with it, whatever the drone rights say. `GET /api/recordings/active`
  // is left out on purpose: the Live wall's REC buttons read it to know what is being recorded.
  'GET:/api/recordings': 'recs.view',
  'GET:/api/recordings/folders': 'recs.view',
  'GET:/api/recordings/tags': 'recs.view',
  'PATCH:/api/recordings/:id': 'recs.view',
  'GET:/api/recordings/auto': 'recs.view',
  'GET:/api/recordings/storage': 'recs.view',
  'GET:/api/recordings/:id': 'recs.view',
  'GET:/api/recordings/:id/video': 'recs.view',
  'GET:/api/recordings/:id/thumbnail': 'recs.view',
  'DELETE:/api/recordings/:id': 'recs.view',
  'POST:/api/recordings/delete': 'recs.view',
  'PUT:/api/recordings/upload': 'recs.view',
}

/** Routes that change or read the server itself, not a customer's data: only a Developer may call them. */
const developerOnly = new Set([
  'POST:/api/audit/delete',
  'GET:/api/recordings/location',
  'PUT:/api/recordings/location',
  'GET:/api/recordings/location/browse',
  'POST:/api/recordings/location/folder',
])

/** Fail closed for new API routes: add an explicit method/path rule here. */
export function registerAccessMiddleware(app: FastifyInstance, ctx: RouteContext): void {
  app.addHook('preHandler', async (req, reply) => {
    const path = req.routeOptions.url ?? ''
    if (!path.startsWith('/api/')) return
    const route = `${req.method}:${path}`
    // Fastify's automatic HEAD routes have the same access requirement as GET.
    const policyRoute = req.method === 'HEAD' ? `GET:${path}` : route
    if (publicRoutes.has(policyRoute)) return
    await ctx.requireUser(req, reply)
    if (reply.sent) return
    const user = req.user!
    // An API token: read-only, and only the routes above (a HEAD is a GET without the body).
    if (user.apiToken) {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return reply.code(403).send({ error: 'api_token_read_only' })
      if (!apiTokenRoutes.has(policyRoute))
        return reply.code(403).send({ error: 'not_available_to_api_tokens' })
    }
    // Setting up two-step sign-in is what an account that must have it does first, so these stay open to it.
    // (The handlers refuse a Pilot and a controller token.)
    if (
      policyRoute === 'GET:/api/me' ||
      route === 'POST:/api/auth/password' ||
      route === 'POST:/api/auth/email' ||
      route === 'GET:/api/auth/mfa' ||
      route === 'POST:/api/auth/mfa/setup' ||
      route === 'POST:/api/auth/mfa/enable' ||
      route === 'POST:/api/auth/mfa/disable' ||
      route === 'POST:/api/auth/mfa/recovery-codes'
    )
      return
    if (user.mustChangePassword) return reply.code(403).send({ error: 'password_change_required' })
    // A role that must use two-step sign-in has no other route until it has set it up.
    if (user.mfaEnrolRequired) return reply.code(403).send({ error: 'mfa_enrolment_required' })
    if (route === 'GET:/api/pilot/user-info' || route === 'POST:/api/pilot/bind') {
      if (!user.gatewaySn || !can(user, 'drones.bind'))
        return reply.code(403).send({ error: 'forbidden' })
      return
    }
    if (user.gatewaySn) return reply.code(403).send({ error: 'controller token' })
    const permission = policies[policyRoute]
    if (!permission) return reply.code(403).send({ error: 'forbidden' })
    const params = req.params as { sn?: string; id?: string }
    let sn = params.sn
    if (path.startsWith('/api/screenshots/') && params.id) {
      const row = await ctx.store.getScreenshot(params.id)
      if (!row) return reply.code(404).send({ error: 'not found' })
      sn = row.device_sn
    } else if (path.startsWith('/api/recordings/') && params.id) {
      const row = await ctx.store.recordings.get(params.id)
      if (!row) return reply.code(404).send({ error: 'not found' })
      // An upload belongs to one customer: for anyone else it does not exist.
      if (
        row.source === 'upload' &&
        user.role !== 'developer' &&
        row.tenant_id !== (user.adminId ?? user.id)
      )
        return reply.code(404).send({ error: 'not found' })
      sn = row.device_sn ?? undefined
    } else if (path.startsWith('/api/streams/') && params.id) {
      const row = await ctx.store.getStream(params.id)
      if (!row) return reply.code(404).send({ error: 'not found' })
      sn = row.device_sn
    }
    if (!can(user, permission, sn)) return reply.code(403).send({ error: 'forbidden' })
    if (developerOnly.has(policyRoute) && user.role !== 'developer')
      return reply.code(403).send({ error: 'forbidden' })
    const screen = screenPolicies[policyRoute]
    if (screen && !can(user, screen)) return reply.code(403).send({ error: 'forbidden' })
    if (
      sn &&
      (['drones.rename', 'screenshots.capture', 'streams.control'].includes(permission) ||
        // Starting a recording on a removed drone is refused; stopping one must stay possible.
        (permission === 'recordings.record' && req.method !== 'DELETE') ||
        (path.startsWith('/api/streams/') && req.method !== 'DELETE')) &&
      (await ctx.store.deviceUnavailable(sn))
    ) {
      return reply.code(410).send({ error: 'drone deleted' })
    }
    // The raw MQTT log is fleet-wide, so scoped users must never read it.
    if (permission === 'system.debug' && !user.allDrones && user.role !== 'developer')
      return reply.code(403).send({ error: 'forbidden' })
  })
}
