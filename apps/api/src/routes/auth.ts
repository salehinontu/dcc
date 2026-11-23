import type { FastifyInstance, FastifyReply } from 'fastify'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@dji/protocol'
import { z } from 'zod'
import {
  hashPassword,
  issueMfaChallenge,
  issueSession,
  publicUser,
  verifyPassword,
  verifyToken,
} from '../auth'
import { config } from '../config'
import { noteAudit } from '../http/audit'
import type { RouteContext } from '../http/context'
import { countWrongPassword, lockedUntil, lockMessage } from '../http/lockout'

/** A new password: the shared minimum, applied here, in the user routes and in the CLI. */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH)

const SESSION_MAX_AGE = 12 * 60 * 60

/** The cookie and the token it carries must expire together. */
export function setSessionCookies(reply: FastifyReply, token: string): void {
  const secure = config.publicHost !== 'localhost' && config.publicHost !== '127.0.0.1'
  reply.setCookie('dji_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
    secure,
  })
  // Readable marker so the SPA can skip /api/me for anonymous visitors. It carries no
  // credentials; the real session cookie above stays HttpOnly.
  reply.setCookie('dji_session_hint', '1', {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
    secure,
  })
}

export function registerAuthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, requireUser } = ctx

  const noStore = { 'cache-control': 'no-store', pragma: 'no-cache' }

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = z
        .object({ email: z.string().min(3), password: z.string().min(1) })
        .safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

      const user = await store.findUserByEmail(parsed.data.email)
      // A locked account is refused before its password is even looked at.
      const locked = user ? lockedUntil(user) : null
      if (locked) {
        noteAudit(req, { details: { locked: true } })
        return reply.code(429).send({ error: lockMessage(locked) })
      }
      if (
        !user ||
        user.disabled ||
        !(await verifyPassword(user.password_hash, parsed.data.password))
      ) {
        const lock = await countWrongPassword(store, user)
        if (lock) {
          noteAudit(req, { details: { locked: true } })
          return reply.code(429).send({ error: lockMessage(lock) })
        }
        return reply.code(401).send({ error: 'invalid credentials' })
      }
      await store.clearLoginFailures(user.id)

      // With two-step sign-in on, the password alone opens nothing: no session is issued here, only a short-lived
      // proof that the password was right, to be sent back with a code (`POST /api/auth/mfa`, routes/mfa.ts).
      if (user.totp_enabled_at) {
        noteAudit(req, {
          action: 'auth.password_accepted',
          details: { next: 'two-step code' },
        })
        return reply
          .headers({ 'cache-control': 'no-store', pragma: 'no-cache' })
          .send({ mfaRequired: true, mfaToken: await issueMfaChallenge(user) })
      }

      const token = await issueSession(publicUser(user), store)
      setSessionCookies(reply, token)
      return { user: publicUser(user) }
    },
  )

  app.post('/api/auth/logout', async (req, reply) => {
    // Revoke before clearing: otherwise a replayed copy of the cookie would still work.
    // Only this device is ended; the account's other sessions are untouched.
    const token = req.cookies.dji_session ?? null
    if (token) {
      const claims = await verifyToken(token)
      if (claims?.jti) await store.revokeSession(claims.jti).catch(() => undefined)
    }
    reply.clearCookie('dji_session', { path: '/' })
    reply.clearCookie('dji_session_hint', { path: '/' })
    return { ok: true }
  })

  /**
   * Self-service password change. Every session for the account is revoked, including this
   * one, and then this device is handed a fresh token — so the person who changed the
   * password stays signed in here while every other device is signed out. The live
   * WebSocket and WHEP sessions are closed because their tokens are now dead.
   */
  app.post(
    '/api/auth/password',
    { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = z
        .object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
        .safeParse(req.body)
      if (!body.success)
        return reply
          .headers(noStore)
          .code(400)
          .send({ error: body.error.issues[0]?.message ?? 'invalid request' })
      const row = await store.findUserById(req.user!.id)
      if (!row || !(await verifyPassword(row.password_hash, body.data.currentPassword)))
        return reply.headers(noStore).code(400).send({ error: 'current password is incorrect' })
      if (body.data.currentPassword === body.data.newPassword)
        return reply.headers(noStore).code(400).send({ error: 'choose a different password' })
      if (
        !(await store.changePassword(
          row.id,
          row.password_hash,
          await hashPassword(body.data.newPassword),
        ))
      )
        return reply.headers(noStore).code(409).send({ error: 'password already changed' })
      await store
        .logDeviceEvent(null, 'user.password_changed', { email: row.email, by: 'self' })
        .catch(() => undefined)
      ctx.hub.closeUser(row.id)
      ctx.whep.closeForUser(row.id)
      // No `exceptJti`: this device's old token dies with the rest, then it is reissued.
      await store.revokeUserSessions(row.id)
      // Re-read: the change bumped `session_version`, and a token carrying the old value
      // would be rejected on its very first use.
      const updated = await store.findUserById(row.id)
      if (!updated) return reply.headers(noStore).code(401).send({ error: 'account unavailable' })
      setSessionCookies(reply, await issueSession(publicUser(updated), store))
      return reply.headers(noStore).send({ ok: true })
    },
  )

  /**
   * Self-service change of the sign-in email. Needs the current password, like a password
   * change, but leaves every session in place: nothing a session or a controller credential
   * depends on changes, and a pilot must not lose the link to an aircraft in the air.
   */
  app.post(
    '/api/auth/email',
    { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = z
        .object({ currentPassword: z.string().min(1), email: z.email().max(254) })
        .safeParse(req.body)
      if (!body.success)
        return reply.headers(noStore).code(400).send({ error: 'enter a valid email address' })
      const row = await store.findUserById(req.user!.id)
      if (!row || !(await verifyPassword(row.password_hash, body.data.currentPassword)))
        return reply.headers(noStore).code(400).send({ error: 'current password is incorrect' })
      const next = body.data.email.trim().toLowerCase()
      if (next === row.email.toLowerCase())
        return reply.headers(noStore).code(400).send({ error: 'choose a different email' })
      const taken = await store.findUserByEmail(next)
      if (taken && taken.id !== row.id)
        return reply.headers(noStore).code(409).send({ error: 'that email is already in use' })
      if (!(await store.changeEmail(row.id, next)))
        return reply.headers(noStore).code(409).send({ error: 'that email is already in use' })
      await store
        .logDeviceEvent(null, 'user.email_changed', { from: row.email, to: next, by: 'self' })
        .catch(() => undefined)
      return reply.headers(noStore).send({ ok: true, email: next })
    },
  )

  app.get('/api/me', { preHandler: requireUser }, async (req) => ({ user: req.user }))
}
