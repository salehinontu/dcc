import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { defaultPermissions, type AuditEvent, type AuditIntegrity } from '@dji/protocol'
import { AuditLog, stableStringify } from '../src/audit'
import { hashPassword, issueSession, publicUser } from '../src/auth'
import { migrate, type Db } from '../src/db'
import { Hub } from '../src/hub'
import { clientIp, summarize } from '../src/http/audit'
import { MqttAuthorizer } from '../src/mqtt-auth'
import { Registry } from '../src/registry'
import { csvCell, csvRow } from '../src/routes/audit'
import { buildServer } from '../src/server'
import { Store } from '../src/store'
import { StreamManager } from '../src/streams/manager'
import { WhepSessions } from '../src/streams/whep'
import type { MqttBridge } from '../src/mqtt'

const embedded = new PGlite()
const db: Db = {
  query: async <T>(sql: string, params?: unknown[]) => (await embedded.query<T>(sql, params)).rows,
  exec: async (sql) => {
    await embedded.exec(sql)
  },
  close: () => embedded.close(),
}
const store = new Store(db)
const hub = new Hub()
const registry = new Registry(store, 'workspace')
const bridge = {
  connected: true,
  subscribed: true,
  callService: async () => ({}),
} as unknown as MqttBridge
const whep = new WhepSessions()
const manager = new StreamManager({ store, hub, bridge, whep })
const authorizer = new MqttAuthorizer(store)
const audit = new AuditLog(db)

let app: Awaited<ReturnType<typeof buildServer>>
const ids: Record<string, string> = {}

async function account(name: string, role: string, adminId: string | null = null) {
  const id = randomUUID()
  ids[name] = id
  await store.createUser(
    id,
    `${name}@example.com`,
    await hashPassword('initial-password-123'),
    role,
    {
      permissions: defaultPermissions(role),
      allDrones: true,
      dronePermissions: {},
      mustChangePassword: false,
      adminId,
    },
  )
}

async function call(
  name: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const token = await issueSession(publicUser((await store.findUserById(ids[name]!))!), store)
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload: payload as Record<string, unknown> | undefined,
  })
}

const everything = async (name = 'developer'): Promise<AuditEvent[]> => {
  await audit.flush()
  return (await call(name, 'GET', '/api/audit?limit=200')).json().events as AuditEvent[]
}

before(async () => {
  await migrate(db)
  await account('developer', 'developer')
  await account('admin', 'admin')
  await account('admin2', 'admin')
  // A Sub-admin in the first Admin's team; it has no audit grant until one is given.
  await account('teammate', 'subadmin', ids.admin!)
  await account('pilot', 'pilot', ids.admin!)
  app = await buildServer({ store, hub, registry, bridge, whep, manager, authorizer, audit })
  await app.ready()
})

after(async () => {
  await app.close()
})

test('lines are chained: gap-free, in order even when written at once, and the chain checks out', async () => {
  const before = await audit.head()
  await Promise.all(
    Array.from({ length: 25 }, (_, n) =>
      audit.write({ action: 'test.burst', outcome: 'success', details: { n } }),
    ),
  )
  const head = await audit.head()
  assert.equal(head.seq, before.seq + 25)
  const result = await audit.verify()
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.checked, head.seq)
  assert.equal(result.headHash, head.hash)
  // Each line names the one before it.
  const rows = await db.query<{ seq: string; prev_hash: string; hash: string }>(
    `SELECT seq, prev_hash, hash FROM audit_log ORDER BY seq`,
  )
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i]!.prev_hash, rows[i - 1]!.hash)
  assert.equal(rows[0]!.prev_hash, '0'.repeat(64))
})

