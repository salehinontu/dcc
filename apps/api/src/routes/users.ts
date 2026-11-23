import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  ACCOUNT_PERMISSIONS,
  ASSIGNABLE_ROLES,
  can,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PERMISSIONS,
  PILOT_PERMISSIONS,
  type Access,
} from '@dji/protocol'
import { z } from 'zod'
import { hashPassword, publicUser, type CurrentUser } from '../auth'
import type { RouteContext } from '../http/context'

const accessSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
  allDrones: z.boolean(),
  dronePermissions: z
    .record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.array(z.enum(PERMISSIONS)))
    .default({}),
  disabled: z.boolean().default(false),
  /** A Developer creating a Sub-admin or Pilot says which Admin it belongs to; others never do. */
  adminId: z.string().max(64).nullable().optional(),
})

/**
 * A Pilot account only signs a controller in. Whatever the form sent, its access is the fixed
 * Pilot set on every aircraft, so a mis-ticked box can neither widen nor break it.
 */
function forRole<T extends Access>(input: T): T {
  return input.role === 'pilot'
    ? { ...input, permissions: [...PILOT_PERMISSIONS], allDrones: true, dronePermissions: {} }
    : input
}

/**
 * Only a Developer creates or edits Admins. An Admin, and a Sub-admin it allowed to manage
 * users, hands out any subset of their own access, the right to manage users included.
 */
function mayDelegate(actor: CurrentUser, input: Access): boolean {
  if (actor.role === 'developer') return true
  if (input.role === 'admin') return false
  // A Pilot only signs a controller in and its access is fixed (see `forRole`), so it is not a
  // share of the actor's own: whoever may bind drones may make one, limited to some drones or not.
  if (input.role === 'pilot') return can(actor, 'drones.bind')
  if (input.allDrones && !actor.allDrones) return false
  // Global grants and every device override must be a subset of the actor's access.
  if (input.permissions.some((p) => !actor.permissions.includes(p))) return false
  return Object.entries(input.dronePermissions).every(([sn, grants]) =>
    grants.every((p) => !ACCOUNT_PERMISSIONS.includes(p) && can(actor, p, sn)),
  )
}

/**
 * Whose accounts an actor may see and act on. A Developer: everyone's. Anyone else: their own,
 * and the accounts that belong to the same Admin (an Admin belongs to itself). So one customer's
 * Admin never sees, edits or deletes another customer's accounts, or the Admin itself.
 */
function inScope(actor: CurrentUser, target: { id: string; admin_id: string | null }): boolean {
  if (actor.role === 'developer' || target.id === actor.id) return true
  return actor.adminId !== null && target.admin_id === actor.adminId
}

