import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import {
  ACCOUNT_PERMISSIONS,
  defaultPermissions,
  PERMISSIONS,
  type LngLat,
  type Permission,
  type ZoneInput,
} from '@dji/protocol'
import { hashPassword, issueSession, publicUser } from '../src/auth'
import { migrate, type Db } from '../src/db'
import { FlightTracker } from '../src/flights/tracker'
import { GeoEngine } from '../src/geo/engine'
import { seedBuiltinZones } from '../src/geo/seed'
import { Hub } from '../src/hub'
import { MqttAuthorizer } from '../src/mqtt-auth'
import { Registry } from '../src/registry'
import { buildServer } from '../src/server'
import { Store } from '../src/store'
import { StreamManager } from '../src/streams/manager'
import { WhepSessions } from '../src/streams/whep'
import type { MqttBridge } from '../src/mqtt'

/**
 * One installation, three customers: the Developer's own drone and two client Admins, each with
 * a Pilot and a controller. A client must only ever see and change what is theirs.
 */
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
const flights = new FlightTracker(store)
const geo = new GeoEngine(store, hub, (sn) => flights.activeFlightId(sn))
let app: Awaited<ReturnType<typeof buildServer>>
const ids: Record<string, string> = {}

const origin: LngLat = [90.4, 23.8]
const circle = (radiusM: number): ZoneInput['shape'] => ({
  type: 'circle',
  center: origin,
  radiusM,
})
const zoneBody = (name: string) => ({
  kind: 'no_fly',
  name,
  category: 'custom',
  shape: circle(300),
  bufferM: 100,
})

/** Everything a drone can be given, without the account-wide grants. */
const DRONE_GRANTS = PERMISSIONS.filter((p) => !ACCOUNT_PERMISSIONS.includes(p))

async function call(
  name: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  const token = await issueSession(publicUser((await store.findUserById(ids[name]!))!), store)
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown> | undefined,
  })
}

async function account(
  name: string,
  role: string,
  access: {
    permissions?: Permission[]
    allDrones?: boolean
    dronePermissions?: Record<string, Permission[]>
    adminOf?: string
  } = {},
) {
  const id = randomUUID()
  ids[name] = id
  await store.createUser(
    id,
    `${name}@example.com`,
    await hashPassword('initial-password-123'),
    role,
    {
      permissions: access.permissions ?? defaultPermissions(role),
      allDrones: access.allDrones ?? role !== 'admin',
      dronePermissions: access.dronePermissions ?? {},
      mustChangePassword: false,
      adminId: access.adminOf ? ids[access.adminOf]! : null,
    },
  )
}

/** A controller a Pilot signed in, approved, flying the given drones. */
async function controller(sn: string, pilot: string, drones: string[]) {
  await store.createPendingEnrollment(sn, ids[pilot]!, 'workspace')
  await store.approveEnrollment(sn, drones, 'test')
  for (const drone of drones)
    await store.claimDevice({
      sn: drone,
      gatewaySn: sn,
      workspaceId: 'workspace',
      model: 'Test',
      domain: 0,
      type: 1,
      subType: 0,
      controlIndex: 0,
    })
}

const sns = (body: { devices: { sn: string }[] }) => body.devices.map((d) => d.sn).sort()

before(async () => {
  await migrate(db)
  await account('developer', 'developer')
  // Client Admins are limited to the drones the Developer ticks: nothing else is theirs.
  await account('clientA', 'admin', {
    permissions: defaultPermissions('admin'),
    allDrones: false,
    dronePermissions: { a1: DRONE_GRANTS },
  })
  await account('clientB', 'admin', {
    permissions: defaultPermissions('admin'),
    allDrones: false,
    dronePermissions: { b1: DRONE_GRANTS },
  })
  await account('pilotDev', 'pilot')
  await account('pilotA', 'pilot', { adminOf: 'clientA' })
  await account('pilotB', 'pilot', { adminOf: 'clientB' })
  await controller('ctl-dev', 'pilotDev', ['dev1'])
  await controller('ctl-a', 'pilotA', ['a1'])
  await controller('ctl-b', 'pilotB', ['b1'])
  await registry.init()
  app = await buildServer({ store, hub, registry, bridge, whep, manager, authorizer, geo, flights })
  await app.ready()
})

