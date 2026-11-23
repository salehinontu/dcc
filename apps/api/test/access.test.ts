import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { config } from '../src/config'
import { once } from 'node:events'
import { PGlite } from '@electric-sql/pglite'
import sharp from 'sharp'
import { can, defaultPermissions, PERMISSIONS, type Access, type Permission } from '@dji/protocol'
import { hashPassword, issueSession, publicUser } from '../src/auth'
import { migrate, type Db } from '../src/db'
import { Hub } from '../src/hub'
import { Registry } from '../src/registry'
import { buildServer } from '../src/server'
import { Store } from '../src/store'
import { MqttAuthorizer } from '../src/mqtt-auth'
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
const commands: string[] = []
const bridge = {
  connected: true,
  subscribed: true,
  callService: async (_sn: string, method: string) => {
    commands.push(method)
    return {}
  },
} as unknown as MqttBridge
const whep = new WhepSessions()
const manager = new StreamManager({ store, hub, bridge, whep })
const authorizer = new MqttAuthorizer(store)
let app: Awaited<ReturnType<typeof buildServer>>
const ids: Record<string, string> = {}
const password = 'initial-password-123'
const originalScreenshotDir = config.screenshotDir
let screenshotDir: string
async function token(name: string, gatewaySn?: string) {
  return issueSession({ ...publicUser((await store.findUserById(ids[name]!))!), gatewaySn }, store)
}
async function call(
  name: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await token(name)}` },
    payload,
  })
}
/**
 * Every screen is a grant of its own. These tests are about what an account may do with drones,
 * so unless a test is about screens, the account has all of them open.
 */
const SCREENS: Permission[] = [
  'map.view',
  'wall.view',
  'shots.view',
  'history.view',
  'fleet.view',
  'zones.view',
  'alerts.view',
]
async function account(
  name: string,
  role: string,
  access?: Partial<Access>,
  mustChangePassword = false,
) {
  const id = randomUUID()
  ids[name] = id
  await store.createUser(id, `${name}@example.com`, await hashPassword(password), role, {
    permissions: [
      ...new Set([
        ...(access?.permissions ?? defaultPermissions(role)),
        ...(role === 'pilot' ? [] : SCREENS),
      ]),
    ],
    allDrones: access?.allDrones ?? true,
    dronePermissions: access?.dronePermissions ?? {},
    mustChangePassword,
    // Everything that is not a Developer or an Admin works for the test installation's Admin.
    adminId: role === 'developer' || role === 'admin' ? null : (ids.admin ?? null),
  })
}
async function device(sn: string) {
  await store.claimDevice({
    sn,
    gatewaySn: 'controller',
    workspaceId: 'workspace',
    model: null,
    domain: 0,
    type: 1,
    subType: 0,
    controlIndex: 0,
  })
}

before(async () => {
  screenshotDir = await mkdtemp(join(tmpdir(), 'drone-rbac-images-'))
  Object.defineProperty(config, 'screenshotDir', { value: screenshotDir, configurable: true })
  // The fake images these tests upload are not worth counting people in.
  Object.defineProperty(config, 'peopleAutoCount', { value: false, configurable: true })
  await migrate(db)
  await account('root', 'developer')
  await account('admin', 'admin')
  await account('scoped', 'subadmin', {
    permissions: [],
    allDrones: false,
    dronePermissions: {
      alpha: [
        'drones.view',
        'telemetry.view',
        'streams.view',
        'screenshots.view',
        'screenshots.capture',
      ],
    },
  })
  await account('temp', 'subadmin', undefined, true)
  await account('binder', 'pilot')
  await device('alpha')
  await device('bravo')
  await device('deleted')
  await registry.init()
  app = await buildServer({ store, hub, registry, bridge, whep, manager, authorizer })
  await app.ready()
})
after(async () => {
  manager.dispose()
  await app.close()
  await db.close()
  Object.defineProperty(config, 'screenshotDir', { value: originalScreenshotDir })
  await rm(screenshotDir, { recursive: true, force: true })
})

test('scope grants do not confer user management, and view is mandatory for drone actions', () => {
  const user: Access = {
    role: 'subadmin',
    permissions: [],
    allDrones: false,
    dronePermissions: { alpha: ['users.manage', 'drones.delete'] },
  }
  assert.equal(can(user, 'users.manage'), false)
  assert.equal(can(user, 'drones.delete', 'alpha'), false)
  assert.equal(can(user, 'drones.view', 'bravo'), false)
  assert.equal(can(user, 'drones.view', '__proto__'), false)
  assert.equal(can(user, 'drones.view', 'constructor'), false)
})

test('an account flagged to change its password permits only identity/password; replacing it invalidates the old token', async () => {
  const oldToken = await token('temp')
  assert.equal((await call('temp', 'GET', '/api/me')).statusCode, 200)
  assert.equal((await call('temp', 'GET', '/api/devices')).statusCode, 403)
  // The controller contract is now: credentials first (`/api/pilot/auth`), then the
  // controller serial (`/api/pilot/login`). A temporary password fails at the first step.
  assert.equal(
    (
      await call('temp', 'POST', '/api/pilot/auth', {
        username: 'temp@example.com',
        password,
        controllerSn: 'controller',
      })
    ).statusCode,
    403,
  )
  assert.equal(
    (
      await call('temp', 'POST', '/api/auth/password', {
        currentPassword: password,
        newPassword: password,
      })
    ).statusCode,
    400,
  )
  assert.equal(
    (
      await call('temp', 'POST', '/api/auth/password', {
        currentPassword: password,
        newPassword: 'new-password-123',
      })
    ).statusCode,
    200,
  )
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${oldToken}` },
      })
    ).statusCode,
    401,
  )
  assert.equal((await store.findUserById(ids.temp!))!.must_change_password, false)
})

