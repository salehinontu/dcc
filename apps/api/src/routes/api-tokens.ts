import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { apiTokenCreateSchema, can, type ApiTokenCreated, type ApiWhoami } from '@dji/protocol'
import { newApiToken } from '../api-tokens'
import { noteAudit } from '../http/audit'
import type { RouteContext } from '../http/context'
import { tenantOf } from '../http/tenant'
import { buildOpenApi } from '../openapi'

/** Most tokens one account may have working at once: a leak is easier to find in a short list. */
const MAX_WORKING_TOKENS = 50

/**
 * API access. Whoever holds `api.manage` makes read-only tokens for a customer's own programs and revokes them; a
 * token is a narrowed copy of the account that made it (see `api-tokens.ts`). Also the two routes a program uses to
 * learn what it has: who it is, and the API's description.
 */
export function registerApiTokenRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, registry } = ctx

  app.get('/api/api-tokens', async (req) => {
    const team = await tenantOf(store, req.user!)
    return { tokens: await store.tokens.list(team ? [...team.ids] : undefined) }
  })

  app.post('/api/api-tokens', async (req, reply) => {
    const user = req.user!
    // A token is a narrowed copy of its owner. A Developer is the vendor's account and sees every customer, so a
    // token made from it would be the widest key there is: a customer's Admin makes it instead.
    if (user.role === 'developer')
      return reply.code(403).send({
        error: 'developer_cannot_own_tokens',
        message: 'Make the token from the customer’s Admin account.',
      })
    const body = apiTokenCreateSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid request' })
    const { name, deviceSns, expiresInDays } = body.data

    if (deviceSns) {
      const known = new Set((await registry.list()).map((device) => device.sn))
      const unknown = deviceSns.filter((sn) => !known.has(sn) || !can(user, 'drones.view', sn))
      if (unknown.length > 0)
        return reply.code(400).send({ error: 'unknown_drones', drones: unknown })
    }
    const working = (await store.tokens.list([user.id])).filter(
      (token) => !token.revokedAt && (!token.expiresAt || Date.parse(token.expiresAt) > Date.now()),
    )
    if (working.length >= MAX_WORKING_TOKENS)
      return reply.code(409).send({ error: 'too_many_tokens', limit: MAX_WORKING_TOKENS })

    const secret = newApiToken()
    const record = await store.tokens.create({
      id: crypto.randomUUID(),
      userId: user.id,
      name,
      tokenHash: secret.hash,
      prefix: secret.prefix,
      deviceSns: deviceSns ? [...new Set(deviceSns)] : null,
      expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null,
    })
    noteAudit(req, {
      targetType: 'api_token',
      targetLabel: name,
      details: {
        prefix: secret.prefix,
        drones: deviceSns ? deviceSns.length : 'all',
        expiresInDays,
      },
    })
    // The only time the secret is shown: nothing may keep a copy of this answer.
    return reply
      .code(201)
      .header('cache-control', 'no-store')
      .send({ token: secret.token, record } satisfies ApiTokenCreated)
  })

  app.delete('/api/api-tokens/:id', async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    const ownerId = await store.tokens.ownerOf(params.data.id)
    const team = await tenantOf(store, req.user!)
    // Another customer's token does not exist for this account.
    if (!ownerId || (team && !team.ids.has(ownerId)))
      return reply.code(404).send({ error: 'not found' })
    await store.tokens.revoke(params.data.id, req.user!.id)
    return reply.code(204).send()
  })

  // What this credential is and may read: a program checks it first.
  app.get('/api/v1/whoami', async (req) => {
    const user = req.user!
    const drones = (await registry.list())
      .filter((device) => can(user, 'drones.view', device.sn))
      .map((device) => ({ sn: device.sn, name: device.displayName ?? device.model ?? device.sn }))
    const permissions = [
      ...new Set([...user.permissions, ...Object.values(user.dronePermissions).flat()]),
    ]
    return {
      kind: user.apiToken ? 'token' : 'session',
      name: user.apiToken?.name ?? null,
      expiresAt: user.apiToken?.expiresAt ?? null,
      drones,
      permissions,
    } satisfies ApiWhoami
  })

  // The API described for machines (OpenAPI 3): generators and API clients read this.
  app.get('/api/v1/openapi.json', async (req) =>
    buildOpenApi(`${req.protocol}://${req.host}`, process.env.APP_VERSION || '1'),
  )
}
