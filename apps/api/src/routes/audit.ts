import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AUDIT_OUTCOMES, auditActionLabel, type AuditEvent, type AuditFilter } from '@dji/protocol'
import type { AuditScope } from '../audit'
import { config } from '../config'
import { clientIp } from '../http/audit'
import type { RouteContext } from '../http/context'

const filterSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  actor: z.string().min(1).max(254).optional(),
  category: z
    .string()
    .regex(/^[a-z_]{1,30}$/)
    .optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  q: z.string().min(1).max(200).optional(),
})

/** The most lines one "delete everything that matches" removes; the screen asks again if more are left. */
const MAX_ALL = 100_000

const CSV_COLUMNS = [
  'seq',
  'time_utc',
  'time_local',
  'actor',
  'role',
  'action',
  'description',
  'outcome',
  'status',
  'target_type',
  'target_id',
  'target',
  'ip',
  'user_agent',
  'details',
  'hash',
] as const

/**
 * One cell of a CSV. A cell that starts with = + - @ would be run as a formula by a spreadsheet, so it is
 * prefixed with an apostrophe: what someone typed into a drone's name must never become a formula on an
 * auditor's computer.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'string' ? value : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function localTime(iso: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.timeZone,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(iso))
}

export function csvRow(event: AuditEvent): string {
  return [
    event.seq,
    event.time,
    localTime(event.time),
    event.actorEmail,
    event.actorRole,
    event.action,
    auditActionLabel(event.action),
    event.outcome,
    event.status,
    event.targetType,
    event.targetId,
    event.targetLabel,
    event.ip,
    event.userAgent,
    event.details ? JSON.stringify(event.details) : '',
    event.hash,
  ]
    .map(csvCell)
    .join(',')
}

const stamp = (): string =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '_')

export function registerAuditRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { audit } = ctx
  if (!audit) return

  /** A Developer reads everything; anyone else reads their own team's lines. */
  const scopeOf = (user: { role: string; id: string; adminId: string | null }): AuditScope =>
    user.role === 'developer' ? { all: true } : { tenantId: user.adminId ?? user.id }

  app.get('/api/audit', async (req, reply) => {
    const query = filterSchema
      .extend({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid request' })
    const { limit, offset, ...filter } = query.data
    return audit.list(filter, scopeOf(req.user!), limit, offset)
  })

  app.get('/api/audit/export', async (req, reply) => {
    const query = filterSchema
      .extend({ format: z.enum(['csv', 'json']).default('csv') })
      .safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid request' })
    const { format, ...filter } = query.data
    const scope = scopeOf(req.user!)
    const rows = await audit.count(filter, scope)
    const head = await audit.head()
    const user = req.user!

    // The export is itself an event: who took the trail out, with which filter, and how much of it.
    audit.record({
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      tenantId: user.role === 'developer' ? null : (user.adminId ?? user.id),
      action: 'audit.exported',
      outcome: 'success',
      status: 200,
      details: { format, filter, rows },
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] ?? '') || null,
    })

    const events = audit.iterate(filter as AuditFilter, scope)
    async function* csv(): AsyncGenerator<string> {
      // A byte-order mark, so a spreadsheet reads names in any script correctly.
      yield `\uFEFF${CSV_COLUMNS.join(',')}\r\n`
      for await (const event of events) yield `${csvRow(event)}\r\n`
    }
    async function* json(): AsyncGenerator<string> {
      yield `{"exportedAt":${JSON.stringify(new Date().toISOString())},"exportedBy":${JSON.stringify(user.email)},"filter":${JSON.stringify(filter)},"rows":${rows},"chainHead":{"seq":${head.seq},"hash":${JSON.stringify(head.hash)}},"events":[`
      let first = true
      for await (const event of events) {
        yield `${first ? '' : ','}${JSON.stringify(event)}`
        first = false
      }
      yield ']}'
    }

    const file = `${config.brand.filePrefix}_audit_${stamp()}.${format}`
    return reply
      .header(
        'content-type',
        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      )
      .header('content-disposition', `attachment; filename="${file}"`)
      .header('cache-control', 'no-store')
      .send(Readable.from(format === 'csv' ? csv() : json()))
  })

  // Deleting lines belongs to the Developer (the access table enforces it). The lines are blanked, not dropped, so
  // the chain still checks out; the deletion is recorded first, and the line that records it can never be deleted.
  app.post('/api/audit/delete', async (req, reply) => {
    const body = z
      .union([
        z.object({ seqs: z.array(z.number().int().positive()).min(1).max(1000) }),
        z.object({ all: z.literal(true), filter: filterSchema }),
      ])
      .safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid request' })
    const user = req.user!
    const mode = 'seqs' in body.data ? 'selected' : 'matching'
    const targets =
      'seqs' in body.data
        ? [...new Set(body.data.seqs)]
        : await audit.seqsMatching(body.data.filter as AuditFilter, { all: true }, MAX_ALL)
    if (targets.length === 0) return { deleted: 0 }

    await audit.write({
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      tenantId: null,
      action: 'audit.deleted',
      outcome: 'success',
      status: 200,
      details: {
        count: targets.length,
        mode,
        firstSeq: targets.reduce((low, seq) => Math.min(low, seq)),
        lastSeq: targets.reduce((high, seq) => Math.max(high, seq)),
        ...('all' in body.data ? { filter: body.data.filter } : {}),
      },
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] ?? '') || null,
    })
    return { deleted: await audit.remove(targets) }
  })

  // Walks the whole chain. It answers only whether the trail is intact, so anyone who may read it may ask.
  app.get(
    '/api/audit/verify',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const result = await audit.verify()
      const user = req.user!
      audit.record({
        actorId: user.id,
        actorEmail: user.email,
        actorRole: user.role,
        tenantId: user.role === 'developer' ? null : (user.adminId ?? user.id),
        action: 'audit.verified',
        outcome: result.ok ? 'success' : 'failure',
        status: 200,
        details: { checked: result.checked, ok: result.ok, brokenAt: result.brokenAt ?? null },
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] ?? '') || null,
      })
      return result
    },
  )
}
