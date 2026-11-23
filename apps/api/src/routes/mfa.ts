import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import QRCode from 'qrcode'
import { z } from 'zod'
import { issueSession, publicUser, verifyMfaChallenge, verifyPassword } from '../auth'
import { config } from '../config'
import { noteAudit } from '../http/audit'
import type { RouteContext } from '../http/context'
import {
  checkSecondFactor,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  mfaRequiredFor,
  normalizeRecoveryCode,
  openSecret,
  otpauthUrl,
  sealSecret,
  verifyTotp,
} from '../mfa'
import type { UserRow } from '../store'
import { setSessionCookies } from './auth'

const noStore = { 'cache-control': 'no-store', pragma: 'no-cache' }
const limit = { rateLimit: { max: 10, timeWindow: '1 minute' } }

/** Ten new recovery codes: the text to show once, and the hashes to keep. */
function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = generateRecoveryCodes()
  return { codes, hashes: codes.map((code) => hashRecoveryCode(normalizeRecoveryCode(code)!)) }
}

const minutesLeft = (until: Date | string): number =>
  Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60_000))

/**
 * Two-step sign-in (see `mfa.ts`): the second step of a sign-in, and an account setting it up, turning it off and
 * making new recovery codes. Setting up, turning off and new codes all ask for the password again, so a session left
 * open on a shared computer cannot be used to take the account over or to shut the protection off.
 */
