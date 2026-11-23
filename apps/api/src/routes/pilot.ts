import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { hashPassword, issueSession, publicUser, verifyPassword } from '../auth'
import { config } from '../config'
import { can } from '@dji/protocol'
import type { RouteContext } from '../http/context'
import { noteAudit } from '../http/audit'
import { countWrongPassword, lockedUntil, lockMessage } from '../http/lockout'

const controllerSnSchema = z
  .string()
  .min(4)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'invalid controller serial')

/**
 * The Pilot 2 boot order is: verify the DJI licence, read the controller serial, then bind.
 * The licence values come from `/api/pilot/config`, and the page cannot render its login form
 * without them, so the config cannot require the pilot session it is needed to create.
 *
 * The split is therefore:
 *   POST /api/pilot/auth      credentials only          -> short-lived pre-auth token
 *   GET  /api/pilot/config    pre-auth token            -> DJI App ID / Key / Licence
 *   ...platformVerifyLicense, platformGetRemoteControllerSN...
 *   POST /api/pilot/login     pre-auth token + serial   -> pilot token, or "pending"
 *   GET  /api/pilot/user-info pilot token, approved     -> per-controller MQTT credentials
 */
export function registerPilotRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, requirePilotPreauth, requirePilot } = ctx

  function noStore(reply: FastifyReply): FastifyReply {
    return reply.header('cache-control', 'no-store').header('pragma', 'no-cache')
  }

  app.post(
    '/api/pilot/auth',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = z
        .object({
          username: z.string().min(3),
          password: z.string().min(1),
          flag: z.number().optional(),
        })
        .safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ code: 1, message: 'invalid body' })

      const user = await store.findUserByEmail(parsed.data.username)
      // The same lock-out as the dashboard sign-in: a controller is no way round it.
      const locked = user ? lockedUntil(user) : null
      if (locked) {
        noteAudit(req, { details: { locked: true } })
        return reply.code(429).send({ code: 1, message: lockMessage(locked) })
      }
      if (
        !user ||
        user.disabled ||
        !(await verifyPassword(user.password_hash, parsed.data.password))
      ) {
        const lock = await countWrongPassword(store, user)
        if (lock) {
          noteAudit(req, { details: { locked: true } })
          return reply.code(429).send({ code: 1, message: lockMessage(lock) })
        }
        return reply.code(401).send({ code: 1, message: 'invalid credentials' })
      }
      await store.clearLoginFailures(user.id)
      // A dashboard account must never be able to bind a controller. The pilot role is the
      // only one allowed to take the controller branch of the product.
      if (user.role !== 'pilot') {
        return reply.code(403).send({ code: 1, message: 'a drone operator account is required' })
      }

      // Their two gates, kept: a temporary password and a role without `drones.bind` both
      // stop the controller before any token is issued.
      if (user.must_change_password) {
        return reply.code(403).send({
          code: 1,
          message: 'Sign in to the dashboard and change your temporary password first.',
        })
      }
      if (!can(publicUser(user), 'drones.bind')) {
        return reply.code(403).send({ code: 1, message: 'Drone binding permission required.' })
      }

      const token = await issueSession(
        // Carry the row's session version: after the mandatory first password change it is no
        // longer 0, and a token claiming 0 would be rejected on its very next request.
        {
          id: user.id,
          email: user.email,
          role: user.role,
          sessionVersion: user.session_version,
          stage: 'preauth',
        },
        store,
        '5m',
      )
      return noStore(reply).send({
        code: 0,
        message: 'success',
        data: { access_token: token, user_id: user.id, username: user.email },
      })
    },
  )

  app.get(
    '/api/pilot/config',
    {
      preHandler: requirePilotPreauth,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (_req, reply) =>
      noStore(reply).send({
        code: 0,
        message: 'success',
        data: {
          appId: config.dji.appId,
          appKey: config.dji.appKey,
          license: config.dji.license,
          platformName: config.dji.platformName,
          workspaceId: config.dji.workspaceId,
          workspaceName: config.dji.workspaceName,
        },
      }),
  )

  app.post(
    '/api/pilot/login',
    {
      preHandler: requirePilotPreauth,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const user = req.user!
      const parsed = z
        .object({ controllerSn: controllerSnSchema, flag: z.number().optional() })
        .safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ code: 1, message: 'invalid body' })

      const controllerSn = parsed.data.controllerSn
      const enrollment = await store.enrollmentFor(controllerSn)

      if (!enrollment) {
        // First contact: record the request and wait for an admin. No credential is issued
        // in this state, so the controller cannot reach the broker or the fleet.
        await store.createPendingEnrollment(controllerSn, user.id, config.dji.workspaceId)
        await store
          .logDeviceEvent(controllerSn, 'controller.requested', { email: user.email })
          .catch(() => undefined)
        return noStore(reply)
          .code(403)
          .send({
            code: 2,
            message: 'awaiting approval',
            data: { status: 'pending', controller_sn: controllerSn },
          })
      }

      if (enrollment.status === 'rejected') {
        await store.touchEnrollment(controllerSn)
        return noStore(reply)
          .code(403)
          .send({
            code: 3,
            message: enrollment.note || 'controller rejected',
            data: { status: 'rejected', controller_sn: controllerSn },
          })
      }

      if (enrollment.status === 'pending') {
        await store.touchEnrollment(controllerSn)
        return noStore(reply)
          .code(403)
          .send({
            code: 2,
            message: 'awaiting approval',
            data: { status: 'pending', controller_sn: controllerSn },
          })
      }

      await store.touchEnrollment(controllerSn)
      // Re-read the row so the token carries current grants, not a copy from the pre-auth token.
      const rowUser = await store.findUserById(user.id)
      const token = await issueSession(
        {
          ...(rowUser ? publicUser(rowUser) : user),
          gatewaySn: controllerSn,
        },
        store,
      )

      return noStore(reply).send({
        code: 0,
        message: 'success',
        data: {
          access_token: token,
          user_id: user.id,
          username: user.email,
          workspace_id: config.dji.workspaceId,
          controller_sn: controllerSn,
          status: 'approved',
        },
      })
    },
  )

  app.get(
    '/api/pilot/user-info',
    {
      preHandler: requirePilot,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const user = req.user!
      const gatewaySn = user.gatewaySn!

      // Checked again here, not only when the token was signed: an approval can be withdrawn
      // while a token is still valid.
      const enrollment = await store.enrollmentFor(gatewaySn)
      if (!enrollment || enrollment.status !== 'approved') {
        return noStore(reply)
          .code(403)
          .send({
            code: 1,
            message: 'controller is not approved',
            data: { status: enrollment?.status ?? 'unknown', controller_sn: gatewaySn },
          })
      }

      const username = `gw_${gatewaySn}`
      const password = randomBytes(24).toString('base64url')
      const expiresAt = new Date(Date.now() + config.mqttCredentialTtlHours * 3_600_000)

      // The credential records whose account it belongs to and at which session version, so a
      // demotion, a password reset or a disable cuts the MQTT connection on the next check.
      await store.upsertGatewayCredential(
        gatewaySn,
        username,
        await hashPassword(password),
        expiresAt,
        user.id,
        user.sessionVersion,
      )
      // The credential is re-issued for an approved controller only, so a payload from
      // `user-info` can never be used to undo an admin revoke.
      await store
        .logDeviceEvent(gatewaySn, 'controller.credential_issued', { email: user.email })
        .catch(() => undefined)

      return noStore(reply).send({
        code: 0,
        message: 'success',
        data: {
          user_id: user.id,
          username: user.email,
          workspace_id: config.dji.workspaceId,
          controller_sn: gatewaySn,
          mqtt_addr: config.mqttPublicHost,
          mqtt_username: username,
          mqtt_password: password,
          mqtt_expires_at: expiresAt.toISOString(),
        },
      })
    },
  )

  // An explicit authenticated RC bind. The enrolment already decided which aircraft this
  // controller may own, so a bind can only restore a pairing that enrolment allows and that
  // the device was soft-deleted from. It never transfers an aircraft to a different
  // controller.
  app.post('/api/pilot/bind', { preHandler: requirePilot }, async (req, reply) => {
    const user = req.user!
    const body = z
      .object({
        deviceSn: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,64}$/)
          .optional(),
      })
      .safeParse(req.body ?? {})
    if (!body.success) return noStore(reply).code(400).send({ code: 1, message: 'invalid serial' })

    if (body.data.deviceSn) {
      if (!can(user, 'drones.bind', body.data.deviceSn)) {
        return noStore(reply).code(403).send({ code: 1, message: 'forbidden drone' })
      }
      const allowed = await store.aircraftSnsForController(user.gatewaySn!)
      if (allowed.length > 0 && !allowed.includes(body.data.deviceSn)) {
        return noStore(reply).code(403).send({ code: 1, message: 'drone not enrolled' })
      }
      const rebound = await store.rebindDevice(body.data.deviceSn, user.gatewaySn!, user.id)
      if (!rebound) {
        return noStore(reply).code(404).send({ code: 1, message: 'unknown or deleted drone' })
      }
    }
    await store.upsertGateway(user.gatewaySn!, config.dji.workspaceId, null)
    return noStore(reply).send({ code: 0, message: 'success' })
  })
}
