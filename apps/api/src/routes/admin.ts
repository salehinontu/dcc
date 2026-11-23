import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { can } from '@dji/protocol'
import type { CurrentUser } from '../auth'
import type { RouteContext } from '../http/context'
import { readableSns } from '../http/scope'
import { tenantOf, type Tenant } from '../http/tenant'
import { iso, type EnrollmentSummary } from '../store'

const snParams = z.object({
  sn: z
    .string()
    .min(4)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
})
const aircraftList = z.object({
  aircraftSns: z.array(z.string().min(1).max(64)).max(32).optional(),
})
const reasonBody = z.object({ reason: z.string().max(200).optional() })

export function registerAdminRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, manager, requireAdmin } = ctx

  const scope = {
    preHandler: requireAdmin,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }

  /**
   * Controllers a customer may see and act on: those its own team's Pilots signed in or an Admin
   * of the team approved ahead of time, and any that fly a drone it has been given. A Developer,
   * and an account explicitly given every drone, see all. Everything else belongs to someone
   * else's installation and answers as if it did not exist.
   */
  function controllerVisible(
    row: EnrollmentSummary,
    tenant: Tenant | undefined,
    readable: string[] | undefined,
  ): boolean {
    if (!tenant || readable === undefined) return true
    if (row.user_id && tenant.ids.has(row.user_id)) return true
    if (row.approved_by && tenant.emails.has(row.approved_by.toLowerCase())) return true
    return row.aircraft_sns.some((sn) => readable.includes(sn))
  }

  app.get('/api/admin/controllers', scope, async (req) => {
    const tenant = await tenantOf(store, req.user!)
    const readable = readableSns(req.user!, 'drones.view')
    const rows = (await store.listEnrollments()).filter((row) =>
      controllerVisible(row, tenant, readable),
    )
    return {
      controllers: rows.map((row) => ({
        controllerSn: row.controller_sn,
        status: row.status,
        ownerId: row.user_id,
        workspaceId: row.workspace_id,
        aircraftSns: row.aircraft_sns,
        note: row.note,
        requestedAt: iso(row.created_at),
        lastSeenAt: iso(row.last_seen_at),
        approvedBy: row.approved_by,
        approvedAt: iso(row.approved_at),
      })),
    }
  })

  /**
   * The admin inventory: every aircraft the system has ever seen, including the ones hidden
   * from the fleet. The deleted ones are read-only on purpose — restoring one needs the
   * original controller, because holding that handset is the only proof of custody. There is
   * no admin restore button by design.
   */
  app.get('/api/admin/devices', scope, async (req) => {
    const readable = readableSns(req.user!, 'drones.view')
    const rows = (await store.listAllDevices()).filter(
      (row) => readable === undefined || readable.includes(row.sn),
    )
    return {
      devices: rows.map((row) => ({
        sn: row.sn,
        gatewaySn: row.gateway_sn,
        model: row.model,
        displayName: row.display_name,
        label: row.label,
        online: row.online,
        lastSeenAt: iso(row.last_seen_at),
        disabledAt: iso(row.disabled_at),
        deletedAt: iso(row.deleted_at),
      })),
    }
  })

  /** 404 for a controller that exists but is not this customer's; false means "not yours". */
  async function mayActOn(actor: CurrentUser, controllerSn: string): Promise<boolean> {
    const existing = (await store.listEnrollments()).find(
      (row) => row.controller_sn === controllerSn,
    )
    if (!existing) return true
    return controllerVisible(
      existing,
      await tenantOf(store, actor),
      readableSns(actor, 'drones.view'),
    )
  }

  app.post('/api/admin/controllers/:sn/approve', scope, async (req, reply) => {
    const params = snParams.safeParse(req.params)
    const body = aircraftList.safeParse(req.body ?? {})
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid request' })

    if (!(await mayActOn(req.user!, params.data.sn)))
      return reply.code(404).send({ error: 'unknown controller' })

    const actor = req.user?.email ?? 'admin'
    const aircraft = body.data.aircraftSns ?? (await store.aircraftSnsForController(params.data.sn))
    // Only a drone the account may see can be listed: naming someone else's serial would hand
    // that drone to this controller.
    const known = await store.existingDeviceSns(aircraft)
    if (known.some((sn) => !can(req.user!, 'drones.view', sn)))
      return reply.code(403).send({ error: 'That drone is not yours to assign.' })
    const approved = await store.approveEnrollment(params.data.sn, aircraft, actor)
    if (!approved) return reply.code(404).send({ error: 'unknown controller' })

    await store
      .logDeviceEvent(params.data.sn, 'controller.approved', { by: actor, aircraft })
      .catch(() => undefined)
    return { ok: true, status: 'approved', aircraftSns: aircraft }
  })

  app.post('/api/admin/controllers/:sn/reject', scope, async (req, reply) => {
    const params = snParams.safeParse(req.params)
    const body = reasonBody.safeParse(req.body ?? {})
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid request' })
    if (!(await mayActOn(req.user!, params.data.sn)))
      return reply.code(404).send({ error: 'unknown controller' })

    const actor = req.user?.email ?? 'admin'
    // Stop the aircraft's streams before the binding disappears, so the controller is not
    // left pushing video to a stream nobody owns any more.
    for (const aircraft of await store.aircraftSnsForController(params.data.sn)) {
      await manager.adminStop(aircraft, actor).catch(() => undefined)
    }
    const revoked = await store.revokeEnrollment(
      params.data.sn,
      actor,
      body.data.reason ?? 'rejected',
    )
    if (!revoked) return reply.code(404).send({ error: 'unknown controller' })

    await store
      .logDeviceEvent(params.data.sn, 'controller.rejected', {
        by: actor,
        reason: body.data.reason,
      })
      .catch(() => undefined)
    return { ok: true, status: 'rejected' }
  })

  app.post('/api/admin/controllers/:sn/unbind', scope, async (req, reply) => {
    const params = snParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    if (!(await mayActOn(req.user!, params.data.sn)))
      return reply.code(404).send({ error: 'unknown controller' })

    const actor = req.user?.email ?? 'admin'
    for (const aircraft of await store.aircraftSnsForController(params.data.sn)) {
      await manager.adminStop(aircraft, actor).catch(() => undefined)
    }
    const revoked = await store.revokeEnrollment(params.data.sn, actor, 'unbound')
    if (!revoked) return reply.code(404).send({ error: 'unknown controller' })

    await store
      .logDeviceEvent(params.data.sn, 'controller.unbound', { by: actor })
      .catch(() => undefined)
    return { ok: true, status: 'rejected' }
  })
}