after(async () => {
  manager.dispose()
  await app.close()
  await db.close()
})

test("a client Admin sees its own drones and nobody else's, including in the inventory", async () => {
  assert.deepEqual(sns((await call('developer', 'GET', '/api/devices')).json()), [
    'a1',
    'b1',
    'dev1',
  ])
  assert.deepEqual(sns((await call('clientA', 'GET', '/api/devices')).json()), ['a1'])
  assert.deepEqual(sns((await call('clientB', 'GET', '/api/devices')).json()), ['b1'])

  assert.deepEqual(sns((await call('developer', 'GET', '/api/admin/devices')).json()), [
    'a1',
    'b1',
    'dev1',
  ])
  assert.deepEqual(sns((await call('clientA', 'GET', '/api/admin/devices')).json()), ['a1'])
})

test('a client Admin sees only its own controllers and cannot act on anyone elses', async () => {
  const names = async (who: string) =>
    (
      (await call(who, 'GET', '/api/admin/controllers')).json().controllers as {
        controllerSn: string
      }[]
    )
      .map((c) => c.controllerSn)
      .sort()
  assert.deepEqual(await names('developer'), ['ctl-a', 'ctl-b', 'ctl-dev'])
  assert.deepEqual(await names('clientA'), ['ctl-a'])
  assert.deepEqual(await names('clientB'), ['ctl-b'])

  for (const action of ['approve', 'reject', 'unbind'])
    assert.equal(
      (await call('clientA', 'POST', `/api/admin/controllers/ctl-dev/${action}`, {})).statusCode,
      404,
      `${action} on the Developer's controller`,
    )
  assert.equal(
    (await call('clientA', 'POST', '/api/admin/controllers/ctl-b/unbind', {})).statusCode,
    404,
  )
  // Naming a drone that is not theirs would hand it to the controller.
  assert.equal(
    (
      await call('clientA', 'POST', '/api/admin/controllers/ctl-a/approve', {
        aircraftSns: ['a1', 'dev1'],
      })
    ).statusCode,
    403,
  )
  assert.equal(
    (await call('clientA', 'POST', '/api/admin/controllers/ctl-a/approve', { aircraftSns: ['a1'] }))
      .statusCode,
    200,
  )
  // A controller nobody has registered yet can be staged by an Admin, and is then theirs.
  assert.equal(
    (await call('clientA', 'POST', '/api/admin/controllers/ctl-new/approve', { aircraftSns: [] }))
      .statusCode,
    200,
  )
  assert.deepEqual(await names('clientA'), ['ctl-a', 'ctl-new'])
  assert.deepEqual(await names('clientB'), ['ctl-b'])
})

test('zones: built-in ones are shared and read-only, custom ones belong to the team that drew them', async () => {
  await seedBuiltinZones(store)
  const idsOf = async (who: string) =>
    new Set(
      ((await call(who, 'GET', '/api/zones')).json().zones as { id: string }[]).map((z) => z.id),
    )

  const mine = (await call('developer', 'POST', '/api/zones', zoneBody('Developer only'))).json()
    .zone
  const a = (await call('clientA', 'POST', '/api/zones', zoneBody('Client A site'))).json().zone

  const seenByA = await idsOf('clientA')
  assert.ok(seenByA.has(a.id))
  assert.ok(!seenByA.has(mine.id), "the Developer's own zone is not a client's to read")
  assert.ok(seenByA.has('builtin-airport-dac'), 'built-in advisory zones are shared')
  const seenByB = await idsOf('clientB')
  assert.ok(!seenByB.has(a.id), "another customer's zone is hidden")
  assert.ok((await idsOf('developer')).has(a.id), 'a Developer sees every zone')

  // Seeing is not changing: only the team that drew it may, and a Developer.
  assert.equal(
    (await call('clientB', 'PUT', `/api/zones/${a.id}`, zoneBody('Hijacked'))).statusCode,
    403,
  )
  assert.equal((await call('clientB', 'DELETE', `/api/zones/${a.id}`)).statusCode, 403)
  assert.equal(
    (await call('clientA', 'PUT', `/api/zones/${mine.id}`, zoneBody('Hijacked'))).statusCode,
    403,
  )
  assert.equal((await call('clientA', 'DELETE', '/api/zones/builtin-airport-dac')).statusCode, 403)
  assert.equal(
    (await call('clientA', 'PUT', `/api/zones/${a.id}`, zoneBody('Renamed'))).statusCode,
    200,
  )
  assert.equal((await call('clientA', 'DELETE', `/api/zones/${a.id}`)).statusCode, 204)
})

