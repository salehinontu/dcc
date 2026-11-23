import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { defaultPermissions } from '@dji/protocol'
import { AuditLog } from '../src/audit'
import { hashPassword, issueSession, publicUser } from '../src/auth'
import { migrate, type Db } from '../src/db'
import { Hub } from '../src/hub'
import { MqttAuthorizer } from '../src/mqtt-auth'
import { Registry } from '../src/registry'
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
const PASSWORD = 'initial-password-123'
/** Where Nginx sits in production: the compose network. */
const NGINX = '172.18.0.4'

let visitor = 0
/** A new visitor on the internet, behind Nginx, for every request that is not about the address. */
const somewhere = () => `203.0.${Math.floor(visitor / 250)}.${(visitor++ % 250) + 1}`

async function account(name: string, role: string, adminId: string | null = null) {
  const id = randomUUID()
  ids[name] = id
  await store.createUser(id, `${name}@example.com`, await hashPassword(PASSWORD), role, {
    permissions: defaultPermissions(role),
    allDrones: true,
    dronePermissions: {},
    mustChangePassword: false,
    adminId,
  })
}

const login = (email: string, password: string, from = somewhere(), remote = NGINX) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: remote,
    headers: { 'x-forwarded-for': from },
    payload: { email, password },
  })

const operatorLogin = (username: string, password: string, from = somewhere()) =>
  app.inject({
    method: 'POST',
    url: '/api/pilot/auth',
    remoteAddress: NGINX,
    headers: { 'x-forwarded-for': from },
    payload: { username, password, flag: 1 },
  })

before(async () => {
  await migrate(db)
  await account('boss', 'admin')
  // The Admin's own people, so the Admin may reset them.
  await account('victim', 'subadmin', ids.boss!)
  await account('steady', 'subadmin', ids.boss!)
  await account('operator', 'pilot')
  app = await buildServer({ store, hub, registry, bridge, whep, manager, authorizer, audit })
  await app.ready()
})

after(async () => {
  await app.close()
})

test('behind Nginx the rate limit counts each visitor, not Nginx; a forged address from the internet is not believed', async () => {
  // Ten tries a minute from one visitor, then that visitor waits...
  const statuses: number[] = []
  for (let n = 0; n < 11; n++)
    statuses.push((await login('nobody@example.com', 'wrong-password', '198.51.100.10')).statusCode)
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401))
  assert.equal(statuses[10], 429)
  // ...and everybody else behind the same Nginx can still sign in. (Before, Nginx was the only visitor the limit saw.)
  assert.equal((await login('boss@example.com', PASSWORD, '198.51.100.11')).statusCode, 200)

  // Someone reaching the API from a public address cannot pick a new X-Forwarded-For for every try.
  const direct = '198.51.100.20'
  const forged: number[] = []
  for (let n = 0; n < 11; n++)
    forged.push(
      (await login('nobody@example.com', 'wrong-password', `192.0.2.${n + 1}`, direct)).statusCode,
    )
  assert.equal(forged[10], 429, 'the forged addresses are ignored: it is one visitor')
})

test('ten wrong passwords in a row lock the account for a while, wherever they come from', async () => {
  const email = 'victim@example.com'
  for (let n = 1; n <= 9; n++) assert.equal((await login(email, `wrong-${n}`)).statusCode, 401)
  const tenth = await login(email, 'wrong-10')
  assert.equal(tenth.statusCode, 429)
  assert.match(tenth.json().error, /Too many wrong passwords\. Try again in 15 minutes/)

  // Locked: even the right password, from a fresh address, is refused, and so is the controller sign-in.
  const right = await login(email, PASSWORD)
  assert.equal(right.statusCode, 429)
  assert.ok(!right.cookies.some((c) => c.name === 'dji_session'))
  assert.equal((await operatorLogin(email, PASSWORD)).statusCode, 429)

  // When the lock ends, the right password works and the count starts again from nothing.
  await db.query(
    `UPDATE users SET login_locked_until = now() - interval '1 second' WHERE id = $1`,
    [ids.victim],
  )
  assert.equal((await login(email, PASSWORD)).statusCode, 200)
  const row = (await store.findUserById(ids.victim!))!
  assert.equal(row.login_failures, 0)
  assert.equal(row.login_locked_until, null)
})

test('a right password forgets the wrong ones before it, and an unknown email locks nothing', async () => {
  const email = 'steady@example.com'
  for (let round = 0; round < 3; round++) {
    for (let n = 0; n < 6; n++) assert.equal((await login(email, 'wrong')).statusCode, 401)
    assert.equal((await login(email, PASSWORD)).statusCode, 200, `round ${round}`)
  }
  for (let n = 0; n < 12; n++)
    assert.equal((await login('no-such-person@example.com', 'wrong')).statusCode, 401)
})

test('an administrator setting a new password lets a locked person back in', async () => {
  for (let n = 0; n < 10; n++) await login('victim@example.com', 'wrong')
  assert.equal((await login('victim@example.com', PASSWORD)).statusCode, 429)

  const token = await issueSession(publicUser((await store.findUserById(ids.boss!))!), store)
  const reset = await app.inject({
    method: 'PATCH',
    url: `/api/users/${ids.victim}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      role: 'subadmin',
      permissions: defaultPermissions('subadmin'),
      allDrones: true,
      dronePermissions: {},
      disabled: false,
      password: 'a-brand-new-password-9',
    },
  })
  assert.equal(reset.statusCode, 200, reset.body)
  assert.equal((await login('victim@example.com', 'a-brand-new-password-9')).statusCode, 200)
})

test('the controller sign-in counts wrong passwords too, and the trail shows each lock', async () => {
  for (let n = 0; n < 9; n++)
    assert.equal((await operatorLogin('operator@example.com', 'wrong')).statusCode, 401)
  const locked = await operatorLogin('operator@example.com', 'wrong')
  assert.equal(locked.statusCode, 429)
  assert.match(locked.json().message, /Too many wrong passwords/)
  assert.equal((await operatorLogin('operator@example.com', PASSWORD)).statusCode, 429)

  await audit.flush()
  const lines = await db.query<{
    action: string
    outcome: string
    actor_email: string
    ip: string
  }>(
    `SELECT action, outcome, actor_email, ip FROM audit_log WHERE details->>'locked' = 'true' ORDER BY seq`,
  )
  assert.ok(lines.some((l) => l.action === 'auth.login' && l.actor_email === 'victim@example.com'))
  assert.ok(
    lines.some((l) => l.action === 'pilot.login' && l.actor_email === 'operator@example.com'),
  )
  assert.ok(lines.every((l) => l.outcome === 'failure'))
  assert.ok(
    lines.every((l) => l.ip.startsWith('203.0.')),
    'the visitor’s address, not Nginx’s',
  )
})