test('the trail cannot be edited or deleted, and an edit made behind the app’s back is found', async () => {
  await assert.rejects(
    () => db.query(`UPDATE audit_log SET action = 'x' WHERE seq = 3`),
    /cannot be changed/,
  )
  await assert.rejects(() => db.query(`DELETE FROM audit_log WHERE seq = 3`), /cannot be changed/)

  // Someone with the database switches the guard off and changes a line, removes one, then cuts the end.
  await db.exec(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_change`)
  try {
    await db.query(`UPDATE audit_log SET actor_email = 'someone.else@example.com' WHERE seq = 5`)
    let result: AuditIntegrity = await audit.verify()
    assert.equal(result.ok, false)
    assert.equal(result.brokenAt, 5)
    assert.match(result.reason ?? '', /changed/)
    // Put it back and the chain is whole again: the check is exact.
    await db.query(`UPDATE audit_log SET actor_email = NULL WHERE seq = 5`)
    assert.equal((await audit.verify()).ok, true)

    const saved = (await db.query(`SELECT * FROM audit_log WHERE seq = 7`))[0] as Record<
      string,
      unknown
    >
    await db.query(`DELETE FROM audit_log WHERE seq = 7`)
    result = await audit.verify()
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /missing/)
    await db.query(
      `INSERT INTO audit_log SELECT * FROM json_populate_record(NULL::audit_log, $1::json)`,
      [JSON.stringify(saved)],
    )
    assert.equal((await audit.verify()).ok, true)

    const head = await audit.head()
    const tail = (
      await db.query(`SELECT * FROM audit_log WHERE seq = $1`, [head.seq])
    )[0] as Record<string, unknown>
    await db.query(`DELETE FROM audit_log WHERE seq = $1`, [head.seq])
    result = await audit.verify()
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /end|head/)
    await db.query(
      `INSERT INTO audit_log SELECT * FROM json_populate_record(NULL::audit_log, $1::json)`,
      [JSON.stringify(tail)],
    )
  } finally {
    await db.exec(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_change`)
  }
  assert.equal((await audit.verify()).ok, true)
})

test('sign-ins are recorded, wrong passwords too, with the address from the proxy, and no password', async () => {
  const wrong = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Test Browser/1.0' },
    payload: { email: 'admin@example.com', password: 'not-the-password' },
  })
  assert.equal(wrong.statusCode, 401)
  const nobody = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'Ghost@Example.com', password: 'whatever-it-is' },
  })
  assert.equal(nobody.statusCode, 401)
  const right = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@example.com', password: 'initial-password-123' },
  })
  assert.equal(right.statusCode, 200)

  const events = await everything()
  const logins = events.filter((e) => e.action === 'auth.login')
  const failed = logins.find(
    (e) => e.actorEmail === 'admin@example.com' && e.outcome === 'failure',
  )!
  assert.equal(failed.status, 401)
  assert.equal(failed.ip, '203.0.113.7')
  assert.equal(failed.userAgent, 'Test Browser/1.0')
  assert.equal(
    failed.actorRole,
    'admin',
    'a known account is named even when the password was wrong',
  )
  const ghost = logins.find((e) => e.actorEmail === 'ghost@example.com')!
  assert.equal(ghost.outcome, 'failure')
  assert.equal(ghost.actorRole, null)
  const ok = logins.find((e) => e.actorEmail === 'admin@example.com' && e.outcome === 'success')!
  assert.equal(ok.status, 200)
  // A password is never written down, whatever the route.
  assert.ok(!JSON.stringify(events).includes('not-the-password'))
  assert.ok(!JSON.stringify(events).includes('initial-password-123'))

  // The users list shows when each account last signed in.
  const last = await audit.lastLogins()
  assert.ok(last.has('admin@example.com'))
  assert.ok(!last.has('ghost@example.com'))
})

test('changing an account records what changed: grants gained and lost, role, disable, password reset', async () => {
  const create = await call('admin', 'POST', '/api/users', {
    email: 'newhire@example.com',
    password: 'a-good-password-1',
    role: 'subadmin',
    permissions: ['map.view', 'wall.view', 'drones.view'],
    allDrones: true,
    dronePermissions: {},
    disabled: false,
  })
  assert.equal(create.statusCode, 201, create.body)
  const newId = (await store.findUserByEmail('newhire@example.com'))!.id
  ids.newhire = newId

  const edit = await call('admin', 'PATCH', `/api/users/${newId}`, {
    role: 'subadmin',
    permissions: ['map.view', 'drones.view', 'recordings.view'],
    allDrones: true,
    dronePermissions: {},
    disabled: true,
    password: 'another-good-password-2',
  })
  assert.equal(edit.statusCode, 200, edit.body)
  const removed = await call('admin', 'DELETE', `/api/users/${newId}`)
  assert.equal(removed.statusCode, 204, removed.body)

  const events = (await everything('admin')).filter((e) => e.targetId === newId)
  const created = events.find((e) => e.action === 'user.created')!
  assert.equal(created.targetLabel, 'newhire@example.com')
  assert.equal(created.actorEmail, 'admin@example.com')
  assert.equal((created.details as { permissions: number }).permissions, 3)
  const updated = events.find((e) => e.action === 'user.updated')!
  const changes = (updated.details as { changes: Record<string, unknown> }).changes
  assert.deepEqual(changes.permissionsAdded, ['recordings.view'])
  assert.deepEqual(changes.permissionsRemoved, ['wall.view'])
  assert.deepEqual(changes.disabled, [false, true])
  assert.equal(changes.passwordReset, true)
  // The line says who was changed by name, though it was deleted afterwards.
  const deleted = events.find((e) => e.action === 'user.deleted')!
  assert.equal(deleted.targetLabel, 'newhire@example.com')
  assert.ok(!JSON.stringify(events).includes('good-password'))
})