test('each screen is its own grant and is enforced by the API', async () => {
  const screens = {
    zones: ['zones.view', '/api/zones'],
    alerts: ['alerts.view', '/api/alerts'],
    inventory: ['inventory.manage', '/api/admin/devices'],
  } as const
  const withOnly = async (name: string, grants: Permission[]) =>
    account(name, 'subadmin', {
      permissions: grants,
      allDrones: true,
      adminOf: 'clientA',
    })

  await withOnly('nothing', ['users.manage'])
  for (const [, url] of Object.values(screens))
    assert.equal((await call('nothing', 'GET', url)).statusCode, 403, url)
  // The old rule: users.manage opened the inventory too. It no longer does.
  assert.equal((await call('nothing', 'GET', '/api/users')).statusCode, 200)

  for (const [grant, url] of Object.values(screens)) {
    const name = `only-${grant}`
    await withOnly(name, [grant, 'drones.view'])
    assert.equal((await call(name, 'GET', url)).statusCode, 200, `${grant} opens ${url}`)
  }
})

test('turning the Screenshots or Flight history screen off closes its data, whatever the drone rights say', async () => {
  const dataScreens = [
    ['shots.view', 'screenshots.view', '/api/screenshots'],
    ['history.view', 'flights.view', '/api/flights'],
  ] as const
  for (const [screen, right, url] of dataScreens) {
    await account(`right-only-${screen}`, 'subadmin', {
      permissions: [right, 'drones.view'],
      allDrones: true,
      adminOf: 'clientA',
    })
    assert.equal((await call(`right-only-${screen}`, 'GET', url)).statusCode, 403, `${url} closed`)
    await account(`screen-and-right-${screen}`, 'subadmin', {
      permissions: [screen, right, 'drones.view'],
      allDrones: true,
      adminOf: 'clientA',
    })
    assert.equal(
      (await call(`screen-and-right-${screen}`, 'GET', url)).statusCode,
      200,
      `${url} open`,
    )
  }
})

test('a Pilot account has no dashboard: no fleet list and no screens', async () => {
  assert.deepEqual((await call('pilotA', 'GET', '/api/devices')).json().devices, [])
  for (const url of ['/api/zones', '/api/alerts', '/api/admin/devices'])
    assert.equal((await call('pilotA', 'GET', url)).statusCode, 403, url)
})