test('scoped users cannot enumerate another drone, telemetry, stream or screenshot', async () => {
  assert.deepEqual(
    (await call('scoped', 'GET', '/api/devices')).json().devices.map((d: { sn: string }) => d.sn),
    ['alpha'],
  )
  for (const suffix of ['telemetry', 'trail'])
    assert.equal((await call('scoped', 'GET', `/api/devices/bravo/${suffix}`)).statusCode, 403)
  const stream = await store.createStream({
    id: randomUUID(),
    deviceSn: 'bravo',
    videoId: 'bravo/cam/normal-0',
    streamKey: randomUUID(),
    quality: 2,
    requestedBy: null,
  })
  assert.equal((await call('scoped', 'GET', `/api/streams/${stream!.id}`)).statusCode, 403)
  assert.deepEqual((await call('scoped', 'GET', '/api/streams')).json().streams, [])
  for (const sn of ['alpha', 'bravo']) {
    await store.insertScreenshot({
      id: randomUUID(),
      deviceSn: sn,
      deviceLabel: sn,
      missionId: null,
      filename: `${sn}.png`,
      storageKey: `${sn}.png`,
      contentType: 'image/png',
      sizeBytes: 100,
      width: 10,
      height: 10,
      capturedAt: new Date().toISOString(),
      operatorId: null,
      lat: null,
      lon: null,
      altRel: null,
    })
  }
  const screenshots = (await call('scoped', 'GET', '/api/screenshots')).json().screenshots
  assert.deepEqual(
    screenshots.map((s: { deviceSn: string }) => s.deviceSn),
    ['alpha'],
  )
  const other = (await store.listScreenshots({ deviceSn: 'bravo', limit: 1 }))[0]
  assert.equal((await call('scoped', 'GET', `/api/screenshots/${other!.id}/image`)).statusCode, 403)
  assert.equal((await call('scoped', 'DELETE', '/api/devices/alpha')).statusCode, 403)
  assert.equal((await call('scoped', 'GET', '/api/debug/messages')).statusCode, 403)
})

test('a still has a small copy for the gallery: made once, cached, under the picture’s rights, and gone with the still', async () => {
  // A noisy picture, so the full one is big (a flat colour compresses to nothing and proves nothing).
  const big = await sharp({
    create: {
      width: 1600,
      height: 900,
      channels: 3,
      background: '#808080',
      noise: { type: 'gaussian', mean: 128, sigma: 50 },
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer()
  const post = async (sn: string) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/devices/${sn}/screenshots`,
      headers: { authorization: `Bearer ${await token('admin')}`, 'content-type': 'image/jpeg' },
      payload: big,
    })
    assert.equal(res.statusCode, 201, res.body)
    return res.json().screenshot.id as string
  }
  const alpha = await post('alpha')
  const bravo = await post('bravo')

  const first = await call('admin', 'GET', `/api/screenshots/${alpha}/thumbnail`)
  assert.equal(first.statusCode, 200)
  assert.equal(first.headers['content-type'], 'image/jpeg')
  assert.match(String(first.headers['cache-control']), /^private, max-age=\d+$/)
  const meta = await sharp(first.rawPayload).metadata()
  assert.equal(meta.width, 640)
  assert.equal(meta.height, 360, 'the shape of the picture is kept')
  assert.ok(
    first.rawPayload.length < big.length / 5,
    `the small copy (${first.rawPayload.length} B) is far smaller than the picture (${big.length} B)`,
  )
  const file = join(screenshotDir, '.thumbs', `${alpha}.jpg`)
  assert.ok((await stat(file)).isFile(), 'it is kept on disk')

  // Asked again it is served from that file, not made again.
  const before = (await stat(file)).mtimeMs
  const second = await call('admin', 'GET', `/api/screenshots/${alpha}/thumbnail`)
  assert.deepEqual(second.rawPayload, first.rawPayload)
  assert.equal((await stat(file)).mtimeMs, before)
  // The full picture is untouched and still never cached.
  const full = await call('admin', 'GET', `/api/screenshots/${alpha}/image`)
  assert.equal(full.rawPayload.length, big.length)
  assert.equal(full.headers['cache-control'], 'private, no-store')

  // The picture's rights apply: an account limited to alpha reads alpha's, not bravo's; nobody signed in reads none.
  assert.equal((await call('scoped', 'GET', `/api/screenshots/${alpha}/thumbnail`)).statusCode, 200)
  assert.equal((await call('scoped', 'GET', `/api/screenshots/${bravo}/thumbnail`)).statusCode, 403)
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/screenshots/${alpha}/thumbnail` })).statusCode,
    401,
  )
  assert.equal((await call('admin', 'GET', '/api/screenshots/not-an-id/thumbnail')).statusCode, 404)
  assert.equal(
    (await call('admin', 'GET', `/api/screenshots/${randomUUID()}/thumbnail`)).statusCode,
    404,
  )

  // A file that is not a picture has no small copy (the screen falls back to the picture); it breaks nothing.
  const broken = randomUUID()
  await writeFile(join(screenshotDir, 'broken-still.jpg'), 'this is not an image')
  await store.insertScreenshot({
    id: broken,
    deviceSn: 'alpha',
    deviceLabel: 'alpha',
    missionId: null,
    filename: 'broken-still.jpg',
    storageKey: 'broken-still.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 20,
    width: null,
    height: null,
    capturedAt: new Date().toISOString(),
    operatorId: null,
    lat: null,
    lon: null,
    altRel: null,
  })
  assert.equal((await call('admin', 'GET', `/api/screenshots/${broken}/thumbnail`)).statusCode, 404)

  // Deleting the still removes its small copy too.
  assert.equal((await call('admin', 'DELETE', `/api/screenshots/${alpha}`)).statusCode, 204)
  await assert.rejects(stat(file), 'the small copy goes with the still')
  assert.equal((await call('admin', 'GET', `/api/screenshots/${alpha}/thumbnail`)).statusCode, 404)
})