export function registerMfaRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, hub, whep } = ctx

  /** The account behind the caller, or a refusal: a Pilot signs in on a controller and has no second step. */
  async function self(req: FastifyRequest, reply: FastifyReply): Promise<UserRow | null> {
    const user = req.user!
    if (user.role === 'pilot' || user.gatewaySn) {
      await reply
        .headers(noStore)
        .code(403)
        .send({ error: 'Two-step sign-in is not available for this account.' })
      return null
    }
    const row = await store.findUserById(user.id)
    if (!row) {
      await reply.headers(noStore).code(401).send({ error: 'account unavailable' })
      return null
    }
    return row
  }

  /**
   * One wrong code counts against the account; the fifth in a row locks the second step for a few minutes (so six
   * digits cannot be guessed), and a locked account is refused even a right code until the lock ends. True when the
   * reply has been sent.
   */
  async function refuseIfLocked(row: UserRow, reply: FastifyReply): Promise<boolean> {
    if (row.totp_locked_until && new Date(row.totp_locked_until).getTime() > Date.now()) {
      const minutes = minutesLeft(row.totp_locked_until)
      await reply
        .headers(noStore)
        .code(429)
        .send({
          error: `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        })
      return true
    }
    return false
  }

  async function wrongCode(row: UserRow, reply: FastifyReply, message: string): Promise<void> {
    const lock = await store.recordTotpFailure(
      row.id,
      config.mfa.maxFailures,
      config.mfa.lockSeconds,
    )
    await reply
      .headers(noStore)
      .code(lock ? 429 : 400)
      .send({
        error: lock ? `Too many wrong codes. Try again in ${minutesLeft(lock)} minutes.` : message,
      })
  }

  // --- the second step of a sign-in -------------------------------------------------------------------------------

  app.post('/api/auth/mfa', { config: limit }, async (req, reply) => {
    const body = z
      .object({ token: z.string().min(20).max(2000), code: z.string().min(6).max(40) })
      .safeParse(req.body)
    if (!body.success) return reply.headers(noStore).code(400).send({ error: 'invalid request' })
    const claims = await verifyMfaChallenge(body.data.token)
    const row = claims ? await store.findUserById(claims.id) : null
    // The proof is void if the password or role changed since it was given, or the account was turned off.
    if (
      !claims ||
      !row ||
      row.disabled ||
      row.session_version !== claims.sessionVersion ||
      !row.totp_enabled_at
    )
      return reply
        .headers(noStore)
        .code(401)
        .send({ error: 'This sign-in has expired. Enter your password again.' })

    const actor = {
      id: row.id,
      email: row.email,
      role: row.role,
      tenantId: row.role === 'admin' ? row.id : row.admin_id,
    }
    if (row.totp_locked_until && new Date(row.totp_locked_until).getTime() > Date.now()) {
      noteAudit(req, { actor, details: { mfa: 'locked' } })
      const minutes = minutesLeft(row.totp_locked_until)
      return reply
        .headers(noStore)
        .code(429)
        .send({
          error: `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        })
    }

    const result = await checkSecondFactor(store, row, body.data.code)
    if (!result.ok) {
      const lock = await store.recordTotpFailure(
        row.id,
        config.mfa.maxFailures,
        config.mfa.lockSeconds,
      )
      noteAudit(req, { actor, details: { mfa: lock ? 'wrong code, locked' : 'wrong code' } })
      return reply
        .headers(noStore)
        .code(lock ? 429 : 401)
        .send({
          error: lock
            ? `Too many wrong codes. Try again in ${minutesLeft(lock)} minutes.`
            : 'That code is not right. Check the time on your phone, or use a recovery code.',
        })
    }

    noteAudit(req, { actor, details: { mfa: result.method } })
    setSessionCookies(reply, await issueSession(publicUser(row), store))
    return reply.headers(noStore).send({
      user: publicUser((await store.findUserById(row.id))!),
      method: result.method,
      recoveryCodesLeft: await store.recoveryCodesLeft(row.id),
    })
  })

  // --- an account's own two-step sign-in ---------------------------------------------------------------------------

  app.get('/api/auth/mfa', async (req, reply) => {
    const row = await self(req, reply)
    if (!row) return
    return reply.headers(noStore).send({
      enabled: row.totp_enabled_at != null,
      required: mfaRequiredFor(row.role),
      enabledAt: row.totp_enabled_at ? new Date(row.totp_enabled_at).toISOString() : null,
      recoveryCodesLeft: row.totp_enabled_at ? await store.recoveryCodesLeft(row.id) : 0,
    })
  })

  // Starts a set-up: a new secret, kept (sealed) until the account proves it holds the app. Asks for the password.
  app.post('/api/auth/mfa/setup', { config: limit }, async (req, reply) => {
    const row = await self(req, reply)
    if (!row) return
    const body = z.object({ password: z.string().min(1) }).safeParse(req.body)
    if (!body.success) return reply.headers(noStore).code(400).send({ error: 'invalid request' })
    if (!(await verifyPassword(row.password_hash, body.data.password)))
      return reply.headers(noStore).code(400).send({ error: 'password is incorrect' })
    if (row.totp_enabled_at)
      return reply
        .headers(noStore)
        .code(409)
        .send({ error: 'Two-step sign-in is already on. Turn it off first to set it up again.' })
    const secret = generateTotpSecret()
    await store.setPendingTotp(row.id, sealSecret(secret))
    const url = otpauthUrl(config.mfa.issuer, row.email, secret)
    return reply.headers(noStore).send({
      secret,
      otpauthUrl: url,
      qr: await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 232 }),
    })
  })

  // Proves the app holds the secret: the first code it shows turns the protection on and hands out the recovery codes.
  app.post('/api/auth/mfa/enable', { config: limit }, async (req, reply) => {
    const row = await self(req, reply)
    if (!row) return
    const body = z.object({ code: z.string().min(6).max(12) }).safeParse(req.body)
    if (!body.success) return reply.headers(noStore).code(400).send({ error: 'invalid request' })
    if (row.totp_enabled_at)
      return reply.headers(noStore).code(409).send({ error: 'Two-step sign-in is already on.' })
    const pending = openSecret(row.totp_pending_secret)
    if (!pending)
      return reply
        .headers(noStore)
        .code(400)
        .send({ error: 'Start the set-up again to get a new code to scan.' })
    if (await refuseIfLocked(row, reply)) return
    const step = verifyTotp(pending, body.data.code.replace(/\s/g, ''))
    if (step === null)
      return wrongCode(
        row,
        reply,
        'That code is not right. Check the time on your phone and try the next one.',
      )
    const { codes, hashes } = newRecoveryCodes()
    if (!(await store.enableTotp(row.id, step, hashes)))
      return reply.headers(noStore).code(409).send({ error: 'Two-step sign-in is already on.' })
    return reply.headers(noStore).send({ ok: true, recoveryCodes: codes })
  })

  /** The password and a current code (or a recovery code): what turning it off or making new codes takes. */
  async function confirmed(req: FastifyRequest, reply: FastifyReply): Promise<UserRow | null> {
    const row = await self(req, reply)
    if (!row) return null
    const body = z
      .object({ password: z.string().min(1), code: z.string().min(6).max(40) })
      .safeParse(req.body)
    if (!body.success) {
      await reply.headers(noStore).code(400).send({ error: 'invalid request' })
      return null
    }
    if (!row.totp_enabled_at) {
      await reply.headers(noStore).code(409).send({ error: 'Two-step sign-in is not on.' })
      return null
    }
    if (!(await verifyPassword(row.password_hash, body.data.password))) {
      await reply.headers(noStore).code(400).send({ error: 'password is incorrect' })
      return null
    }
    if (await refuseIfLocked(row, reply)) return null
    const result = await checkSecondFactor(store, row, body.data.code)
    if (!result.ok) {
      await wrongCode(row, reply, 'That code is not right.')
      return null
    }
    return row
  }

  app.post('/api/auth/mfa/disable', { config: limit }, async (req, reply) => {
    const user = req.user!
    // A role that must have it cannot switch it off: that is the point of making it mandatory.
    if (mfaRequiredFor(user.role))
      return reply
        .headers(noStore)
        .code(403)
        .send({ error: 'Your organisation requires two-step sign-in, so it cannot be turned off.' })
    const row = await confirmed(req, reply)
    if (!row) return
    await store.disableTotp(row.id)
    // Every other device is signed out: whoever else held a session is no longer vouched for. This one stays.
    await store.revokeUserSessions(row.id, user.jti)
    await store
      .logDeviceEvent(null, 'user.mfa_disabled', { email: row.email, by: 'self' })
      .catch(() => undefined)
    return reply.headers(noStore).send({ ok: true })
  })

  app.post('/api/auth/mfa/recovery-codes', { config: limit }, async (req, reply) => {
    const row = await confirmed(req, reply)
    if (!row) return
    const { codes, hashes } = newRecoveryCodes()
    await store.replaceRecoveryCodes(row.id, hashes)
    return reply.headers(noStore).send({ ok: true, recoveryCodes: codes })
  })

  // --- an administrator resets someone else's -----------------------------------------------------------------------

  // A lost phone: turns the account's two-step sign-in off and ends its sessions. Allowed for whoever may edit the account
  // (the same limits as `PATCH /api/users/:id`); a role that must have it sets it up again at its next sign-in.
  app.post('/api/users/:id/mfa/reset', async (req, reply) => {
    const { id } = req.params as { id: string }
    const actor = req.user!
    const target = await store.findUserById(id)
    const inScope =
      !!target &&
      (actor.role === 'developer' || (actor.adminId !== null && target.admin_id === actor.adminId))
    if (!target || !inScope) return reply.code(404).send({ error: 'Unknown user.' })
    if (
      target.id === actor.id ||
      target.role === 'developer' ||
      (target.role === 'admin' && actor.role !== 'developer')
    )
      return reply.code(403).send({
        error:
          target.id === actor.id
            ? 'Turn off your own two-step sign-in from your account screen.'
            : 'Cannot reset this account.',
      })
    await store.disableTotp(id)
    await store.revokeUserSessions(id)
    hub.closeUser(id)
    whep.closeForUser(id)
    await store
      .logDeviceEvent(null, 'user.mfa_reset', { email: target.email, by: actor.email })
      .catch(() => undefined)
    return { user: publicUser((await store.findUserById(id))!) }
  })
}
