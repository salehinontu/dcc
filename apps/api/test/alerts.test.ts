import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import {
  defaultPermissions,
  type AlertRecord,
  type Permission,
  type ServerMessage,
  type TelemetrySample,
} from '@dji/protocol'
import { AlertMonitor, batteryLevel, type AlertRules } from '../src/alerts/monitor'
import { hashPassword, issueSession, publicUser } from '../src/auth'
import { migrate, type Db } from '../src/db'
import { FlightTracker } from '../src/flights/tracker'
import { GeoEngine } from '../src/geo/engine'
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
const alertsOf = (kind?: string, sn?: string) =>
  messages
    .filter((m) => m.type === 'alert' && (!kind || m.data.kind === kind))
    .map((m) => (m as { type: 'alert'; data: AlertRecord }).data)
    .filter((alert) => !sn || alert.deviceSn === sn)

let clock = 1_800_000_000_000
const flights = new FlightTracker(store, () => clock)
const geo = new GeoEngine(store, hub, (sn) => flights.activeFlightId(sn))
let app: Awaited<ReturnType<typeof buildServer>>
const ids: Record<string, string> = {}

const RULES: AlertRules = {
  linkLost: true,
  batteryLowPct: 30,
  batteryCriticalPct: 15,
  remainCriticalSeconds: 120,
}
const monitor = new AlertMonitor(
  store,
  hub,
  (sn) => `flight-${sn}`,
  RULES,
  () => clock,
)

function sample(
  sn: string,
  alt: number,
  extra: Partial<Pick<TelemetrySample, 'batteryPct' | 'remainFlightS'>> = {},
): TelemetrySample {
  return {
    sn,
    ts: clock,
    lat: 23.8,
    lon: 90.4,
    altRel: alt,
    altAbs: null,
    heading: 90,
    speedH: 6,
    speedV: 0,
    batteryPct: 90,
    remainFlightS: null,
    mode: 5,
    gnss: 18,
    rtk: null,
    raw: {},
    ...extra,
  }
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

async function account(
  name: string,
  role: string,
  access?: { dronePermissions?: Record<string, Permission[]> },
) {
  const id = randomUUID()
  ids[name] = id
  await store.createUser(
    id,
    `${name}@example.com`,
    await hashPassword('initial-password-123'),
    role,
    {
      permissions: access ? ['alerts.view', 'map.view'] : defaultPermissions(role),
      allDrones: !access,
      dronePermissions: access?.dronePermissions ?? {},
      mustChangePassword: false,
      adminId: role === 'subadmin' ? (ids.admin ?? null) : null,
    },
  )
}

async function call(name: string, method: 'GET' | 'POST', url: string) {
  const token = await issueSession(publicUser((await store.findUserById(ids[name]!))!), store)
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })
}