test('admin panel creates accounts and blocks role escalation/self/developer edits', async () => {
  const input = {
    email: 'created@example.com',
    password,
    role: 'subadmin',
    permissions: ['drones.view'],
    allDrones: true,
    dronePermissions: {},
  }
  const created = await call('admin', 'POST', '/api/users', input)
  assert.equal(created.statusCode, 201, created.body)
  assert.equal(created.json().user.mustChangePassword, false, 'the set password is the password')
  assert.equal('password_hash' in created.json().user, false)
  assert.equal(
    (
      await call('admin', 'POST', '/api/users', {
        ...input,
        email: 'root2@example.com',
        role: 'developer',
      })
    ).statusCode,
    400,
  )
  assert.equal(
    (
      await call('admin', 'POST', '/api/users', {
        ...input,
        email: 'admin2@example.com',
        role: 'admin',
      })
    ).statusCode,
    403,
  )
  // A Developer is not visible to an Admin at all, so it cannot even be addressed.
  assert.equal((await call('admin', 'PATCH', `/api/users/${ids.root}`, input)).statusCode, 404)
  assert.equal((await call('admin', 'PATCH', `/api/users/${ids.admin}`, input)).statusCode, 403)
  const oldToken = await token('scoped')
  const updated = await call('root', 'PATCH', `/api/users/${ids.scoped}`, {
    role: 'subadmin',
    permissions: [],
    allDrones: false,
    dronePermissions: {},
    disabled: true,
  })
  assert.equal(updated.statusCode, 200, updated.body)
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/devices',
        headers: { authorization: `Bearer ${oldToken}` },
      })
    ).statusCode,
    401,
  )
})

test('every Admin sees only its own accounts; a Developer sees them all, grouped by Admin', async () => {
  const fire = await call('root', 'POST', '/api/users', {
    email: 'fire-admin@example.com',
    password: 'fire-admin-pass',
    role: 'admin',
    permissions: [...PERMISSIONS],
    allDrones: true,
    dronePermissions: {},
  })
  assert.equal(fire.statusCode, 201, fire.body)
  const fireId = fire.json().user.id as string
  assert.equal(fire.json().user.adminId, fireId, 'an Admin belongs to itself')
  assert.equal(fire.json().user.createdBy, ids.root)
  await store.setUserAccess(ids.admin!, {
    role: 'admin',
    permissions: [...PERMISSIONS],
    allDrones: true,
    dronePermissions: {},
    disabled: false,
  })

  // Fire Service's Admin makes a Sub-admin and a Pilot; the test installation's Admin has its own.
  const fireToken = await issueSession(publicUser((await store.findUserById(fireId))!), store)
  const asFire = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${fireToken}` }, payload })
  const body = { allDrones: true, dronePermissions: {}, password: 'password-123' }
  const sub = await asFire('POST', '/api/users', {
    ...body,
    email: 'fire-sub@example.com',
    role: 'subadmin',
    permissions: ['drones.view', 'drones.bind', 'users.manage'],
  })
  const pilot = await asFire('POST', '/api/users', {
    ...body,
    email: 'fire-pilot@example.com',
    role: 'pilot',
    permissions: [],
  })
  assert.equal(sub.statusCode, 201, sub.body)
  assert.equal(pilot.statusCode, 201, pilot.body)
  assert.equal(sub.json().user.adminId, fireId)
  assert.equal(sub.json().user.createdBy, fireId)
  assert.equal(pilot.json().user.adminId, fireId)

  const emails = async (who: 'fire' | string) =>
    (
      (await (who === 'fire' ? asFire('GET', '/api/users') : call(who, 'GET', '/api/users'))).json()
        .users as { email: string }[]
    )
      .map((u) => u.email)
      .sort()

  // Fire Service sees itself and its own two, nobody else's.
  assert.deepEqual(await emails('fire'), [
    'fire-admin@example.com',
    'fire-pilot@example.com',
    'fire-sub@example.com',
  ])
  // The other Admin sees its own accounts and itself, none of Fire Service's.
  const other = await emails('admin')
  assert.ok(other.includes('admin@example.com'))
  assert.equal(
    other.some((e) => e.startsWith('fire-')),
    false,
  )
  // The Developer sees all of it, and each account says whose it is.
  const all = (await call('root', 'GET', '/api/users')).json().users as {
    email: string
    adminId: string | null
    createdByEmail: string | null
  }[]
  assert.equal(all.find((u) => u.email === 'fire-sub@example.com')?.adminId, fireId)
  assert.equal(
    all.find((u) => u.email === 'fire-sub@example.com')?.createdByEmail,
    'fire-admin@example.com',
  )
  assert.equal(all.find((u) => u.email === 'root@example.com')?.adminId, null)

  // The other Admin cannot reach Fire Service's accounts by id: they do not exist for it.
  const subId = sub.json().user.id as string
  assert.equal((await call('admin', 'DELETE', `/api/users/${subId}`)).statusCode, 404)
  assert.equal(
    (
      await call('admin', 'PATCH', `/api/users/${subId}`, {
        ...body,
        role: 'subadmin',
        permissions: ['drones.view'],
        disabled: false,
      })
    ).statusCode,
    404,
  )
  // And Fire Service cannot reach the other Admin, or anything of its.
  assert.equal((await asFire('DELETE', `/api/users/${ids.admin}`)).statusCode, 404)
  assert.equal((await asFire('DELETE', `/api/users/${ids.binder}`)).statusCode, 404)

  // A Sub-admin who manages users acts for the same Admin: it sees the same people, and what it
  // creates belongs to Fire Service too. It never sees the Admin above it.
  const subToken = await issueSession(publicUser((await store.findUserById(subId))!), store)
  const asSub = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${subToken}` }, payload })
  const subMade = await asSub('POST', '/api/users', {
    ...body,
    email: 'fire-sub-made@example.com',
    role: 'pilot',
    permissions: [],
  })
  assert.equal(subMade.statusCode, 201, subMade.body)
  assert.equal(subMade.json().user.adminId, fireId)
  const seenBySub = ((await asSub('GET', '/api/users')).json().users as { email: string }[]).map(
    (u) => u.email,
  )
  assert.ok(seenBySub.includes('fire-pilot@example.com'))
  assert.equal(seenBySub.includes('fire-admin@example.com'), false)
  assert.equal(
    seenBySub.some((e) => e === 'admin@example.com' || e === 'binder@example.com'),
    false,
  )

  // A Developer chooses the Admin for what it creates, or leaves it with none.
  const placed = await call('root', 'POST', '/api/users', {
    ...body,
    email: 'placed@example.com',
    role: 'subadmin',
    permissions: ['drones.view'],
    adminId: fireId,
  })
  assert.equal(placed.json().user.adminId, fireId)
  const unplaced = await call('root', 'POST', '/api/users', {
    ...body,
    email: 'unplaced@example.com',
    role: 'subadmin',
    permissions: ['drones.view'],
  })
  assert.equal(unplaced.json().user.adminId, null)
  assert.equal(
    (await emails('fire')).includes('unplaced@example.com'),
    false,
    'no Admin means only a Developer sees it',
  )
  const bad = await call('root', 'POST', '/api/users', {
    ...body,
    email: 'bad@example.com',
    role: 'subadmin',
    permissions: ['drones.view'],
    adminId: ids.binder,
  })
  assert.equal(bad.statusCode, 400, 'the owner must be an Admin')
  // An Admin's own request to place an account elsewhere is ignored.
  const sneaky = await asFire('POST', '/api/users', {
    ...body,
    email: 'sneaky@example.com',
    role: 'subadmin',
    permissions: ['drones.view'],
    adminId: ids.admin,
  })
  assert.equal(sneaky.json().user.adminId, fireId)

  // An Admin that still has accounts cannot be removed or demoted; once empty it can.
  assert.equal((await call('root', 'DELETE', `/api/users/${fireId}`)).statusCode, 409)
  assert.equal(
    (
      await call('root', 'PATCH', `/api/users/${fireId}`, {
        ...body,
        role: 'subadmin',
        permissions: ['drones.view'],
        disabled: false,
      })
    ).statusCode,
    409,
  )
  for (const email of ['fire-sub-made', 'fire-pilot', 'fire-sub', 'placed', 'sneaky']) {
    const row = await store.findUserByEmail(`${email}@example.com`)
    assert.equal((await call('root', 'DELETE', `/api/users/${row!.id}`)).statusCode, 204)
  }
  assert.equal((await call('root', 'DELETE', `/api/users/${fireId}`)).statusCode, 204)
})