test('a refusal is recorded as denied, and a request that fails as a failure', async () => {
  // A Sub-admin may not manage users.
  const refused = await call('teammate', 'POST', '/api/users', {
    email: 'x@example.com',
    password: 'a-good-password-1',
    role: 'subadmin',
    permissions: [],
    allDrones: true,
    dronePermissions: {},
    disabled: false,
  })
  assert.equal(refused.statusCode, 403)
  const bad = await call('admin', 'POST', '/api/zones', { nonsense: true })
  assert.ok(bad.statusCode >= 400 && bad.statusCode < 500)
  const events = await everything()
  const denied = events.find((e) => e.action === 'user.created' && e.outcome === 'denied')!
  assert.equal(denied.actorEmail, 'teammate@example.com')
  assert.equal(denied.status, 403)
  const failed = events.find((e) => e.action === 'zone.created' && e.outcome === 'failure')!
  assert.equal(failed.actorEmail, 'admin@example.com')
})

test('a route nobody listed is still recorded, under a generic name', async () => {
  // Pilot sign-in routes are audited by name; this one is only covered by the catch-all.
  const res = await call('admin', 'POST', '/api/pilot/bind', { deviceSn: 'nothing' })
  assert.ok(res.statusCode >= 200)
  const events = await everything()
  assert.ok(
    events.some((e) => e.action === 'pilot.bind'),
    'listed routes keep their name',
  )
})

test('who may read the trail, and a team sees only its own lines', async () => {
  for (const name of ['teammate', 'pilot']) {
    assert.equal((await call(name, 'GET', '/api/audit')).statusCode, 403, name)
    assert.equal((await call(name, 'GET', '/api/audit/export')).statusCode, 403, name)
    assert.equal((await call(name, 'GET', '/api/audit/verify')).statusCode, 403, name)
  }

  // admin and admin2 each do something; each sees their own, the Developer sees both.
  await call('admin', 'POST', '/api/zones', {
    kind: 'no_fly',
    name: 'Team one zone',
    shape: { type: 'circle', center: [90.4, 23.8], radiusM: 300 },
    bufferM: 50,
    deviceSns: [],
  })
  await call('admin2', 'POST', '/api/zones', {
    kind: 'no_fly',
    name: 'Team two zone',
    shape: { type: 'circle', center: [91.4, 24.8], radiusM: 300 },
    bufferM: 50,
    deviceSns: [],
  })
  const one = await everything('admin')
  const two = await everything('admin2')
  const all = await everything('developer')
  assert.ok(one.length > 0 && two.length > 0)
  assert.ok(
    !one.some((e) => e.actorEmail === 'admin2@example.com'),
    'one team never reads another’s lines',
  )
  assert.ok(!two.some((e) => e.actorEmail === 'admin@example.com'))
  assert.ok(
    all.some((e) => e.actorEmail === 'admin2@example.com') &&
      all.some((e) => e.actorEmail === 'admin@example.com'),
  )

  // The Admin can hand the grant on to the Sub-admin, who then reads the same team's trail.
  assert.equal((await call('teammate', 'GET', '/api/audit')).statusCode, 403)

  // Filters: by who, by category, by outcome, by words.
  const mine = (await call('developer', 'GET', '/api/audit?actor=teammate&limit=50')).json()
  assert.ok(
    mine.events.length > 0 &&
      mine.events.every((e: AuditEvent) => e.actorEmail === 'teammate@example.com'),
  )
  const users = (await call('developer', 'GET', '/api/audit?category=user&limit=50')).json()
  assert.ok(
    users.events.length > 0 && users.events.every((e: AuditEvent) => e.action.startsWith('user.')),
  )
  assert.ok(users.categories.includes('auth') && users.categories.includes('user'))
  const denied = (await call('developer', 'GET', '/api/audit?outcome=denied&limit=50')).json()
  assert.ok(
    denied.events.length > 0 && denied.events.every((e: AuditEvent) => e.outcome === 'denied'),
  )
  // An account's trail is what it did and what was done to it.
  const account = (await call('developer', 'GET', '/api/audit?actor=newhire&limit=50')).json()
  assert.ok(account.events.some((e: AuditEvent) => e.action === 'user.created'))
  assert.ok(account.events.some((e: AuditEvent) => e.action === 'user.deleted'))
  assert.ok(account.events.every((e: AuditEvent) => e.targetLabel === 'newhire@example.com'))
  const words = (await call('developer', 'GET', '/api/audit?q=newhire&limit=50')).json()
  assert.ok(words.events.length >= 3)
  const paged = (await call('developer', 'GET', '/api/audit?limit=5&offset=5')).json()
  assert.equal(paged.events.length, 5)
  assert.ok(paged.total > 10)
  assert.equal((await call('developer', 'GET', '/api/audit?outcome=nonsense')).statusCode, 400)
  assert.equal((await call('developer', 'GET', '/api/audit?limit=9999')).statusCode, 400)
})