export function registerUserRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, hub, whep } = ctx
  app.get('/api/users', async (req) => {
    // When each account last signed in, from the audit trail.
    const lastLogins = ctx.audit ? await ctx.audit.lastLogins() : new Map<string, string>()
    return {
      users: (await store.listUsers())
        .filter(
          (u) =>
            req.user!.role === 'developer' ||
            u.id === req.user!.id ||
            (inScope(req.user!, u) && mayDelegate(req.user!, publicUser(u))),
        )
        .map((u) => ({
          ...publicUser(u),
          lastLoginAt: lastLogins.get(u.email.toLowerCase()) ?? null,
        })),
      permissions: PERMISSIONS,
    }
  })
  app.post('/api/users', async (req, reply) => {
    const body = accessSchema
      .extend({
        email: z.email().max(254),
        password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
      })
      .safeParse(req.body)
    if (!body.success)
      return reply.code(400).send({
        error: `Invalid user. Use a valid email and a ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} character password.`,
      })
    const data = forRole(body.data)
    if (!mayDelegate(req.user!, data))
      return reply.code(403).send({ error: 'Cannot grant this role or access.' })
    if (await store.findUserByEmail(data.email))
      return reply.code(409).send({ error: 'Email already exists.' })
    // Which Admin the new account belongs to: a Developer chooses (or leaves it with no Admin),
    // everyone else passes their own on. An Admin belongs to itself, which createUser sets.
    let adminId: string | null = null
    if (data.role !== 'admin') {
      if (req.user!.role === 'developer') {
        adminId = data.adminId ?? null
        if (adminId !== null && (await store.findUserById(adminId))?.role !== 'admin')
          return reply.code(400).send({ error: 'Choose an existing Admin for this account.' })
      } else {
        adminId = req.user!.adminId
      }
    }
    const id = randomUUID()
    try {
      // The password the admin types is the account's password: nothing forces a change.
      await store.createUser(id, data.email, await hashPassword(data.password), data.role, {
        ...data,
        adminId,
        createdBy: req.user!.id,
      })
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        return reply.code(409).send({ error: 'Email already exists.' })
      throw error
    }
    return reply.code(201).send({ user: publicUser((await store.findUserById(id))!) })
  })
  /**
   * Permanently removes an account. The same limits as an edit apply, plus: never yourself,
   * never a Developer (those are managed from the CLI), and only a Developer removes an Admin.
   */
  app.delete('/api/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const target = await store.findUserById(id)
    if (!target || !inScope(req.user!, target))
      return reply.code(404).send({ error: 'Unknown user.' })
    if (
      target.id === req.user!.id ||
      target.role === 'developer' ||
      (target.role === 'admin' && req.user!.role !== 'developer') ||
      !mayDelegate(req.user!, publicUser(target))
    ) {
      return reply.code(403).send({ error: 'Cannot delete this account.' })
    }
    // An Admin's accounts belong to it; removing it would leave them with no one to see them.
    if (target.role === 'admin') {
      const owned = await store.countAdminAccounts(target.id)
      if (owned > 0)
        return reply.code(409).send({
          error: `This Admin still has ${owned} Sub-admin and drone operator account${owned === 1 ? '' : 's'}. Delete them first.`,
        })
    }
    // End its sessions and live connections first: after the row is gone nothing could.
    await store.revokeUserSessions(id)
    hub.closeUser(id)
    whep.closeForUser(id)
    if (!(await store.deleteUser(id))) return reply.code(404).send({ error: 'Unknown user.' })
    await store
      .logDeviceEvent(null, 'user.deleted', {
        email: target.email,
        role: target.role,
        by: req.user!.email,
      })
      .catch(() => undefined)
    return reply.code(204).send()
  })

  app.patch('/api/users/:id', async (req, reply) => {
    const body = accessSchema
      .extend({ password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH).optional() })
      .safeParse(req.body)
    const { id } = req.params as { id: string }
    const target = await store.findUserById(id)
    if (!target || !inScope(req.user!, target))
      return reply.code(404).send({ error: 'Unknown user.' })
    if (!body.success) return reply.code(400).send({ error: 'Invalid user settings.' })
    const data = forRole(body.data)
    if (
      target.id === req.user!.id ||
      target.role === 'developer' ||
      (target.role === 'admin' && req.user!.role !== 'developer') ||
      !mayDelegate(req.user!, publicUser(target)) ||
      !mayDelegate(req.user!, data)
    ) {
      return reply.code(403).send({ error: 'Cannot edit this account or grant this access.' })
    }
    // Turning an Admin into something else would strand the accounts that belong to it.
    if (target.role === 'admin' && data.role !== 'admin') {
      const owned = await store.countAdminAccounts(target.id)
      if (owned > 0)
        return reply.code(409).send({
          error: `This Admin still has ${owned} Sub-admin and drone operator account${owned === 1 ? '' : 's'}. Delete them first.`,
        })
    }
    await store.setUserAccess(id, data)
    if (data.password) await store.updateUser(id, await hashPassword(data.password), data.role)
    // Any edit at all — a role change, a scope change, a disable, a password reset — ends
    // every session the account had. There is no `exceptJti`: an admin reset must eject the
    // person being reset, and an admin is never the target of their own edit above.
    await store.revokeUserSessions(id)
    hub.closeUser(id)
    whep.closeForUser(id)
    return { user: publicUser((await store.findUserById(id))!) }
  })
}