test('anyone can change their own sign-in email: it needs the password and signs nobody out', async () => {
  const made = await call('admin', 'POST', '/api/users', {
    email: 'renamer@example.com',
    password: 'password-123',
    role: 'subadmin',
    permissions: ['drones.view'],
    allDrones: true,
    dronePermissions: {},
  })
  assert.equal(made.statusCode, 201, made.body)
  const id = made.json().user.id as string
  ids.renamer = id
  const bearer = await token('renamer')
  const change = (email: string, current = 'password-123') =>
    app.inject({
      method: 'POST',
      url: '/api/auth/email',
      headers: { authorization: `Bearer ${bearer}` },
      payload: { currentPassword: current, email },
    })
  const before = (await store.findUserById(id))!

  assert.equal((await change('new-name@example.com', 'wrong-password')).statusCode, 400)
  assert.equal((await change('not an email')).statusCode, 400)
  assert.equal((await change('RENAMER@example.com')).statusCode, 400, 'same address, any case')
  assert.equal((await change('Admin@Example.com')).statusCode, 409, "someone else's address")
  assert.equal(
    (await store.findUserById(id))!.email,
    'renamer@example.com',
    'refusals change nothing',
  )

  const ok = await change('New-Name@Example.com')
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json().email, 'new-name@example.com')

  // The same session still works and now carries the new address; nothing else moved.
  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { authorization: `Bearer ${bearer}` },
  })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().user.email, 'new-name@example.com')
  const after = (await store.findUserById(id))!
  assert.equal(after.session_version, before.session_version, 'a controller credential stays valid')
  assert.equal(after.password_hash, before.password_hash)

  const signIn = (email: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'password-123' },
    })
  assert.equal((await signIn('new-name@example.com')).statusCode, 200)
  assert.equal((await signIn('renamer@example.com')).statusCode, 401)
  // And it can be changed again, to an address that was just freed.
  assert.equal((await change('renamer@example.com')).statusCode, 200)

  // A Pilot is no different: only its own sign-in name moves.
  const pilot = await call('admin', 'POST', '/api/users', {
    email: 'rc-pilot@example.com',
    password: 'password-123',
    role: 'pilot',
    permissions: [],
    allDrones: false,
    dronePermissions: {},
  })
  ids['rc-pilot'] = pilot.json().user.id
  const pilotBearer = await token('rc-pilot')
  const renamed = await app.inject({
    method: 'POST',
    url: '/api/auth/email',
    headers: { authorization: `Bearer ${pilotBearer}` },
    payload: { currentPassword: 'password-123', email: 'rc-pilot-2@example.com' },
  })
  assert.equal(renamed.statusCode, 200, renamed.body)
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/pilot/auth',
        payload: { username: 'rc-pilot-2@example.com', password: 'password-123' },
      })
    ).statusCode,
    200,
    'the remote controller signs in with the new address',
  )
})

