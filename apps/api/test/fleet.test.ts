import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import {
  DEVICE_LABEL_MAX,
  defaultPermissions,
  PERMISSIONS,
  type Permission,
  type AlertRecord,
  type LngLat,
  toTelemetrySample,
  type ServerMessage,
  type TelemetrySample,
  type ZoneInput,
} from '@dji/protocol'
import { hashPassword, issueSession, publicUser } from '../src/auth'
import { migrate, type Db } from '../src/db'
import { FlightTracker, LAND_CONFIRM_MS, SILENCE_MS } from '../src/flights/tracker'
import { BUILTIN_ZONES } from '../src/geo/builtin-zones'
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

const messages: ServerMessage[] = []
hub.add('capture', {
  send: (data) => messages.push(JSON.parse(data) as ServerMessage),
  readyState: 1,
})
hub.setChannels('capture', 'add', ['devices'])

let clock = 1_800_000_000_000
const flights = new FlightTracker(store, () => clock)
const geo = new GeoEngine(store, hub, (sn) => flights.activeFlightId(sn))
let app: Awaited<ReturnType<typeof buildServer>>
const ids: Record<string, string> = {}

async function token(name: string) {
  return issueSession(publicUser((await store.findUserById(ids[name]!))!), store)
}
async function call(
  name: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await token(name)}` },
    payload: payload as Record<string, unknown> | undefined,
  })
}
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
  access?: { dronePermissions?: Record<string, Permission[]>; permissions?: Permission[] },
) {
  const id = randomUUID()
  ids[name] = id
  await store.createUser(
    id,
    `${name}@example.com`,
    await hashPassword('initial-password-123'),
    role,
    {
      // Every screen is a grant of its own; these tests are about drones, so they are open.
      permissions: access
        ? [...new Set([...(access.permissions ?? []), ...SCREENS])]
        : defaultPermissions(role),
      allDrones: !access,
      dronePermissions: access?.dronePermissions ?? {},
      mustChangePassword: false,
      // A Sub-admin works for the test Admin, as it does in a real installation.
      adminId: role === 'subadmin' ? (ids.admin ?? null) : null,
    },
  )
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

const origin: LngLat = [90.4, 23.8]
const M_PER_DEG = (6_371_008.8 * Math.PI) / 180
const north = (m: number): LngLat => [origin[0], origin[1] + m / M_PER_DEG]

function sample(sn: string, ts: number, at: LngLat, alt: number, speed = 6): TelemetrySample {
  return {
    sn,
    ts,
    lat: at[1],
    lon: at[0],
    altRel: alt,
    altAbs: null,
    heading: 90,
    speedH: speed,
    speedV: 0,
    batteryPct: 90,
    remainFlightS: null,
    mode: 5,
    gnss: 18,
    rtk: null,
    raw: {},
  }
}

const circle = (center: LngLat, radiusM: number): ZoneInput['shape'] => ({
  type: 'circle',
  center,
  radiusM,
})
const alertsOf = (kind?: string) =>
  messages.filter((m) => m.type === 'alert' && (!kind || m.data.kind === kind)) as {
    type: 'alert'
    data: AlertRecord
  }[]

before(async () => {
  await migrate(db)
  await account('developer', 'developer')
  await account('admin', 'admin')
  await account('viewer', 'subadmin')
  await account('scoped', 'subadmin', {
    dronePermissions: { alpha: ['drones.view', 'telemetry.view', 'flights.view'] },
  })
  for (const sn of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']) await device(sn)
  await store.fleet.assignMissingColors()
  await registry.init()
  app = await buildServer({ store, hub, registry, bridge, whep, manager, authorizer, geo, flights })
  await app.ready()
})
after(async () => {
  manager.dispose()
  await app.close()
  await db.close()
})

/* ------------------------------------------------------------------- zones */

test('built-in zones are seeded once, and a deleted one stays deleted', async () => {
  const added = await seedBuiltinZones(store)
  assert.equal(added, BUILTIN_ZONES.length)
  assert.equal(await seedBuiltinZones(store), 0)
  const dac = (await store.fleet.listZones()).find((zone) => zone.id === 'builtin-airport-dac')
  assert.ok(dac && dac.kind === 'no_fly' && dac.source === 'builtin' && dac.bufferM > 0)

  // The built-in zones belong to the installation, not to a customer's Admin.
  assert.equal((await call('admin', 'DELETE', '/api/zones/builtin-airport-dac')).statusCode, 403)
  const removed = await call('developer', 'DELETE', '/api/zones/builtin-airport-dac')
  assert.equal(removed.statusCode, 204)
  assert.equal(await seedBuiltinZones(store), 0)
  assert.equal(
    (await store.fleet.listZones()).some((zone) => zone.id === 'builtin-airport-dac'),
    false,
  )
  for (const zone of await store.fleet.listZones()) await store.fleet.deleteZone(zone.id)
})

test('zones: anyone who can see aircraft sees them; only a zone manager changes them', async () => {
  const body = {
    kind: 'no_fly',
    name: 'Test airfield',
    category: 'airport',
    shape: circle(origin, 800),
    bufferM: 1500,
    notes: 'drawn by hand',
  }
  assert.equal((await call('viewer', 'POST', '/api/zones', body)).statusCode, 403)
  const created = await call('admin', 'POST', '/api/zones', body)
  assert.equal(created.statusCode, 201)
  const zone = created.json().zone
  assert.equal(zone.name, 'Test airfield')
  assert.equal(zone.bufferM, 1500)
  assert.equal(zone.source, 'custom')
  assert.ok(messages.some((m) => m.type === 'zones.changed'))

  const listed = await call('viewer', 'GET', '/api/zones')
  assert.equal(listed.statusCode, 200)
  assert.equal(listed.json().zones.length, 1)

  const edited = await call('admin', 'PUT', `/api/zones/${zone.id}`, { ...body, bufferM: 2500 })
  assert.equal(edited.json().zone.bufferM, 2500)
  assert.equal((await call('viewer', 'PUT', `/api/zones/${zone.id}`, body)).statusCode, 403)

  // A geofence has no warning distance, whatever was sent.
  const fence = await call('admin', 'POST', '/api/zones', {
    kind: 'geofence',
    name: 'Fence',
    shape: circle(origin, 1000),
    bufferM: 900,
    deviceSns: ['alpha'],
  })
  assert.equal(fence.json().zone.bufferM, 0)
  assert.deepEqual(fence.json().zone.deviceSns, ['alpha'])

  assert.equal(
    (await call('admin', 'DELETE', `/api/zones/${fence.json().zone.id}`)).statusCode,
    204,
  )
  assert.equal(
    (await call('admin', 'DELETE', `/api/zones/${fence.json().zone.id}`)).statusCode,
    404,
  )
  assert.equal((await call('admin', 'DELETE', `/api/zones/${zone.id}`)).statusCode, 204)
})

test('zones need the zones screen; aircraft-scoped geofences stay private', async () => {
  // An account with the zones screen and no aircraft grants at all still sees the no-fly zones.
  await account('nobody', 'subadmin', { dronePermissions: {}, permissions: ['zones.view'] })
  // A Pilot account has no screens: it only signs a controller in.
  await account('pilotonly', 'pilot')
  assert.equal((await call('pilotonly', 'GET', '/api/zones')).statusCode, 403)
  const noFly = (
    await call('admin', 'POST', '/api/zones', {
      kind: 'no_fly',
      name: 'Open to all',
      category: 'custom',
      shape: circle(origin, 500),
      bufferM: 300,
    })
  ).json().zone
  const everyone = (
    await call('admin', 'POST', '/api/zones', {
      kind: 'geofence',
      name: 'Whole fleet fence',
      shape: circle(origin, 900),
    })
  ).json().zone
  const scoped = (
    await call('admin', 'POST', '/api/zones', {
      kind: 'geofence',
      name: 'Bravo only',
      shape: circle(origin, 900),
      deviceSns: ['bravo'],
    })
  ).json().zone

  const seen = (await call('nobody', 'GET', '/api/zones')).json().zones as { id: string }[]
  assert.ok(
    seen.some((z) => z.id === noFly.id),
    'no-fly zones are visible',
  )
  assert.ok(
    seen.some((z) => z.id === everyone.id),
    'fleet-wide fences are visible',
  )
  assert.ok(
    !seen.some((z) => z.id === scoped.id),
    'a fence for an aircraft it cannot see is hidden',
  )
  // Seeing is not changing.
  assert.equal(
    (
      await call('nobody', 'POST', '/api/zones', {
        kind: 'no_fly',
        name: 'Nope',
        shape: circle(origin, 100),
      })
    ).statusCode,
    403,
  )
  // An account that can see bravo sees that fence, with only the serials it may see.
  const bravoUser = (await call('viewer', 'GET', '/api/zones')).json().zones as {
    id: string
    deviceSns: string[]
  }[]
  assert.deepEqual(bravoUser.find((z) => z.id === scoped.id)?.deviceSns, ['bravo'])

  for (const zone of [noFly, everyone, scoped])
    assert.equal((await call('admin', 'DELETE', `/api/zones/${zone.id}`)).statusCode, 204)
})

test('a Pilot account always has exactly the fixed controller access, whatever the form sent', async () => {
  const sent = {
    email: 'pilot-rights@example.com',
    password: 'temporary-password-1',
    role: 'pilot',
    permissions: ['drones.view', 'drones.bind', 'zones.manage', 'system.debug'],
    allDrones: false,
    dronePermissions: { alpha: ['drones.view', 'screenshots.view'] },
    disabled: false,
  }
  const created = await call('admin', 'POST', '/api/users', sent)
  assert.equal(created.statusCode, 201)
  const pilot = created.json().user
  assert.deepEqual(pilot.permissions, ['drones.view', 'drones.bind'])
  assert.equal(pilot.allDrones, true, 'a controller binds whichever aircraft it flies')
  assert.deepEqual(pilot.dronePermissions, {})

  const edited = await call('admin', 'PATCH', `/api/users/${pilot.id}`, {
    ...sent,
    password: undefined,
    permissions: [],
  })
  assert.equal(edited.statusCode, 200)
  const again = (await call('admin', 'GET', '/api/users')).json().users as {
    id: string
    permissions: string[]
    allDrones: boolean
  }[]
  const row = again.find((u) => u.id === pilot.id)
  assert.deepEqual(row?.permissions, ['drones.view', 'drones.bind'])
  assert.equal(row?.allDrones, true)

  // Other roles keep what they are given.
  const operator = await call('admin', 'POST', '/api/users', {
    ...sent,
    email: 'operator-rights@example.com',
    role: 'subadmin',
    allDrones: true,
    dronePermissions: {},
  })
  assert.ok(operator.json().user.permissions.includes('zones.manage'))
})

test('an Admin can give a Sub-admin every right; a Sub-admin only passes on what it holds', async () => {
  const everything = {
    email: 'deputy@example.com',
    password: 'temporary-password-1',
    role: 'subadmin',
    permissions: [...PERMISSIONS],
    allDrones: true,
    dronePermissions: {},
  }
  const deputy = await call('admin', 'POST', '/api/users', everything)
  assert.equal(deputy.statusCode, 201, deputy.body)
  assert.deepEqual(deputy.json().user.permissions, [...PERMISSIONS])
  // An Admin still cannot make an Admin; only a Developer can.
  const asAdmin = await call('admin', 'POST', '/api/users', {
    ...everything,
    email: 'second-admin@example.com',
    role: 'admin',
  })
  assert.equal(asAdmin.statusCode, 403)

  // A Sub-admin that may manage users, but holds only some rights.
  const managerId = randomUUID()
  ids.manager = managerId
  await store.createUser(
    managerId,
    'manager@example.com',
    await hashPassword('initial-password-123'),
    'subadmin',
    {
      permissions: ['users.manage', 'drones.view', 'drones.bind', 'telemetry.view'],
      allDrones: true,
      dronePermissions: {},
      mustChangePassword: false,
      adminId: ids.admin ?? null,
    },
  )
  const base = { password: 'temporary-password-1', allDrones: true, dronePermissions: {} }
  const ok = await call('manager', 'POST', '/api/users', {
    ...base,
    email: 'helper@example.com',
    role: 'subadmin',
    permissions: ['users.manage', 'drones.view', 'telemetry.view'],
  })
  assert.equal(ok.statusCode, 201, 'it passes on rights it holds, user management included')
  const wider = await call('manager', 'POST', '/api/users', {
    ...base,
    email: 'wider@example.com',
    role: 'subadmin',
    permissions: ['drones.view', 'zones.manage'],
  })
  assert.equal(wider.statusCode, 403, 'never a right it does not hold')
  const admin = await call('manager', 'POST', '/api/users', {
    ...base,
    email: 'not-admin@example.com',
    role: 'admin',
    permissions: ['drones.view'],
  })
  assert.equal(admin.statusCode, 403)
  const pilot = await call('manager', 'POST', '/api/users', {
    ...base,
    email: 'manager-pilot@example.com',
    role: 'pilot',
    permissions: [],
  })
  assert.equal(pilot.statusCode, 201, 'it holds see-and-bind on every aircraft, so it may')
  // It never sees, or edits, an Admin.
  const listed = (await call('manager', 'GET', '/api/users')).json().users as { role: string }[]
  assert.equal(
    listed.some((u) => u.role === 'admin' || u.role === 'developer'),
    false,
  )
  assert.equal(
    (
      await call('manager', 'PATCH', `/api/users/${ids.admin}`, {
        ...base,
        role: 'subadmin',
        permissions: [],
      })
    ).statusCode,
    403,
  )
})

test('zones: bad shapes are refused with a reason', async () => {
  const bowtie = [
    [90.4, 23.8],
    [90.41, 23.81],
    [90.41, 23.8],
    [90.4, 23.81],
  ]
  const crossing = await call('admin', 'POST', '/api/zones', {
    kind: 'no_fly',
    name: 'Bowtie',
    shape: { type: 'polygon', ring: bowtie },
  })
  assert.equal(crossing.statusCode, 400)
  assert.match(crossing.json().error, /crosses itself/)
  const tiny = await call('admin', 'POST', '/api/zones', {
    kind: 'no_fly',
    name: 'Tiny',
    shape: circle(origin, 1),
  })
  assert.equal(tiny.statusCode, 400)
  const unnamed = await call('admin', 'POST', '/api/zones', {
    kind: 'no_fly',
    name: '',
    shape: circle(origin, 50),
  })
  assert.equal(unnamed.statusCode, 400)
})

/* ------------------------------------------------------------------ drones */

test('aircraft: names and colours', async () => {
  // Every aircraft gets its own colour.
  const devices = (await call('viewer', 'GET', '/api/devices')).json().devices
  const alpha = devices.find((d: { sn: string }) => d.sn === 'alpha')
  assert.match(alpha.color, /^#[0-9a-f]{6}$/)
  assert.equal(new Set(devices.map((d: { color: string }) => d.color)).size, devices.length)
  assert.equal('crew' in alpha, false, 'no pilot profile on an aircraft')

  // Rename and recolour one aircraft.
  const patched = await call('admin', 'PATCH', '/api/devices/alpha', {
    displayName: 'Drone 1',
    color: '#16A34A',
  })
  assert.equal(patched.statusCode, 200)
  assert.equal(patched.json().color, '#16a34a')
  const profile = messages.filter((m) => m.type === 'device.profile').at(-1)
  assert.ok(profile && profile.type === 'device.profile' && profile.data.sn === 'alpha')
  assert.equal(
    (await call('admin', 'PATCH', '/api/devices/alpha', { color: 'red' })).statusCode,
    400,
  )
  assert.equal((await call('admin', 'PATCH', '/api/devices/alpha', {})).statusCode, 400)
  assert.equal(
    (await call('viewer', 'PATCH', '/api/devices/alpha', { color: '#16a34a' })).statusCode,
    403,
  )
  // A nickname sits beside the name: stored trimmed, broadcast, listed, cleared with null.
  const labelled = await call('admin', 'PATCH', '/api/devices/alpha', { label: '  Fire-1  ' })
  assert.equal(labelled.statusCode, 200)
  assert.equal(labelled.json().label, 'Fire-1')
  assert.equal(labelled.json().displayName, 'Drone 1', 'a label change keeps the name')
  const labelProfile = messages.filter((m) => m.type === 'device.profile').at(-1)
  assert.ok(labelProfile && labelProfile.type === 'device.profile')
  assert.equal(labelProfile.data.label, 'Fire-1')
  const listed = (await call('viewer', 'GET', '/api/devices')).json().devices
  assert.equal(listed.find((d: { sn: string }) => d.sn === 'alpha').label, 'Fire-1')
  assert.ok(
    listed.some((d: { sn: string; label: unknown }) => d.sn !== 'alpha' && d.label === null),
    'other aircraft have no label',
  )
  assert.equal(
    (
      await call('admin', 'PATCH', '/api/devices/alpha', {
        label: 'x'.repeat(DEVICE_LABEL_MAX + 1),
      })
    ).statusCode,
    400,
  )
  assert.equal(
    (await call('viewer', 'PATCH', '/api/devices/alpha', { label: 'sneaky' })).statusCode,
    403,
  )
  assert.equal((await call('admin', 'PATCH', '/api/devices/nope', { label: 'a' })).statusCode, 404)
  // Records (screenshots, flights, alerts) name the aircraft the same way, from one SQL expression.
  assert.equal(await store.deviceLabel('alpha'), 'Drone 1 · Fire-1')
  const cleared = await call('admin', 'PATCH', '/api/devices/alpha', { label: '' })
  assert.equal(cleared.json().label, null)

  // The pilot-profile routes are gone, and the access policy refuses what it does not know.
  assert.equal((await call('admin', 'GET', '/api/crew')).statusCode, 404)
})

/* ----------------------------------------------------------------- alerts */

test('no-fly zone: a warning, then a breach, then clear again; ground aircraft are ignored', async () => {
  messages.length = 0
  const zone = await store.fleet.createZone(
    {
      kind: 'no_fly',
      name: 'Airfield',
      category: 'airport',
      shape: circle(origin, 500),
      bufferM: 1000,
      enabled: true,
      deviceSns: [],
      notes: '',
    },
    null,
  )
  await geo.reload()
  let t = clock
  const at = (distanceFromCentre: number, airborne = true) =>
    geo.onSample(sample('charlie', (t += 1000), north(distanceFromCentre), 40), airborne)

  await at(2500) // 2 km from the edge
  await at(1700) // 1.2 km: outside the 1 km warning band
  assert.equal(alertsOf().length, 0)

  await at(1400) // 900 m from the edge
  const warning = alertsOf('no_fly_warning')
  assert.equal(warning.length, 1)
  assert.equal(warning[0]!.data.severity, 'warning')
  assert.match(warning[0]!.data.message, /approaching the no-fly zone "Airfield"/)
  await at(700) // still in the band: no second alert
  assert.equal(alertsOf('no_fly_warning').length, 1)

  await at(450) // inside
  const breach = alertsOf('no_fly_breach')
  assert.equal(breach.length, 1)
  assert.equal(breach[0]!.data.severity, 'critical')
  assert.ok((breach[0]!.data.distanceM ?? 0) < 0)
  assert.ok(
    alertsOf('no_fly_warning').some((m) => m.data.clearedAt !== null),
    'the warning was cleared when the breach began',
  )

  await at(530) // out of the zone again but still in the band
  await at(2500) // far away
  const open = await store.fleet.listAlerts({ activeOnly: true, limit: 50 })
  assert.equal(open.length, 0, 'every alert is cleared once the aircraft is far away')
  const all = await store.fleet.listAlerts({ deviceSn: 'charlie', limit: 50 })
  assert.deepEqual(all.map((a) => a.kind).sort(), [
    'no_fly_breach',
    'no_fly_warning',
    'no_fly_warning',
  ])

  // The same position on the ground raises nothing.
  messages.length = 0
  await at(300, false)
  assert.equal(alertsOf().length, 0)
  await store.fleet.deleteZone(zone.id)
  await geo.reload()
})

test('geofence: leaving the fence alerts, coming back clears; other aircraft are not judged', async () => {
  messages.length = 0
  await store.fleet.createZone(
    {
      kind: 'geofence',
      name: 'Survey area',
      category: 'custom',
      shape: circle(origin, 1000),
      bufferM: 0,
      enabled: true,
      deviceSns: ['delta'],
      notes: '',
    },
    ids.admin ?? null,
  )
  await geo.reload()
  let t = clock + 10_000_000
  const at = (sn: string, distance: number) =>
    geo.onSample(sample(sn, (t += 1000), north(distance), 30), true)

  await at('delta', 400)
  await at('echo', 5000) // not on the fence's list
  assert.equal(alertsOf().length, 0)

  await at('delta', 1300)
  const exit = alertsOf('geofence_exit')
  assert.equal(exit.length, 1)
  assert.equal(exit[0]!.data.deviceSn, 'delta')
  assert.match(exit[0]!.data.message, /left the geofence "Survey area"/)
  await at('delta', 1400) // still outside: no repeat
  assert.equal(alertsOf('geofence_exit').length, 1)

  await at('delta', 600)
  assert.equal((await store.fleet.listAlerts({ activeOnly: true, limit: 10 })).length, 0)

  // Landing ends whatever was open, and acknowledging records who did it.
  await at('delta', 1500)
  const raised = (await store.fleet.listAlerts({ activeOnly: true, limit: 10 }))[0]!
  const acked = await call('viewer', 'POST', `/api/alerts/${raised.id}/ack`)
  assert.equal(acked.statusCode, 200)
  assert.equal(acked.json().alert.acknowledgedBy, ids.viewer)
  await geo.onFlightEnd('delta')
  assert.equal((await store.fleet.listAlerts({ activeOnly: true, limit: 10 })).length, 0)

  for (const zone of await store.fleet.listZones()) await store.fleet.deleteZone(zone.id)
  await geo.reload()
})

/* ---------------------------------------------------------------- flights */

async function fly(
  sn: string,
  from: number,
  profile: { airborneS: number; groundS: number; peakAlt?: number },
) {
  let t = from
  const record = async (alt: number, distance: number) => {
    const s = sample(sn, (t += 1000), north(distance), alt)
    await store.insertSample(s)
    clock = t
    return flights.onSample(s)
  }
  await record(0, 0)
  for (let i = 1; i <= profile.airborneS; i += 1)
    await record(Math.min(i * 3, profile.peakAlt ?? 60), i * 10)
  for (let i = 0; i <= profile.groundS; i += 1) await record(0.2, profile.airborneS * 10)
  return t
}

test('a flight is recorded from take-off to landing with its summary', async () => {
  const end = await fly('foxtrot', clock, { airborneS: 40, groundS: LAND_CONFIRM_MS / 1000 + 2 })
  assert.equal(flights.activeFlightId('foxtrot'), null, 'landed')
  const list = (await call('viewer', 'GET', '/api/flights?deviceSn=foxtrot')).json().flights
  assert.equal(list.length, 1)
  const flight = list[0]
  assert.equal(flight.status, 'completed')
  assert.equal('crew' in flight, false)
  assert.equal(flight.maxAltM, 60)
  assert.ok(flight.durationS >= 38 && flight.durationS <= 42)
  assert.ok(flight.distanceM > 350 && flight.distanceM < 450)
  assert.ok(flight.maxRangeM > 350)
  assert.ok(end > clock - 1)

  const detail = (await call('viewer', 'GET', `/api/flights/${flight.id}`)).json()
  assert.ok(detail.points.length >= 30)
  assert.ok(detail.points[0].ts < detail.points.at(-1).ts)
  assert.equal(detail.points.at(-1).alt !== null, true)
  assert.deepEqual(detail.alerts, [])

  // An account that may not see this aircraft cannot open its flight.
  assert.equal((await call('scoped', 'GET', `/api/flights/${flight.id}`)).statusCode, 404)
  assert.equal((await call('scoped', 'GET', '/api/flights')).json().flights.length, 0)
})

test('a hop is not a flight; going offline or silent ends one', async () => {
  // A hop: up for a few seconds and back down.
  await fly('alpha', clock + 5000, {
    airborneS: 3,
    groundS: LAND_CONFIRM_MS / 1000 + 2,
    peakAlt: 5,
  })
  assert.equal((await store.fleet.listFlights({ deviceSn: 'alpha', limit: 10 })).length, 0)

  // The link drops mid-flight.
  let t = clock + 5000
  for (let i = 0; i < 40; i += 1) {
    const s = sample('bravo', (t += 1000), north(i * 8), 30)
    await store.insertSample(s)
    await flights.onSample(s)
  }
  assert.ok(flights.activeFlightId('bravo'))
  const active = (await call('viewer', 'GET', '/api/flights?deviceSn=bravo')).json().flights[0]
  assert.equal(active.status, 'active')
  const live = (await call('viewer', 'GET', `/api/flights/${active.id}`)).json().flight
  assert.ok(live.durationS >= 38 && live.distanceM > 200, 'an active flight is summarised live')
  await flights.onOffline('bravo')
  assert.equal(flights.activeFlightId('bravo'), null)
  assert.equal((await store.fleet.getFlight(active.id))!.status, 'completed')

  // Silence: no sample for a minute ends the flight even without an offline event.
  t += 5000
  for (let i = 0; i < 30; i += 1) {
    const s = sample('echo', (t += 1000), north(i * 8), 30)
    await store.insertSample(s)
    await flights.onSample(s)
  }
  assert.ok(flights.activeFlightId('echo'))
  clock += SILENCE_MS + 1000
  await flights.sweep()
  assert.equal(flights.activeFlightId('echo'), null)
  assert.equal(
    (await store.fleet.listFlights({ deviceSn: 'echo', limit: 10 }))[0]!.status,
    'completed',
  )
})

test('a flight in the air shows live figures', async () => {
  const id = randomUUID()
  const started = new Date(clock + 300_000)
  await store.fleet.createFlight({
    id,
    deviceSn: 'echo',
    operatorEmail: null,
    controllerSn: null,
    startedAt: started,
    startLat: origin[1],
    startLon: origin[0],
  })
  for (let i = 0; i < 20; i += 1) {
    await store.insertSample(sample('echo', started.getTime() + i * 1000, north(i * 10), 45))
  }

  const listed = (await call('viewer', 'GET', '/api/flights?deviceSn=echo')).json().flights
  const live = listed.find((flight: { id: string }) => flight.id === id)
  assert.equal(live.status, 'active')
  assert.ok(live.distanceM > 150, 'distance so far, not zero')
  assert.equal(live.maxAltM, 45)

  // Leave nothing open for the tests that follow.
  assert.equal(await flights.recover(), 1)
})

test('a flight the last process left open is closed on start-up', async () => {
  const id = randomUUID()
  const started = new Date(clock + 100_000)
  await store.fleet.createFlight({
    id,
    deviceSn: 'delta',
    operatorEmail: null,
    controllerSn: null,
    startedAt: started,
    startLat: origin[1],
    startLon: origin[0],
  })
  for (let i = 0; i < 40; i += 1) {
    await store.insertSample(sample('delta', started.getTime() + i * 1000, north(i * 8), 30))
  }
  assert.equal(await flights.recover(), 1)
  const recovered = (await store.fleet.getFlight(id))!
  assert.equal(recovered.status, 'completed')
  assert.ok(recovered.durationS >= 38)
})

/* ----------------------------------------------------------- permissions */

test('accounts that predate Admin ownership go to the one Admin; with several they wait for a Developer', async () => {
  const fresh = new PGlite()
  const freshDb: Db = {
    query: async <T>(sql: string, params?: unknown[]) => (await fresh.query<T>(sql, params)).rows,
    exec: async (sql) => {
      await fresh.exec(sql)
    },
    close: () => fresh.close(),
  }
  const owned = new Store(freshDb)
  const hash = await hashPassword('initial-password-123')
  try {
    await migrate(freshDb)
    const seed = async (id: string, role: string) =>
      owned.createUser(id, `${id}@example.com`, hash, role, {
        permissions: defaultPermissions(role),
        allDrones: true,
        dronePermissions: {},
      })
    // Rows as an older release left them: no owner anywhere, and the one-time mark not yet made.
    await seed('only-admin', 'admin')
    await seed('legacy-sub', 'subadmin')
    await seed('legacy-pilot', 'pilot')
    await seed('a-developer', 'developer')
    await freshDb.exec(`UPDATE users SET admin_id = NULL WHERE role <> 'developer'`)
    await freshDb.exec(`DELETE FROM schema_marks WHERE name = 'users_admin_id'`)
    await migrate(freshDb)
    const row = async (id: string) => (await owned.findUserById(id))!
    assert.equal((await row('only-admin')).admin_id, 'only-admin', 'an Admin belongs to itself')
    assert.equal((await row('legacy-sub')).admin_id, 'only-admin')
    assert.equal((await row('legacy-pilot')).admin_id, 'only-admin')
    assert.equal((await row('a-developer')).admin_id, null, 'a Developer belongs to no Admin')

    // It runs once: a Developer's own account is never claimed by a later start-up.
    await seed('later-sub', 'subadmin')
    await migrate(freshDb)
    assert.equal((await row('later-sub')).admin_id, null)

    // With two Admins nothing is guessed.
    await seed('second-admin', 'admin')
    await freshDb.exec(`UPDATE users SET admin_id = NULL WHERE id = 'legacy-sub'`)
    await freshDb.exec(`DELETE FROM schema_marks WHERE name = 'users_admin_id'`)
    await migrate(freshDb)
    assert.equal((await row('legacy-sub')).admin_id, null, 'several Admins: left for a Developer')
  } finally {
    await fresh.close()
  }
})

test('accounts that predate the new roles and permissions are upgraded by the migration', async () => {
  const id = randomUUID()
  await store.createUser(
    id,
    'old-admin@example.com',
    await hashPassword('initial-password-123'),
    'admin',
    {
      permissions: ['users.manage', 'drones.view', 'telemetry.view', 'crew.manage'] as never,
      allDrones: true,
      dronePermissions: {},
      mustChangePassword: false,
    },
  )
  const oldRoot = randomUUID()
  await store.createUser(
    oldRoot,
    'old-root@example.com',
    await hashPassword('initial-password-123'),
    'superadmin',
  )
  const oldViewer = randomUUID()
  await store.createUser(
    oldViewer,
    'old-viewer@example.com',
    await hashPassword('initial-password-123'),
    'viewer',
    {
      permissions: ['drones.view', 'telemetry.view'],
      allDrones: true,
      dronePermissions: {},
      mustChangePassword: false,
    },
  )
  const waiting = randomUUID()
  await store.createUser(
    waiting,
    'waiting@example.com',
    await hashPassword('initial-password-123'),
    'subadmin',
    {
      permissions: ['drones.view'],
      allDrones: true,
      dronePermissions: {},
      mustChangePassword: true,
    },
  )
  const oldPilot = randomUUID()
  await store.createUser(
    oldPilot,
    'old-pilot@example.com',
    await hashPassword('initial-password-123'),
    'pilot',
    {
      permissions: ['drones.view', 'screenshots.view'],
      allDrones: false,
      dronePermissions: { alpha: ['drones.view', 'drones.bind'] },
      mustChangePassword: false,
    },
  )
  await migrate(db)
  await migrate(db) // idempotent
  const pilot = (await store.findUserById(oldPilot))!
  assert.deepEqual(pilot.permissions, ['drones.view', 'drones.bind'], 'a Pilot gets the fixed set')
  assert.equal(pilot.all_drones, true)
  assert.deepEqual(pilot.drone_permissions, {})
  assert.equal(
    (await store.findUserById(waiting))!.must_change_password,
    false,
    'an account waiting to change its password is released',
  )
  const admin = (await store.findUserById(id))!
  assert.ok(admin.permissions.includes('zones.manage'))
  assert.equal(
    (admin.permissions as string[]).includes('crew.manage'),
    false,
    'retired grant removed',
  )
  assert.ok(admin.permissions.includes('flights.view'))
  assert.equal(admin.permissions.filter((p) => p === 'zones.manage').length, 1)
  const viewer = (await store.findUserById(oldViewer))!
  assert.equal(viewer.role, 'subadmin')
  assert.equal((await store.findUserById(oldRoot))!.role, 'developer')
  assert.ok(viewer.permissions.includes('flights.view'))
  assert.equal(viewer.permissions.includes('zones.manage'), false)
})

/* ------------------------------------------------------- video-only drones */

test('video-only drones: DJI Fly pushes RTMP to a secret address and the drone shows up like any other', async () => {
  await account('bindless', 'subadmin', {
    dronePermissions: { alpha: ['drones.view'] },
  })
  await account('field', 'pilot')

  // Only an account that may bind drones, and sees all of them, adds one; a Pilot never does.
  const body = { name: 'Mini 5 Pro' }
  assert.equal((await call('scoped', 'POST', '/api/video-sources', body)).statusCode, 403)
  assert.equal((await call('bindless', 'POST', '/api/video-sources', body)).statusCode, 403)
  assert.equal((await call('field', 'POST', '/api/video-sources', body)).statusCode, 403)
  assert.equal((await call('field', 'GET', '/api/video-sources')).statusCode, 403)
  assert.equal((await call('admin', 'POST', '/api/video-sources', { name: '  ' })).statusCode, 400)

  const created = await call('admin', 'POST', '/api/video-sources', body)
  assert.equal(created.statusCode, 201)
  const source = created.json().source as {
    sn: string
    address: string
    key: string
    url: string
    name: string
  }
  assert.match(source.sn, /^RTMP-[0-9A-F]{8}$/)
  // Typed by hand on a controller: lower case, nothing that looks like another character.
  assert.match(source.key, /^[a-hj-km-np-z2-9]{20}$/)
  assert.match(source.address, /^rtmp:\/\/[^/]+\/live\/$/)
  assert.equal(source.url, `${source.address}${source.key}`)
  assert.equal(source.name, 'Mini 5 Pro')
  const listedSources = (await call('admin', 'GET', '/api/video-sources')).json().sources
  assert.equal(listedSources.length, 1)
  assert.equal(listedSources[0].key, source.key)

  // It is in the fleet as a drone with a name, a colour and a camera, but no position, no
  // telemetry and not yet online. A controller can never claim its serial.
  const fleet = (await call('viewer', 'GET', '/api/devices')).json().devices
  const drone = fleet.find((d: { sn: string }) => d.sn === source.sn)
  assert.ok(drone)
  assert.equal(drone.videoOnly, true)
  assert.equal(drone.displayName, 'Mini 5 Pro')
  assert.equal(drone.online, false)
  assert.equal(drone.telemetry, null)
  assert.match(drone.color, /^#[0-9a-f]{6}$/)
  assert.equal(drone.cameras.length, 1)
  assert.equal(
    fleet.filter((d: { videoOnly: boolean }) => d.videoOnly).length,
    1,
    'every other drone is a normal one',
  )
  assert.equal(
    await store.claimDevice({
      sn: source.sn,
      gatewaySn: 'controller',
      workspaceId: 'workspace',
      model: null,
      domain: 0,
      type: 1,
      subType: 0,
      controlIndex: 0,
    }),
    'conflict',
  )

  // The media server's publish check: this key, and only this key, may push while in service.
  assert.equal(await manager.canPublish(source.key), true)
  assert.equal(await manager.canPublish('not-a-key-we-made'), false)
  assert.equal(await manager.onPublish('not-a-key-we-made'), false)

  messages.length = 0
  assert.equal(await manager.onPublish(source.key), true)
  const live = (await store.activeStreamsForDevice(source.sn))[0]!
  assert.equal(live.state, 'live')
  assert.equal(live.stream_key, source.key)
  assert.ok(
    messages.some(
      (m) => m.type === 'device.status' && m.data.sn === source.sn && m.data.online === true,
    ),
  )
  assert.ok(
    messages.some(
      (m) => m.type === 'stream.state' && m.data.deviceSn === source.sn && m.data.phase === 'live',
    ),
  )
  const streamsNow = (await call('viewer', 'GET', '/api/streams')).json().streams
  assert.ok(streamsNow.some((s: { id: string }) => s.id === live.id))
  assert.equal(
    (await call('viewer', 'GET', '/api/devices'))
      .json()
      .devices.find((d: { sn: string }) => d.sn === source.sn).online,
    true,
  )

  // Nobody watching does not end a push that belongs to its pilot, and the silence timer
  // that takes a controller's drone offline leaves it alone.
  await db.query(`UPDATE devices SET last_seen_at = now() - interval '10 minutes' WHERE sn = $1`, [
    source.sn,
  ])
  const stale = await store.markStaleOffline(45)
  assert.equal(stale.includes(source.sn), false)
  await manager.sweep()
  assert.equal((await store.activeStreamsForDevice(source.sn)).length, 1)

  // Start, stop and quality are DJI Fly's: the controls answer "not here" rather than hanging.
  assert.equal(
    (await call('admin', 'POST', `/api/devices/${source.sn}/stream/stop`)).statusCode,
    409,
  )
  assert.equal(
    (await call('admin', 'POST', `/api/devices/${source.sn}/stream/resume`)).statusCode,
    409,
  )
  assert.equal(
    (await call('admin', 'PATCH', `/api/streams/${live.id}`, { quality: 1 })).statusCode,
    409,
  )

  // The pilot stops: the stream and the drone go off. Pressing Start again brings the same
  // stream back, so a player that follows its id simply carries on.
  messages.length = 0
  await manager.onUnpublish(source.key)
  assert.equal((await store.activeStreamsForDevice(source.sn)).length, 0)
  assert.equal((await store.getStream(live.id))?.state, 'stopped')
  assert.ok(
    messages.some(
      (m) => m.type === 'device.status' && m.data.sn === source.sn && m.data.online === false,
    ),
  )
  assert.equal(await manager.onPublish(source.key), true)
  const again = (await store.activeStreamsForDevice(source.sn))[0]!
  assert.equal(again.id, live.id)
  assert.ok(again.rev > live.rev)

  // A new key ends the push and the old key stops working at once.
  const rotated = await call('admin', 'POST', `/api/video-sources/${source.sn}/key`)
  assert.equal(rotated.statusCode, 200)
  const next = rotated.json().source as { key: string; sn: string }
  assert.notEqual(next.key, source.key)
  assert.equal(await manager.canPublish(source.key), false)
  assert.equal(await manager.canPublish(next.key), true)
  assert.equal((await store.activeStreamsForDevice(source.sn)).length, 0)
  assert.equal(
    (await call('admin', 'POST', '/api/video-sources/RTMP-00000000/key')).statusCode,
    404,
  )
  assert.equal((await call('admin', 'POST', '/api/video-sources/alpha/key')).statusCode, 400)

  // Out of service means no push: disable it and the key is refused, enable it and it works.
  assert.equal(
    (await call('admin', 'POST', `/api/devices/${source.sn}/disable`, { enabled: false }))
      .statusCode,
    200,
  )
  assert.equal(await manager.canPublish(next.key), false)
  assert.equal(await manager.onPublish(next.key), false)
  await call('admin', 'POST', `/api/devices/${source.sn}/disable`, { enabled: true })
  assert.equal(await manager.canPublish(next.key), true)

  // Removing it is final: no controller can prove custody, so the row and its key are gone.
  assert.equal((await call('viewer', 'DELETE', `/api/video-sources/${source.sn}`)).statusCode, 403)
  assert.equal((await call('admin', 'DELETE', `/api/video-sources/${source.sn}`)).statusCode, 204)
  assert.equal(await manager.canPublish(next.key), false)
  assert.equal(
    (await call('viewer', 'GET', '/api/devices'))
      .json()
      .devices.some((d: { sn: string }) => d.sn === source.sn),
    false,
  )
  assert.equal((await call('admin', 'DELETE', `/api/video-sources/${source.sn}`)).statusCode, 404)
})

/* ------------------------------------------------------- flight time left */

test('the dashboard list carries the aircraft’s flight time left, and a bad value never breaks it', async () => {
  await device('golf')
  let ts = 1_800_000_000_000
  const send = async (battery: unknown) => {
    ts += 1000
    const data = { elevation: 12, battery }
    const live = toTelemetrySample('golf', data, ts)
    await store.insertSample(live)
    const listed = (await registry.list()).find((d) => d.sn === 'golf')?.telemetry?.remainFlightS
    // The live message and the reloaded list read the same payload twice, once in TypeScript and
    // once in SQL: they must never disagree, or a page refresh would change the number.
    assert.equal(listed, live.remainFlightS)
    return listed
  }

  // Shapes from the real Matrice captures: seconds in the air, 0 once landed.
  assert.equal(await send({ capacity_percent: 43, remain_flight_time: 979 }), 979)
  assert.equal(await send({ capacity_percent: 43, remain_flight_time: 0 }), null)
  assert.equal(await send({ capacity_percent: 43 }), null)
  assert.equal(await send({ capacity_percent: 43, remain_flight_time: 1234.6 }), 1235)

  // Nothing an aircraft sends may stop the list from loading for everyone.
  assert.equal(await send({ capacity_percent: 43, remain_flight_time: 'soon' }), null)
  assert.equal(await send({ capacity_percent: 43, remain_flight_time: 1e30 }), null)
  assert.equal(await send({ capacity_percent: 43, remain_flight_time: -5 }), null)
  assert.equal(await send('not an object'), null)
})

test('a controller that describes its cameras before its topology is stored still gets them', async () => {
  // First contact: the controller announces `live_capacity` for an aircraft whose topology has not
  // been stored yet. The message used to be dropped, leaving the aircraft with no camera, so nothing
  // could be watched or recorded until the controller said it again (it only does when it changes).
  await store.approveEnrollment('cap-rc', [], 'test')
  await store.upsertGateway('cap-rc', 'workspace', null)
  await registry.handle(
    'state',
    'cap-rc',
    {
      tid: 't',
      bid: 'b',
      timestamp: Date.now(),
      data: {
        live_capacity: {
          device_list: [
            {
              sn: 'cap-drone',
              camera_list: [{ camera_index: 'cam', video_list: [{ video_index: 'normal-0' }] }],
            },
          ],
        },
      },
    },
    'thing/product/cap-rc/state',
  )
  assert.equal(await store.deviceForStream('cap-drone'), null, 'the aircraft is not known yet')

  // The topology arrives a moment later.
  await store.claimDevice({
    sn: 'cap-drone',
    gatewaySn: 'cap-rc',
    workspaceId: 'workspace',
    model: null,
    domain: 0,
    type: 1,
    subType: 0,
    controlIndex: 0,
  })

  // The registry asks again by itself (first retry after 2 s).
  let cameras = 0
  for (let i = 0; i < 40 && cameras === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    cameras = (await store.deviceForStream('cap-drone'))?.cameras?.length ?? 0
  }
  assert.equal(cameras, 1)
})