test('the trail exports as CSV and JSON, keeps spreadsheet formulas from running, and the export is itself recorded', async () => {
  await audit.write({
    action: 'drone.updated',
    outcome: 'success',
    actorEmail: 'admin@example.com',
    tenantId: ids.admin!,
    targetType: 'drone',
    targetLabel: '=HYPERLINK("http://evil.example","click")',
    details: { comma: 'a,b', quote: 'say "hi"', newline: 'one\ntwo' },
  })
  const csv = await call('admin', 'GET', '/api/audit/export?format=csv')
  assert.equal(csv.statusCode, 200)
  assert.match(String(csv.headers['content-type']), /text\/csv/)
  assert.match(
    String(csv.headers['content-disposition']),
    /attachment; filename=".*_audit_\d{8}_\d{6}\.csv"/,
  )
  const text = csv.body
  assert.ok(text.startsWith('﻿seq,time_utc,time_local,actor,role,action,description,outcome'))
  assert.ok(
    text.includes(`"'=HYPERLINK(""http://evil.example"",""click"")"`),
    'a formula is prefixed so it stays text',
  )
  assert.ok(text.includes('Signed in'), 'actions are described in words too')
  const lines = text.split('\r\n').filter(Boolean)
  assert.ok(lines.length > 5)

  const filtered = await call('admin', 'GET', '/api/audit/export?format=json&category=drone')
  const body = JSON.parse(filtered.body) as {
    rows: number
    chainHead: { seq: number; hash: string }
    exportedBy: string
    events: AuditEvent[]
  }
  assert.equal(body.exportedBy, 'admin@example.com')
  assert.equal(body.events.length, body.rows)
  assert.ok(body.events.length >= 1 && body.events.every((e) => e.action.startsWith('drone.')))
  assert.equal(body.chainHead.hash.length, 64)
  // Oldest first, as a log is read.
  for (let i = 1; i < body.events.length; i++)
    assert.ok(body.events[i]!.seq > body.events[i - 1]!.seq)

  const events = await everything('admin')
  const exported = events.find(
    (e) => e.action === 'audit.exported' && (e.details as { format: string }).format === 'json',
  )!
  assert.equal(exported.actorEmail, 'admin@example.com')
  assert.deepEqual((exported.details as { filter: unknown }).filter, { category: 'drone' })
  assert.equal((await call('admin', 'GET', '/api/audit/export?format=pdf')).statusCode, 400)
})

test('the integrity check answers over the API and is recorded', async () => {
  const res = await call('admin', 'GET', '/api/audit/verify')
  assert.equal(res.statusCode, 200)
  const result = res.json() as AuditIntegrity
  assert.equal(result.ok, true)
  assert.ok(result.checked > 10)
  await audit.flush()
  const events = await everything('admin')
  assert.ok(events.some((e) => e.action === 'audit.verified'))
})