test("a client's own new drone is given to its Admin once, and to nobody else", async () => {
  const claim = (gatewaySn: string, sn: string) =>
    store.claimDevice({
      sn,
      gatewaySn,
      workspaceId: 'workspace',
      model: 'Test',
      domain: 0,
      type: 1,
      subType: 0,
      controlIndex: 0,
    })

  // A controller approved without a list of drones takes whichever it flies.
  await controller('ctl-a-open', 'pilotA', [])
  await claim('ctl-a-open', 'a2')
  const grants = async (name: string) => (await store.findUserById(ids[name]!))!.drone_permissions
  assert.ok(Object.hasOwn(await grants('clientA'), 'a2'), "its Pilot's controller flew it")
  assert.ok((await grants('clientA'))['a2']!.includes('drones.view'))
  assert.ok(!Object.hasOwn(await grants('clientB'), 'a2'))
  assert.deepEqual(Object.keys(await grants('developer')), [])

  // The Developer's own controller (a Pilot with no Admin) gives its drones to nobody.
  await claim('ctl-dev', 'dev2')
  assert.ok(!Object.hasOwn(await grants('clientA'), 'dev2'))
  assert.ok(!Object.hasOwn(await grants('clientB'), 'dev2'))

  // Taking a drone away sticks: seeing it again later does not give it back.
  await store.setUserAccess(ids.clientA!, {
    role: 'admin',
    permissions: defaultPermissions('admin'),
    allDrones: false,
    dronePermissions: { a1: DRONE_GRANTS },
    disabled: false,
  })
  await claim('ctl-a-open', 'a2')
  assert.ok(!Object.hasOwn(await grants('clientA'), 'a2'))
})

test('the screen-permission migration runs once, so a screen switched off stays off', async () => {
  const id = randomUUID()
  await store.createUser(
    id,
    'legacy@example.com',
    await hashPassword('initial-password-123'),
    'subadmin',
    {
      permissions: ['users.manage', 'drones.view'],
      allDrones: true,
      dronePermissions: {},
    },
  )
  await db.query(`DELETE FROM schema_marks WHERE name = 'screen_permissions'`)
  await migrate(db)
  const after = (await store.findUserById(id))!.permissions
  for (const grant of ['map.view', 'zones.view', 'alerts.view', 'inventory.manage'] as const)
    assert.ok(after.includes(grant), grant)

  // A Developer switches the map off; the next start must not switch it back on.
  await store.setUserAccess(id, {
    role: 'subadmin',
    permissions: ['users.manage', 'drones.view'],
    allDrones: true,
    dronePermissions: {},
    disabled: false,
  })
  await migrate(db)
  assert.ok(!(await store.findUserById(id))!.permissions.includes('map.view'))
})

test('the second screen migration also runs once and follows the drone rights an account had', async () => {
  const id = randomUUID()
  await store.createUser(
    id,
    'legacy2@example.com',
    await hashPassword('initial-password-123'),
    'subadmin',
    {
      permissions: [],
      allDrones: false,
      // Video and stills on one drone, nothing else: the other two screens must not appear.
      dronePermissions: { a1: ['drones.view', 'streams.view', 'screenshots.view'] },
    },
  )
  await db.query(`DELETE FROM schema_marks WHERE name = 'screen_permissions_2'`)
  await migrate(db)
  const granted = (await store.findUserById(id))!.permissions
  assert.ok(
    granted.includes('wall.view') &&
      granted.includes('shots.view') &&
      granted.includes('fleet.view'),
  )
  assert.ok(!granted.includes('history.view'), 'it could not read flights before')

  await store.setUserAccess(id, {
    role: 'subadmin',
    permissions: [],
    allDrones: false,
    dronePermissions: { a1: ['drones.view', 'streams.view', 'screenshots.view'] },
    disabled: false,
  })
  await migrate(db)
  assert.ok(!(await store.findUserById(id))!.permissions.includes('shots.view'), 'stays off')
})