before(async () => {
  await migrate(db)
  await account('admin', 'admin')
  await account('scoped', 'subadmin', {
    dronePermissions: { alpha: ['drones.view', 'telemetry.view'] },
  })
  for (const sn of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'])
    await device(sn)
  await registry.init()
  app = await buildServer({ store, hub, registry, bridge, whep, manager, authorizer, geo, flights })
  await app.ready()
})
after(async () => {
  manager.dispose()
  await app.close()
  await db.close()
})

/* ------------------------------------------------------------------ battery */

test('battery level only gets worse within a flight, and a rule set to 0 is off', () => {
  const at = (batteryPct: number | null, remainFlightS: number | null = null) => ({
    batteryPct,
    remainFlightS,
  })
  assert.equal(batteryLevel(at(80), 'ok', RULES), 'ok')
  assert.equal(batteryLevel(at(30), 'ok', RULES), 'low')
  assert.equal(batteryLevel(at(31), 'ok', RULES), 'ok')
  assert.equal(batteryLevel(at(15), 'ok', RULES), 'critical')
  assert.equal(batteryLevel(at(15), 'low', RULES), 'critical')
  // A reading that bounces back (a calibration jump) does not downgrade the flight.
  assert.equal(batteryLevel(at(60), 'critical', RULES), 'critical')
  assert.equal(batteryLevel(at(60), 'low', RULES), 'low')
  // The aircraft's own estimate counts, whatever the percentage says.
  assert.equal(batteryLevel(at(60, 100), 'ok', RULES), 'critical')
  assert.equal(batteryLevel(at(60, 121), 'ok', RULES), 'ok')
  assert.equal(batteryLevel(at(null), 'ok', RULES), 'ok')
  // Off.
  const off = { batteryLowPct: 0, batteryCriticalPct: 0, remainCriticalSeconds: 0 }
  assert.equal(batteryLevel(at(5, 10), 'ok', off), 'ok')
  assert.equal(batteryLevel(at(15), 'ok', { ...RULES, batteryLowPct: 0 }), 'critical')
  assert.equal(batteryLevel(at(25), 'ok', { ...RULES, batteryLowPct: 0 }), 'ok')
})

test('a flying drone gets a low-battery warning, then a critical alert in its place', async () => {
  await monitor.onSample(sample('alpha', 40, { batteryPct: 80 }), true)
  assert.equal(alertsOf(undefined, 'alpha').length, 0)

  await monitor.onSample(sample('alpha', 40, { batteryPct: 29 }), true)
  const low = alertsOf('battery_low', 'alpha')
  assert.equal(low.length, 1)
  assert.equal(low[0]!.severity, 'warning')
  assert.equal(low[0]!.zoneId, null)
  assert.equal(low[0]!.distanceM, null)
  assert.equal(low[0]!.flightId, 'flight-alpha')
  assert.equal(low[0]!.lat, 23.8)
  assert.match(low[0]!.message, /battery is low: 29 % left/)

  // The same level again is not a new alert.
  await monitor.onSample(sample('alpha', 40, { batteryPct: 28 }), true)
  assert.equal(alertsOf('battery_low', 'alpha').length, 1)

  await monitor.onSample(sample('alpha', 40, { batteryPct: 14, remainFlightS: 150 }), true)
  const critical = alertsOf('battery_critical', 'alpha')
  assert.equal(critical.length, 1)
  assert.equal(critical[0]!.severity, 'critical')
  assert.match(critical[0]!.message, /battery is critical: 14 % left, about 3 min of flight time/)
  const cleared = alertsOf('battery_low', 'alpha').filter((alert) => alert.clearedAt)
  assert.equal(cleared.length, 1, 'the warning ends when the critical alert takes over')

  // A reading that bounces back neither clears nor repeats it.
  await monitor.onSample(sample('alpha', 40, { batteryPct: 55 }), true)
  assert.equal(alertsOf('battery_critical', 'alpha').length, 1)
  assert.equal(alertsOf('battery_critical', 'alpha').filter((alert) => alert.clearedAt).length, 0)

  // Landing ends it; the next flight starts fresh.
  await monitor.onFlightEnd('alpha')
  assert.equal(
    alertsOf('battery_critical', 'alpha').filter((alert) => alert.clearedAt).length,
    1,
    'the flight ended: the battery alert is over',
  )
  await monitor.onSample(sample('alpha', 40, { batteryPct: 12 }), true)
  assert.equal(alertsOf('battery_critical', 'alpha').filter((a) => !a.clearedAt).length, 2)
})

test('the aircraft’s own flight-time estimate raises a critical alert; a parked drone raises none', async () => {
  await monitor.onSample(sample('bravo', 30, { batteryPct: 70, remainFlightS: 100 }), true)
  const critical = alertsOf('battery_critical', 'bravo')
  assert.equal(critical.length, 1)
  assert.match(critical[0]!.message, /70 % left, about 2 min of flight time/)

  // Not flying: a flat battery on the ground is a charging job, not an emergency.
  await monitor.onSample(sample('charlie', 0, { batteryPct: 8 }), false)
  assert.equal(alertsOf(undefined, 'charlie').length, 0)
})

/* --------------------------------------------------------------- link lost */

test('an aircraft that was in the air and goes away raises contact lost, once, until it returns', async () => {
  await monitor.onSample(sample('delta', 45, { batteryPct: 61 }), true)
  clock += 3_000
  await monitor.onOffline('delta', 'disconnected', 'flight-delta')
  const lost = alertsOf('link_lost', 'delta')
  assert.equal(lost.length, 1)
  assert.equal(lost[0]!.severity, 'critical')
  assert.equal(lost[0]!.flightId, 'flight-delta')
  assert.equal(lost[0]!.lat, 23.8)
  assert.equal(lost[0]!.altRel, 45)
  assert.equal(lost[0]!.zoneId, null)
  assert.match(lost[0]!.message, /lost contact while flying: it dropped off its controller/)
  assert.match(lost[0]!.message, /45 m above take-off, battery 61 %/)

  // The second report of the same loss (the silence sweep) is not another alert.
  await monitor.onOffline('delta', 'silent', 'flight-delta')
  assert.equal(alertsOf('link_lost', 'delta').length, 1)

  // The flight closing does not end it: the aircraft is still out there.
  await monitor.onFlightEnd('delta')
  assert.equal(alertsOf('link_lost', 'delta').filter((alert) => alert.clearedAt).length, 0)

  // Back in contact: over.
  clock += 20_000
  await monitor.onSample(sample('delta', 38), true)
  const after = alertsOf('link_lost', 'delta')
  assert.equal(after.filter((alert) => alert.clearedAt).length, 1)
  const rows = await store.fleet.listAlerts({ deviceSn: 'delta', activeOnly: true, limit: 10 })
  assert.equal(rows.length, 0)
})

test('silence is reported with how long it lasted', async () => {
  await monitor.onSample(sample('echo', 25), true)
  clock += 50_000
  await monitor.onOffline('echo', 'silent', null)
  const [lost] = alertsOf('link_lost', 'echo')
  assert.match(lost!.message, /no data for 50 s/)
  assert.equal(lost!.flightId, 'flight-echo', 'falls back to the flight the tracker knows')
})

test('no contact alert for a normal power-off, an old reading, or with the rule off', async () => {
  // Landed (low and slow) and switched off.
  await monitor.onSample(sample('foxtrot', 0.4), true)
  await monitor.onOffline('foxtrot', 'disconnected', null)
  // Never flew.
  await monitor.onSample(sample('foxtrot', 0), false)
  await monitor.onOffline('foxtrot', 'disconnected', null)
  // Nothing known at all.
  await monitor.onOffline('foxtrot', 'silent', null)
  // The last time it was heard was long ago (an API restart in between): nothing to say about now.
  await monitor.onSample(sample('golf', 60), true)
  clock += 6 * 60_000
  await monitor.onOffline('golf', 'silent', null)
  assert.equal(alertsOf('link_lost', 'foxtrot').length, 0)
  assert.equal(alertsOf('link_lost', 'golf').length, 0)

  const quiet = new AlertMonitor(
    store,
    hub,
    () => null,
    { ...RULES, linkLost: false },
    () => clock,
  )
  await quiet.onSample(sample('hotel', 50), true)
  await quiet.onOffline('hotel', 'disconnected', null)
  assert.equal(alertsOf('link_lost', 'hotel').length, 0)
})

/* ---------------------------------------------------------------- who sees */

test('alerts about the aircraft are listed and acknowledged like zone alerts, for the right accounts', async () => {
  // delta's contact alert and alpha's battery alert exist; the scoped account may see only alpha.
  const admin = await call('admin', 'GET', '/api/alerts?limit=100')
  assert.equal(admin.statusCode, 200)
  const kinds = new Set(
    (admin.json().alerts as AlertRecord[]).map((alert) => `${alert.deviceSn}:${alert.kind}`),
  )
  assert.ok(kinds.has('alpha:battery_critical'))
  assert.ok(kinds.has('delta:link_lost'))
  assert.ok(kinds.has('bravo:battery_critical'))

  const scoped = await call('scoped', 'GET', '/api/alerts?limit=100')
  assert.equal(scoped.statusCode, 200)
  const own = scoped.json().alerts as AlertRecord[]
  assert.ok(own.length > 0, 'a team account still sees alerts that name no zone')
  assert.ok(own.every((alert) => alert.deviceSn === 'alpha'))
  assert.ok(own.some((alert) => alert.kind === 'battery_critical' && alert.zoneName === null))

  const open = own.find((alert) => alert.kind === 'battery_critical' && !alert.clearedAt)!
  const ack = await call('scoped', 'POST', `/api/alerts/${open.id}/ack`)
  assert.equal(ack.statusCode, 200)
  assert.ok(ack.json().alert.acknowledgedAt)

  const bravo = (admin.json().alerts as AlertRecord[]).find((alert) => alert.deviceSn === 'bravo')!
  assert.equal((await call('scoped', 'POST', `/api/alerts/${bravo.id}/ack`)).statusCode, 404)
})