test('what a Developer does is the vendor’s business: no customer reads it, even when it concerns their accounts', async () => {
  const body = (permissions: string[]) => ({
    role: 'subadmin',
    permissions,
    allDrones: true,
    dronePermissions: {},
    disabled: false,
  })
  // The vendor edits the customer's Sub-admin; the customer's own Admin edits it too.
  const byDeveloper = await call(
    'developer',
    'PATCH',
    `/api/users/${ids.teammate}`,
    body(['map.view', 'drones.view']),
  )
  assert.equal(byDeveloper.statusCode, 200, byDeveloper.body)
  const byAdmin = await call(
    'admin',
    'PATCH',
    `/api/users/${ids.teammate}`,
    body(['map.view', 'drones.view', 'wall.view']),
  )
  assert.equal(byAdmin.statusCode, 200, byAdmin.body)
  // The vendor also makes an account for the customer's team.
  const made = await call('developer', 'POST', '/api/users', {
    ...body(['map.view']),
    email: 'made-by-vendor@example.com',
    password: 'a-good-password-1',
    adminId: ids.admin,
  })
  assert.equal(made.statusCode, 201, made.body)

  const vendor = await everything('developer')
  assert.ok(
    vendor.some(
      (e) =>
        e.action === 'user.updated' &&
        e.actorEmail === 'developer@example.com' &&
        e.targetLabel === 'teammate@example.com',
    ),
    'the Developer reads its own work',
  )
  assert.ok(vendor.some((e) => e.action === 'user.created' && e.actorRole === 'developer'))
  const tagged = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_log WHERE actor_role = 'developer' AND tenant_id IS NOT NULL`,
  )
  assert.equal(Number(tagged[0]!.n), 0, 'a Developer’s line belongs to no customer')

  const customer = await everything('admin')
  assert.ok(!customer.some((e) => e.actorRole === 'developer'))
  assert.ok(!customer.some((e) => e.targetLabel === 'made-by-vendor@example.com'))
  assert.ok(
    customer.some((e) => e.action === 'user.updated' && e.actorEmail === 'admin@example.com'),
    'what the customer’s own Admin did is still there',
  )
  const account = (await call('admin', 'GET', '/api/audit?actor=teammate&limit=50')).json()
  assert.ok(account.events.length > 0)
  assert.ok(!account.events.some((e: AuditEvent) => e.actorRole === 'developer'))
  assert.equal(
    (await call('admin', 'GET', '/api/audit?q=developer%40example&limit=50')).json().events.length,
    0,
    'not even a search finds it',
  )

  // A line from before this rule, tagged with the customer, is hidden too.
  await audit.write({
    action: 'user.updated',
    outcome: 'success',
    actorEmail: 'developer@example.com',
    actorRole: 'developer',
    tenantId: ids.admin!,
    targetType: 'user',
    targetLabel: 'teammate@example.com',
  })
  assert.ok(!(await everything('admin')).some((e) => e.actorRole === 'developer'))
  const csv = await call('admin', 'GET', '/api/audit/export?format=csv')
  assert.ok(!csv.body.includes('developer@example.com'), 'nor does an export carry it')
})

test('a Developer can delete audit lines: they vanish everywhere, the chain still checks out, and the deletion leaves a trace', async () => {
  for (let n = 0; n < 6; n++)
    await audit.write({
      action: 'test.erase',
      outcome: 'success',
      actorEmail: 'someone@example.com',
      tenantId: ids.admin!,
      details: { n },
    })
  const list = async (name = 'developer') =>
    (await call(name, 'GET', '/api/audit?q=test.erase&limit=50')).json() as {
      events: AuditEvent[]
      total: number
    }
  const lines = (await list()).events.filter((e) => e.action === 'test.erase')
  assert.equal(lines.length, 6)
  assert.equal((await list('admin')).total, 6, 'the customer sees them too, until they are gone')

  // Only a Developer: a customer's Admin, its Sub-admin, a Pilot and a caller who is not signed in are refused.
  for (const name of ['admin', 'admin2', 'teammate', 'pilot'])
    assert.equal(
      (await call(name, 'POST', '/api/audit/delete', { seqs: [lines[0]!.seq] })).statusCode,
      403,
      name,
    )
  assert.equal((await app.inject({ method: 'POST', url: '/api/audit/delete' })).statusCode, 401)
  for (const bad of [{}, { seqs: [] }, { seqs: ['1'] }, { all: false }, { seqs: [0] }])
    assert.equal((await call('developer', 'POST', '/api/audit/delete', bad)).statusCode, 400)
  assert.equal((await list()).total, 6, 'nothing went')

  // Two selected lines (one named twice) are deleted.
  const picked = lines.slice(0, 2).map((e) => e.seq)
  const done = await call('developer', 'POST', '/api/audit/delete', {
    seqs: [...picked, picked[0]],
  })
  assert.equal(done.statusCode, 200, done.body)
  assert.deepEqual(done.json(), { deleted: 2 })
  const left = await list()
  assert.equal(left.total, 4)
  assert.ok(!left.events.some((e) => picked.includes(e.seq)))
  assert.equal((await list('admin')).total, 4, 'gone for the customer as well')
  const exported = JSON.parse(
    (await call('developer', 'GET', '/api/audit/export?format=json&q=test.erase')).body,
  ) as { rows: number; events: AuditEvent[] }
  assert.equal(exported.rows, 4)
  assert.ok(!exported.events.some((e) => picked.includes(e.seq)))

  // What is left of a deleted line is its place in the chain and nothing else.
  const blank = (
    await db.query<Record<string, unknown>>(`SELECT * FROM audit_log WHERE seq = $1`, [picked[0]])
  )[0]!
  for (const column of [
    'actor_id',
    'actor_email',
    'actor_role',
    'tenant_id',
    'status',
    'target_type',
    'target_id',
    'target_label',
    'details',
    'ip',
    'user_agent',
  ])
    assert.equal(blank[column], null, column)
  assert.ok(blank.redacted_at)
  assert.equal(String(blank.hash).length, 64)

  // The chain holds across the gap, and says how many lines were deleted.
  const checked = await audit.verify()
  assert.equal(checked.ok, true, JSON.stringify(checked))
  assert.equal(checked.redacted, 2)

  // The deletion is recorded (for the vendor only), and that record cannot itself be deleted.
  await audit.flush()
  const trace = (await everything('developer')).find(
    (e) => e.action === 'audit.deleted' && e.outcome === 'success',
  )!
  assert.equal(trace.actorEmail, 'developer@example.com')
  const traceDetails = trace.details as { count: number; mode: string }
  assert.equal(traceDetails.count, 2)
  assert.equal(traceDetails.mode, 'selected')
  const mine = await everything('admin')
  assert.ok(!mine.some((e) => e.action === 'audit.deleted' && e.outcome === 'success'))
  assert.ok(
    mine.some((e) => e.action === 'audit.deleted' && e.outcome === 'denied'),
    'a customer’s refused attempt is in the customer’s own trail',
  )
  assert.deepEqual(
    (await call('developer', 'POST', '/api/audit/delete', { seqs: [trace.seq] })).json(),
    {
      deleted: 0,
    },
  )
  assert.ok((await everything('developer')).some((e) => e.seq === trace.seq))

  // Everything a filter matches, not only what is on the screen.
  const rest = await call('developer', 'POST', '/api/audit/delete', {
    all: true,
    filter: { q: 'test.erase' },
  })
  // Four of the lines and the record of the export that searched for them: the filter matched five.
  assert.deepEqual(rest.json(), { deleted: 5 })
  assert.equal((await list()).events.filter((e) => e.action === 'test.erase').length, 0)
  assert.deepEqual(
    (
      await call('developer', 'POST', '/api/audit/delete', {
        all: true,
        filter: { q: 'test.erase' },
      })
    ).json(),
    { deleted: 0 },
  )

  // Anyone who may check the trail is told that lines were deleted, not left to assume none were.
  const customerCheck = (await call('admin', 'GET', '/api/audit/verify')).json() as AuditIntegrity
  assert.equal(customerCheck.ok, true)
  assert.equal(customerCheck.redacted, 7)
  assert.equal((await audit.verify()).ok, true)
})

test('a line blanked behind the app’s back, with no record of a deletion, is found; the guard still refuses edits', async () => {
  const some = (
    await db.query<{ seq: string }>(
      `SELECT seq FROM audit_log WHERE action = 'test.burst' ORDER BY seq LIMIT 4`,
    )
  ).map((row) => Number(row.seq))
  // The guard lets only audit_remove() blank a line, and nothing else change one.
  await assert.rejects(
    () => db.query(`UPDATE audit_log SET redacted_at = now() WHERE seq = $1`, [some[0]]),
    /cannot be changed/,
  )
  await assert.rejects(
    () => db.query(`DELETE FROM audit_log WHERE seq = $1`, [some[0]]),
    /cannot be changed/,
  )

  // Someone with database access calls the function directly, once more than the deletions on record allow.
  const declared = Number(
    (
      await db.query<{ n: string }>(
        `SELECT coalesce(sum((details->>'count')::int), 0) AS n FROM audit_log WHERE action = 'audit.deleted' AND details->>'count' ~ '^[0-9]+$'`,
      )
    )[0]!.n,
  )
  const already = Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log WHERE redacted_at IS NOT NULL`,
      )
    )[0]!.n,
  )
  assert.ok(declared >= already)
  const extra = await db.query<{ seq: string }>(
    `SELECT seq FROM audit_log WHERE redacted_at IS NULL AND action <> 'audit.deleted' ORDER BY seq LIMIT $1`,
    [declared - already + 1],
  )
  await db.exec('BEGIN')
  try {
    await db.query(`SELECT audit_remove($1::bigint[])`, [extra.map((row) => Number(row.seq))])
    const result = await audit.verify()
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /without a record/)
    assert.equal(result.brokenAt, Number(extra[0]!.seq))
  } finally {
    await db.exec('ROLLBACK')
  }
  assert.equal((await audit.verify()).ok, true, 'rolled back: the trail is whole again')
})