test('an Admin limited to some drones can still make Sub-admins, Pilots and video-only drones, and a Developer sees all of it', async () => {
  const user = (email: string, role: string, extra: Record<string, unknown> = {}) => ({
    email,
    password: 'temporary-password-1',
    role,
    permissions: [] as Permission[],
    allDrones: false,
    dronePermissions: {},
    ...extra,
  })

  // A Sub-admin that works for it, with a part of its own access.
  const sub = await call(
    'clientA',
    'POST',
    '/api/users',
    user('sub-a@example.com', 'subadmin', {
      permissions: ['drones.view', 'drones.bind'],
      dronePermissions: { a1: ['drones.view', 'drones.bind'] },
    }),
  )
  assert.equal(sub.statusCode, 201, sub.body)
  ids.subA = sub.json().user.id
  assert.equal(sub.json().user.adminId, ids.clientA, 'it belongs to the Admin that made it')

  // A Pilot: fixed access, whatever the Admin sees. Its controller's drones then go to its Admin.
  const pilot = await call('clientA', 'POST', '/api/users', user('pilot-a2@example.com', 'pilot'))
  assert.equal(pilot.statusCode, 201, pilot.body)
  assert.equal(pilot.json().user.allDrones, true)
  assert.equal(pilot.json().user.adminId, ids.clientA)

  // Making another Admin stays with the Developer: each Admin is its own customer.
  assert.equal(
    (await call('clientA', 'POST', '/api/users', user('admin-a2@example.com', 'admin'))).statusCode,
    403,
  )

  // A video-only drone: the Admin and the Sub-admin each see what they make, and it is theirs alone.
  const made = await call('clientA', 'POST', '/api/video-sources', { name: 'Tower camera' })
  assert.equal(made.statusCode, 201, made.body)
  const tower = made.json().source.sn as string
  assert.ok(sns((await call('clientA', 'GET', '/api/devices')).json()).includes(tower))
  assert.ok(!sns((await call('clientB', 'GET', '/api/devices')).json()).includes(tower))
  assert.ok(sns((await call('developer', 'GET', '/api/devices')).json()).includes(tower))
  assert.equal((await call('clientB', 'DELETE', `/api/video-sources/${tower}`)).statusCode, 403)

  const bySub = await call('subA', 'POST', '/api/video-sources', { name: 'Gate camera' })
  assert.equal(bySub.statusCode, 201, bySub.body)
  const gate = bySub.json().source.sn as string
  assert.ok(sns((await call('subA', 'GET', '/api/devices')).json()).includes(gate), 'its maker')
  assert.ok(sns((await call('clientA', 'GET', '/api/devices')).json()).includes(gate), 'its Admin')
  assert.ok(!sns((await call('clientB', 'GET', '/api/devices')).json()).includes(gate))
  // The Sub-admin does not see what its Admin made, unless it was given it.
  assert.ok(!sns((await call('subA', 'GET', '/api/devices')).json()).includes(tower))

  // A Sub-admin without the right to bind cannot add one.
  await account('nobind', 'subadmin', {
    permissions: ['drones.view'],
    allDrones: true,
    adminOf: 'clientA',
  })
  assert.equal((await call('nobind', 'POST', '/api/video-sources', { name: 'No' })).statusCode, 403)

  // The Developer sees every account and every drone those Admins made.
  const everyone = (await call('developer', 'GET', '/api/users')).json().users as {
    email: string
  }[]
  for (const email of ['sub-a@example.com', 'pilot-a2@example.com'])
    assert.ok(
      everyone.some((u) => u.email === email),
      email,
    )
  assert.ok(sns((await call('developer', 'GET', '/api/admin/devices')).json()).includes(gate))
})

test('whoever may add a video-only drone may remove it, with or without the delete right', async () => {
  // subA may bind its drones but was never given drones.delete.
  const made = await call('subA', 'POST', '/api/video-sources', { name: 'Roof camera' })
  assert.equal(made.statusCode, 201, made.body)
  const sn = made.json().source.sn as string

  // Seeing it is not enough, and another customer cannot even see it.
  await account('seeonly', 'subadmin', {
    permissions: ['drones.view'],
    allDrones: true,
    adminOf: 'clientA',
  })
  assert.equal((await call('seeonly', 'DELETE', `/api/video-sources/${sn}`)).statusCode, 403)
  assert.equal((await call('clientB', 'DELETE', `/api/video-sources/${sn}`)).statusCode, 403)

  assert.equal((await call('subA', 'DELETE', `/api/video-sources/${sn}`)).statusCode, 204)
  assert.equal((await call('subA', 'DELETE', `/api/video-sources/${sn}`)).statusCode, 404)
})