test('deleting an account: who may, what it takes with it, and who never can', async () => {
  const input = {
    password: 'set-by-admin-1',
    permissions: ['drones.view', 'drones.bind'],
    allDrones: true,
    dronePermissions: {},
  }
  // A Pilot whose controller has signed in and holds MQTT credentials.
  const made = await call('admin', 'POST', '/api/users', {
    ...input,
    email: 'doomed-pilot@example.com',
    role: 'pilot',
  })
  assert.equal(made.statusCode, 201, made.body)
  const doomed = made.json().user.id as string
  await store.upsertGatewayCredential(
    'doomed-rc',
    'doomed-rc-user',
    await hashPassword('mqtt-secret'),
    new Date(Date.now() + 3_600_000),
    doomed,
    0,
  )
  const signedIn = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'doomed-pilot@example.com', password: input.password },
  })
  assert.equal(signedIn.statusCode, 200, signedIn.body)
  const cookie = String(signedIn.headers['set-cookie'])
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
    200,
  )

  // Not yourself, not a Developer, not an Admin unless you are a Developer, not without the right.
  assert.equal((await call('admin', 'DELETE', `/api/users/${ids.admin}`)).statusCode, 403)
  // A Developer is invisible to an Admin, so it cannot be addressed at all.
  assert.equal((await call('admin', 'DELETE', `/api/users/${ids.root}`)).statusCode, 404)
  assert.equal((await call('root', 'DELETE', `/api/users/${ids.root}`)).statusCode, 403)
  assert.equal((await call('binder', 'DELETE', `/api/users/${doomed}`)).statusCode, 403)
  assert.equal((await call('admin', 'DELETE', `/api/users/${randomUUID()}`)).statusCode, 404)
  assert.ok(await store.findUserById(doomed), 'nothing was removed by the refusals')

  // An Admin removes the Pilot. Its sessions, credentials and sign-in all go.
  assert.equal((await call('admin', 'DELETE', `/api/users/${doomed}`)).statusCode, 204)
  assert.equal(await store.findUserById(doomed), null)
  assert.equal(await store.findGatewayCredentialByUsername('doomed-rc-user'), null)
  assert.equal(await authorizer.authenticate('doomed-rc-user', 'mqtt-secret'), false)
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
    401,
    'its session is gone',
  )
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'doomed-pilot@example.com', password: input.password },
      })
    ).statusCode,
    401,
  )
  assert.equal((await call('admin', 'DELETE', `/api/users/${doomed}`)).statusCode, 404)
  const listed = (await call('admin', 'GET', '/api/users')).json().users as { id: string }[]
  assert.equal(
    listed.some((u) => u.id === doomed),
    false,
  )

  // Only a Developer removes an Admin. Another Admin does not even see it.
  const second = await call('root', 'POST', '/api/users', {
    ...input,
    email: 'second-admin@example.com',
    role: 'admin',
    permissions: [...PERMISSIONS],
  })
  assert.equal(second.statusCode, 201, second.body)
  assert.equal(
    (await call('admin', 'DELETE', `/api/users/${second.json().user.id}`)).statusCode,
    404,
  )
  assert.equal(
    (await call('root', 'DELETE', `/api/users/${second.json().user.id}`)).statusCode,
    204,
  )
})

test('the password an admin sets works as it is: dashboard, Pilot controller and after a reset', async () => {
  const input = {
    email: 'as-set@example.com',
    password: 'set-by-admin-1',
    role: 'pilot',
    permissions: [],
    allDrones: false,
    dronePermissions: {},
  }
  const created = await call('admin', 'POST', '/api/users', input)
  assert.equal(created.statusCode, 201, created.body)
  assert.equal(created.json().user.mustChangePassword, false)

  const signIn = (email: string, pass: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: pass } })
  const controller = (email: string, pass: string) =>
    app.inject({
      method: 'POST',
      url: '/api/pilot/auth',
      payload: { username: email, password: pass },
    })
  const first = await signIn(input.email, input.password)
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json().user.mustChangePassword, false)
  assert.equal(
    (await controller(input.email, input.password)).statusCode,
    200,
    'straight to the RC',
  )

  // An admin reset is the same: the new password works at once and the old one stops.
  const id = created.json().user.id
  const reset = await call('admin', 'PATCH', `/api/users/${id}`, {
    ...input,
    password: 'reset-by-admin-2',
  })
  assert.equal(reset.statusCode, 200, reset.body)
  assert.equal(reset.json().user.mustChangePassword, false)
  assert.equal((await signIn(input.email, input.password)).statusCode, 401)
  assert.equal((await controller(input.email, 'reset-by-admin-2')).statusCode, 200)
  const after = await signIn(input.email, 'reset-by-admin-2')
  assert.equal(after.statusCode, 200, after.body)
  assert.equal(after.json().user.mustChangePassword, false)
})