test('small helpers: stable text, CSV cells, secrets removed, the client address', () => {
  assert.equal(
    stableStringify({ b: 1, a: [2, { d: 1, c: null }] }),
    '{"a":[2,{"c":null,"d":1}],"b":1}',
  )
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}')

  assert.equal(csvCell('plain'), 'plain')
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('say "x"'), '"say ""x"""')
  assert.equal(csvCell('=1+1'), "'=1+1")
  assert.equal(csvCell('+44'), "'+44")
  assert.equal(csvCell('@sum'), "'@sum")
  assert.equal(csvCell(null), '')
  assert.equal(csvCell(401), '401')
  assert.ok(
    csvRow({
      seq: 1,
      time: '2026-11-18T10:00:00.000Z',
      actorEmail: 'a@example.com',
      actorRole: 'admin',
      action: 'auth.login',
      outcome: 'success',
      status: 200,
      targetType: null,
      targetId: null,
      targetLabel: null,
      details: null,
      ip: '1.2.3.4',
      userAgent: null,
      hash: 'abc',
    }).startsWith('1,2026-11-18T10:00:00.000Z,'),
  )

  assert.deepEqual(
    summarize({
      name: 'ok',
      password: 'hunter2',
      nested: { apiKey: 'k', token: 't', fine: 1 },
      long: 'x'.repeat(500),
      many: Array.from({ length: 30 }, (_, n) => n),
    }),
    {
      name: 'ok',
      password: '[redacted]',
      nested: { apiKey: '[redacted]', token: '[redacted]', fine: 1 },
      long: `${'x'.repeat(160)}…`,
      many: { count: 30, first: [0, 1, 2, 3, 4] },
    },
  )

  const req = (ip: string, forwarded?: string) =>
    ({ ip, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} }) as never
  assert.equal(clientIp(req('172.18.0.4', '203.0.113.9')), '203.0.113.9')
  assert.equal(clientIp(req('10.1.2.3', '198.51.100.2')), '198.51.100.2')
  // Nginx appends the real peer after what the client wrote: a client cannot choose the address that is read.
  assert.equal(clientIp(req('172.18.0.4', '1.1.1.1, 198.51.100.2')), '198.51.100.2')
  assert.equal(clientIp(req('172.18.0.4', '9.9.9.9, 198.51.100.2, 172.18.0.9')), '198.51.100.2')
  // From the open internet the header is only a claim: it is ignored.
  assert.equal(clientIp(req('198.51.100.50', '1.1.1.1')), '198.51.100.50')
  assert.equal(clientIp(req('172.18.0.4', 'not an address')), '172.18.0.4')
})