test('disabling hides and stops an aircraft without deleting it, and an admin can undo it', async () => {
  const sn = 'bravo'
  const stream = await store.createStream({
    id: randomUUID(),
    deviceSn: sn,
    videoId: `${sn}/cam/disable-0`,
    streamKey: randomUUID(),
    quality: 2,
    requestedBy: null,
  })
  const disabled = await call('admin', 'POST', `/api/devices/${sn}/disable`, { enabled: false })
  assert.equal(disabled.statusCode, 200, disabled.body)

  // Hidden from the fleet, but not deleted: the two states must stay distinguishable, since
  // only one of them is undoable without the controller.
  assert.equal(await store.deviceUnavailable(sn), true)
  assert.equal(await store.deviceDeleted(sn), false)
  assert.equal(
    (await call('admin', 'GET', '/api/devices'))
      .json()
      .devices.some((d: { sn: string }) => d.sn === sn),
    false,
  )
  assert.equal((await store.getStream(stream!.id))!.state, 'stopped')

  // Ingest is refused: telemetry is dropped and the aircraft stays out of the live list.
  await store.insertSample({
    sn,
    ts: Date.now(),
    lat: 23,
    lon: 90,
    altRel: null,
    altAbs: null,
    heading: null,
    speedH: null,
    speedV: null,
    batteryPct: null,
    mode: null,
    gnss: null,
    rtk: null,
    raw: {},
  } as never)
  assert.equal(
    (await store.listDevices()).some((row) => row.sn === sn),
    false,
  )

  // The admin can see it, and knows why it is gone.
  const inventory = (await call('admin', 'GET', '/api/admin/devices')).json().devices
  const row = inventory.find((d: { sn: string }) => d.sn === sn)
  assert.ok(row, 'a disabled aircraft must stay visible to an admin')
  assert.ok(row.disabledAt)
  assert.equal(row.deletedAt, null)

  // Re-enabling restores it to the fleet without a controller.
  const enabled = await call('admin', 'POST', `/api/devices/${sn}/disable`, { enabled: true })
  assert.equal(enabled.statusCode, 200, enabled.body)
  assert.equal(await store.deviceUnavailable(sn), false)
  assert.ok(
    (await call('admin', 'GET', '/api/devices'))
      .json()
      .devices.some((d: { sn: string }) => d.sn === sn),
  )

  // An unknown serial is the one genuine miss.
  assert.equal(
    (await call('admin', 'POST', '/api/devices/no-such-drone/disable', { enabled: false }))
      .statusCode,
    404,
  )
})

test('deletion retains samples and screenshots, stops streams, ignores topology/OSD, and only RC rebind restores', async () => {
  const sn = 'deleted'
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWV8AAAAASUVORK5CYII=',
    'base64',
  )
  const captured = await app.inject({
    method: 'POST',
    url: `/api/devices/${sn}/screenshots`,
    headers: { authorization: `Bearer ${await token('admin')}`, 'content-type': 'image/png' },
    payload: image,
  })
  assert.equal(captured.statusCode, 201, captured.body)
  const screenshotId = captured.json().screenshot.id
  await db.query(`INSERT INTO telemetry_samples(device_sn, ts, lat, lon) VALUES ($1,now(),23,90)`, [
    sn,
  ])
  const stream = await store.createStream({
    id: randomUUID(),
    deviceSn: sn,
    videoId: `${sn}/cam/normal-0`,
    streamKey: randomUUID(),
    quality: 2,
    requestedBy: null,
  })
  const response = await call('admin', 'DELETE', `/api/devices/${sn}`)
  assert.equal(response.statusCode, 204, response.body)
  assert.equal((await store.getStream(stream!.id))!.state, 'stopped')
  assert.equal((await store.getScreenshot(screenshotId))!.device_sn, sn)
  const retainedImage = await call('admin', 'GET', `/api/screenshots/${screenshotId}/image`)
  assert.equal(retainedImage.statusCode, 200)
  assert.deepEqual(retainedImage.rawPayload, image)

  assert.ok(commands.includes('live_stop_push'))
  assert.equal(await manager.canPublish(stream!.stream_key), false)
  await registry.handle(
    'status',
    'controller',
    {
      tid: 't',
      bid: 'b',
      timestamp: Date.now(),
      data: {
        domain: 2,
        type: 1,
        sub_type: 0,
        sub_devices: [{ sn, domain: 0, type: 1, sub_type: 0, index: 'A' }],
      },
    },
    'sys/product/controller/status',
  )
  await registry.handle(
    'osd',
    sn,
    { tid: 't', bid: 'b', timestamp: Date.now(), data: { latitude: 24, longitude: 91 } },
    `thing/product/${sn}/osd`,
  )
  assert.equal(await store.deviceDeleted(sn), true)
  assert.equal((await store.telemetry(sn, new Date(0).toISOString())).length, 1)
  assert.equal(
    (await call('admin', 'GET', `/api/devices/${sn}/telemetry`)).json().samples.length,
    1,
  )
  const rcToken = await token('binder', 'controller')
  const bind = (deviceSn?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/pilot/bind',
      headers: { authorization: `Bearer ${rcToken}` },
      payload: { deviceSn },
    })
  assert.equal((await bind()).statusCode, 200)
  assert.equal(await store.deviceDeleted(sn), true)
  const rebound = await bind(sn)
  assert.equal(rebound.statusCode, 200, rebound.body)
  assert.equal(await store.deviceDeleted(sn), false)
  assert.equal((await store.deviceForStream(sn))!.online, false)
  assert.equal((await store.telemetry(sn, new Date(0).toISOString())).length, 1)
})

test('WebSocket snapshots/broadcasts/watches enforce scope and an account update ends the connection', async () => {
  await account('socket', 'subadmin', {
    permissions: [],
    allDrones: false,
    dronePermissions: { alpha: ['drones.view', 'streams.view'] },
  })
  const ws = await app.injectWS('/ws', {
    headers: { authorization: `Bearer ${await token('socket')}` },
  })
  const messages: { type: string; data?: { sn?: string } | unknown[] }[] = []
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())))
  const next = once(ws, 'message')
  ws.send(JSON.stringify({ type: 'subscribe', channels: ['devices'] }))
  await next
  hub.publish(['devices'], { type: 'device.cameras', data: { sn: 'bravo', cameras: [] } })
  hub.publish(['devices'], { type: 'device.cameras', data: { sn: 'alpha', cameras: [] } })
  await once(ws, 'message')
  assert.equal(
    messages.some(
      (m) => m.type === 'device.cameras' && !Array.isArray(m.data) && m.data?.sn === 'bravo',
    ),
    false,
  )
  ws.send(JSON.stringify({ type: 'watch', sns: ['bravo'] }))
  // Ping is processed after the watch and gives a deterministic synchronization point.
  ws.send(JSON.stringify({ type: 'ping' }))
  await once(ws, 'message')
  const closed = once(ws, 'close')
  const result = await call('root', 'PATCH', `/api/users/${ids.socket}`, {
    role: 'subadmin',
    permissions: [],
    allDrones: false,
    dronePermissions: {},
    disabled: true,
  })
  assert.equal(result.statusCode, 200)
  await closed
  assert.equal(hub.count(), 0)
})

test('playback reports require ownership, degrade actual quality, and media revocation works without a socket', async () => {
  let deletes = 0
  const media = createServer((req, res) => {
    if (req.method === 'DELETE') {
      deletes++
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(201, { location: '/session/active', 'content-type': 'application/sdp' })
    res.end('v=0\r\n')
  })
  await new Promise<void>((resolve) => media.listen(0, '127.0.0.1', resolve))
  const address = media.address() as { port: number }
  const previousTemplate = config.media.whepInternalTemplate
  Object.defineProperty(config.media, 'whepInternalTemplate', {
    value: `http://127.0.0.1:${address.port}/live/{key}/whep`,
    configurable: true,
  })
  try {
    await account('media', 'subadmin')
    const stream = await store.createStream({
      id: randomUUID(),
      deviceSn: 'alpha',
      videoId: 'alpha/cam/normal-0',
      streamKey: randomUUID(),
      quality: 2,
      requestedBy: null,
    })
    await store.markLive(stream!.id)
    const opened = await app.inject({
      method: 'POST',
      url: `/api/streams/${stream!.id}/whep`,
      headers: {
        authorization: `Bearer ${await token('media')}`,
        'content-type': 'application/sdp',
      },
      payload: 'v=0\r\n',
    })
    assert.equal(opened.statusCode, 201, opened.body)
    const sessionId = opened.headers.location!.split('/').pop()!
    const report = { sessionId, downlinkMbps: 0.8, concurrentStreams: 1, loss: 0, stalled: false }
    assert.equal(
      (await call('root', 'POST', `/api/streams/${stream!.id}/network`, report)).statusCode,
      403,
    )
    assert.equal(
      (await call('media', 'POST', `/api/streams/${stream!.id}/network`, report)).statusCode,
      204,
    )
    assert.equal((await store.getStream(stream!.id))!.quality, 1)
    assert.ok(commands.includes('live_set_quality'))
    // Simulate CLI/external DB revocation, where no panel callback or socket can help.
    await store.setUserAccess(ids.media!, {
      role: 'subadmin',
      permissions: [],
      allDrones: false,
      dronePermissions: {},
      disabled: false,
    })
    await whep.revalidate(store)
    assert.equal(whep.count(), 0)
    assert.ok(deletes > 0)
  } finally {
    Object.defineProperty(config.media, 'whepInternalTemplate', { value: previousTemplate })
    await new Promise<void>((resolve) => media.close(() => resolve()))
  }
})

test('a scoped pilot can announce its aircraft and gateway camera state, but cannot bind other aircraft', async () => {
  const sn = 'pilot-alpha'
  const gatewaySn = 'pilot-controller'
  await account('scoped-pilot', 'pilot', {
    permissions: [],
    allDrones: false,
    dronePermissions: { [sn]: ['drones.view', 'drones.bind'] },
  })
  // A controller must be an approved enrolment before it can be bound.
  await store.approveEnrollment(gatewaySn, [sn], 'test')
  const preauth = await call('scoped-pilot', 'POST', '/api/pilot/auth', {
    username: 'scoped-pilot@example.com',
    password,
  })
  assert.equal(preauth.statusCode, 200, preauth.body)
  const login = await app.inject({
    method: 'POST',
    url: '/api/pilot/login',
    headers: { authorization: `Bearer ${preauth.json().data.access_token}` },
    payload: { controllerSn: gatewaySn },
  })
  assert.equal(login.statusCode, 200, login.body)
  const credentials = await app.inject({
    method: 'GET',
    url: '/api/pilot/user-info',
    headers: {
      authorization: `Bearer ${login.json().data.access_token}`,
      cookie: `dji_session=${await token('root')}`,
    },
  })
  assert.equal(credentials.statusCode, 200)
  const mqttUser = credentials.json().data.mqtt_username
  const mqttPassword = credentials.json().data.mqtt_password
  assert.equal(await authorizer.authenticate(mqttUser, mqttPassword), true)
  await registry.handle(
    'status',
    gatewaySn,
    {
      tid: 't',
      bid: 'b',
      timestamp: Date.now(),
      data: {
        sub_devices: [
          { sn, domain: 0 },
          { sn: 'pilot-forbidden', domain: 0 },
        ],
      },
    },
    `sys/product/${gatewaySn}/status`,
  )
  assert.equal(await store.deviceExists(sn), true)
  assert.equal(await store.deviceExists('pilot-forbidden'), false)
  await registry.handle(
    'state',
    gatewaySn,
    {
      tid: 't',
      bid: 'b',
      timestamp: Date.now(),
      data: {
        live_capacity: {
          device_list: [
            {
              sn,
              camera_list: [{ camera_index: 'cam', video_list: [{ video_index: 'normal-0' }] }],
            },
          ],
        },
      },
    },
    `thing/product/${gatewaySn}/state`,
  )
  assert.equal((await store.deviceForStream(sn))!.cameras!.length, 1)
  assert.equal(await authorizer.authorize(mqttUser, `thing/product/${sn}/osd`, 'publish'), true)
  assert.equal(
    await authorizer.authorize(mqttUser, 'thing/product/pilot-forbidden/osd', 'publish'),
    false,
  )
  await store.setUserAccess(ids['scoped-pilot']!, {
    role: 'pilot',
    permissions: [],
    allDrones: false,
    dronePermissions: {},
    disabled: false,
  })
  assert.equal(await authorizer.authenticate(mqttUser, mqttPassword), false)
  assert.equal(await authorizer.authorize(mqttUser, `thing/product/${sn}/osd`, 'publish'), false)
})

test('a pilot who replaced a flagged password can still read the Pilot config', async () => {
  // The first password change bumps `session_version`; the pre-auth token must carry the new
  // value, or the very next request (`/api/pilot/config`) is rejected as a stale session.
  await account('fresh-pilot', 'pilot', undefined, true)
  const changed = await call('fresh-pilot', 'POST', '/api/auth/password', {
    currentPassword: password,
    newPassword: 'pilot-replaced-123',
  })
  assert.equal(changed.statusCode, 200, changed.body)
  const preauth = await app.inject({
    method: 'POST',
    url: '/api/pilot/auth',
    payload: { username: 'fresh-pilot@example.com', password: 'pilot-replaced-123' },
  })
  assert.equal(preauth.statusCode, 200, preauth.body)
  const pilotConfig = await app.inject({
    method: 'GET',
    url: '/api/pilot/config',
    headers: { authorization: `Bearer ${preauth.json().data.access_token}` },
  })
  assert.equal(pilotConfig.statusCode, 200, pilotConfig.body)
})

test('screenshots are deleted for good by an account that holds screenshots.delete, one or many', async () => {
  await account('seer', 'subadmin', {
    permissions: [],
    allDrones: false,
    dronePermissions: {
      alpha: ['drones.view', 'screenshots.view', 'screenshots.capture'],
    },
  })
  await account('cleaner', 'subadmin', {
    permissions: [],
    allDrones: false,
    dronePermissions: { alpha: ['drones.view', 'screenshots.view', 'screenshots.delete'] },
  })
  const make = async (sn: string, name: string) => {
    const id = randomUUID()
    await writeFile(join(screenshotDir, name), Buffer.from('fake image'))
    await store.insertScreenshot({
      id,
      deviceSn: sn,
      deviceLabel: sn,
      missionId: null,
      filename: name,
      storageKey: name,
      contentType: 'image/png',
      sizeBytes: 10,
      width: 1,
      height: 1,
      capturedAt: new Date().toISOString(),
      operatorId: null,
      lat: null,
      lon: null,
      altRel: null,
    })
    return id
  }
  const exists = async (name: string) =>
    stat(join(screenshotDir, name)).then(
      () => true,
      () => false,
    )
  const a1 = await make('alpha', 'del-a1.png')
  const a2 = await make('alpha', 'del-a2.png')
  const a3 = await make('alpha', 'del-a3.png')
  const b1 = await make('bravo', 'del-b1.png')

  // Seeing and capturing is not deleting: the account needs the right itself.
  assert.equal((await call('seer', 'DELETE', `/api/screenshots/${a1}`)).statusCode, 403)
  assert.equal(
    (await call('seer', 'POST', '/api/screenshots/delete', { ids: [a1] })).statusCode,
    403,
  )
  assert.ok(await store.getScreenshot(a1))

  // One still: the row and the file go, and the audit log keeps who and which file.
  assert.equal((await call('cleaner', 'DELETE', `/api/screenshots/${a1}`)).statusCode, 204)
  assert.equal(await store.getScreenshot(a1), null)
  assert.equal(await exists('del-a1.png'), false)
  const event = (
    await db.query<{ payload: { by: string; filename: string } }>(
      `SELECT payload FROM device_events WHERE kind = 'screenshot.deleted' AND device_sn = 'alpha' AND payload->>'filename' = 'del-a1.png'`,
    )
  )[0]
  assert.deepEqual(event?.payload, { by: 'cleaner@example.com', filename: 'del-a1.png' })
  assert.equal((await call('cleaner', 'DELETE', `/api/screenshots/${a1}`)).statusCode, 404)

  // Another drone's still is out of this account's reach, as for every other screenshot route.
  assert.equal((await call('cleaner', 'DELETE', `/api/screenshots/${b1}`)).statusCode, 403)
  assert.ok(await store.getScreenshot(b1))
  assert.equal(await exists('del-b1.png'), true)

  // Many at once: what the account may delete goes, the rest is counted as skipped.
  const bulk = await call('cleaner', 'POST', '/api/screenshots/delete', {
    ids: [a2, a3, b1, randomUUID()],
  })
  assert.equal(bulk.statusCode, 200)
  assert.deepEqual(bulk.json(), { deleted: 2, skipped: 2 })
  assert.equal(await store.getScreenshot(a2), null)
  assert.equal(await store.getScreenshot(a3), null)
  assert.equal((await exists('del-a2.png')) || (await exists('del-a3.png')), false)
  assert.ok(await store.getScreenshot(b1))

  // An Admin holds the right by default, and a people count goes with its still.
  await store.savePeopleAnalysis({
    screenshotId: b1,
    stage: 'quick',
    model: 'test',
    aiCount: 3,
    detections: [],
    durationMs: 1,
    analyzedBy: null,
    replaceVerified: false,
  })
  assert.ok(await store.getPeople(b1))
  assert.equal((await call('admin', 'DELETE', `/api/screenshots/${b1}`)).statusCode, 204)
  assert.equal(await store.getPeople(b1), null)
  assert.equal(await exists('del-b1.png'), false)

  // Bad requests are refused, and the Developer may delete too.
  assert.equal(
    (await call('admin', 'POST', '/api/screenshots/delete', { ids: [] })).statusCode,
    400,
  )
  assert.equal(
    (await call('admin', 'POST', '/api/screenshots/delete', { ids: ['not-a-uuid'] })).statusCode,
    400,
  )
  const c1 = await make('bravo', 'del-c1.png')
  assert.equal((await call('root', 'DELETE', `/api/screenshots/${c1}`)).statusCode, 204)
})
