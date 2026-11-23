import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import {
  API_TOKEN_PREFIX,
  defaultPermissions,
  type ApiTokenCreated,
  type ApiTokenRecord,
  type ApiWhoami,
  type Permission,
} from '@dji/protocol'
import { hashApiToken, newApiToken, narrowAccess } from '../src/api-tokens'
import { hashPassword, issueSession, publicUser } from '../src/auth'
import { migrate, type Db } from '../src/db'
import { Hub } from '../src/hub'
import { MqttAuthorizer } from '../src/mqtt-auth'
import { Registry } from '../src/registry'
import { buildServer } from '../src/server'
import { Store } from '../src/store'
import { MediaExport } from '../src/streams/export'
import { StreamManager } from '../src/streams/manager'
import { WhepSessions } from '../src/streams/whep'
import type { MqttBridge } from '../src/mqtt'

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

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
let app: Awaited<ReturnType<typeof buildServer>>
const ids: Record<string, string> = {}

// A short test video the exporter reads instead of a live stream (its key is ignored).
const video = path.join(mkdtempSync(path.join(tmpdir(), 'api-export-')), 'feed.mp4')
const exporter = new MediaExport(
  { store, manager },
  {
    ffmpegPath: 'ffmpeg',
    inputUrl: () => video,
    waitMs: 700,
    maxLive: 1,
    frameCacheMs: 1000,
    realtimeInput: true,
  },
)

const READ: Permission[] = [
  'drones.view',
  'telemetry.view',
  'streams.view',
  'screenshots.view',
  'recordings.view',
  'flights.view',
]
const SCREENS: Permission[] = [
  'map.view',
  'wall.view',
  'shots.view',
  'recs.view',
  'history.view',
  'fleet.view',
  'zones.view',
  'alerts.view',
]

async function account(
  name: string,
  role: string,
  access?: {
    dronePermissions?: Record<string, Permission[]>
    permissions?: Permission[]
    adminOf?: string
  },
) {
  const id = randomUUID()
  ids[name] = id
  await store.createUser(
    id,
    `${name}@example.com`,
    await hashPassword('initial-password-123'),
    role,
    {
      permissions: access?.permissions ?? defaultPermissions(role),
      allDrones: !access?.dronePermissions,
      dronePermissions: access?.dronePermissions ?? {},
      mustChangePassword: false,
      adminId: access?.adminOf ? ids[access.adminOf]! : role === 'admin' ? id : null,
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

async function call(
  name: string,
  method: 'GET' | 'POST' | 'DELETE',
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

const withToken = (
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown> | undefined,
  })

async function makeToken(
  owner: string,
  body: { name: string; deviceSns?: string[] | null; expiresInDays?: number | null },
): Promise<ApiTokenCreated> {
  const res = await call(owner, 'POST', '/api/api-tokens', body)
  assert.equal(res.statusCode, 201, res.body)
  return res.json() as ApiTokenCreated
}

async function liveStream(sn: string) {
  const id = randomUUID()
  await store.createStream({
    id,
    deviceSn: sn,
    videoId: `${sn}/main`,
    streamKey: `key-${sn}`,
    quality: 0,
    requestedBy: null,
  })
  await store.markLive(id)
}

before(async () => {
  await migrate(db)
  await account('developer', 'developer')
  await account('admin', 'admin')
  await account('other', 'admin')
  // Works for the Admin, sees only alpha, and may make tokens.
  await account('scopedapi', 'subadmin', {
    adminOf: 'admin',
    permissions: ['api.manage', ...SCREENS],
    dronePermissions: { alpha: READ, bravo: READ },
  })
  // A plain Sub-admin: no API access grant.
  await account('plain', 'subadmin', { adminOf: 'admin' })
  for (const sn of ['alpha', 'bravo', 'charlie']) await device(sn)
  await registry.init()
  app = await buildServer({
    store,
    hub,
    registry,
    bridge,
    whep,
    manager,
    authorizer,
    mediaExport: exporter,
  })
  await app.ready()
  if (hasFfmpeg)
    spawnSync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x180:rate=25',
        '-t',
        '3',
      ].concat(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', video]),
      { stdio: 'ignore' },
    )
})
after(async () => {
  manager.dispose()
  await app.close()
  await db.close()
})

/* ------------------------------------------------------------- making tokens */

test('a token is a long random secret, shown once, and only its hash is stored', async () => {
  const made = newApiToken()
  assert.ok(made.token.startsWith(API_TOKEN_PREFIX))
  assert.ok(made.token.length >= 43)
  assert.equal(made.hash, hashApiToken(made.token))
  assert.notEqual(newApiToken().token, made.token)

  const created = await makeToken('admin', { name: 'AI analytics', deviceSns: ['alpha', 'bravo'] })
  assert.ok(created.token.startsWith(API_TOKEN_PREFIX))
  assert.equal(created.record.name, 'AI analytics')
  assert.equal(created.record.prefix, created.token.slice(0, 9))
  assert.equal(created.record.ownerEmail, 'admin@example.com')
  assert.deepEqual(created.record.deviceSns, ['alpha', 'bravo'])

  // Nothing stored or listed holds the secret.
  const dump = JSON.stringify(await db.query(`SELECT * FROM api_tokens`))
  assert.ok(!dump.includes(created.token))
  assert.ok(dump.includes(hashApiToken(created.token)))
  const listed = await call('admin', 'GET', '/api/api-tokens')
  assert.equal(listed.statusCode, 200)
  assert.ok(!listed.body.includes(created.token))
  assert.equal((listed.json().tokens as ApiTokenRecord[]).length, 1)
})

test('who may make tokens: an Admin and an account granted api.manage, never a Developer', async () => {
  const body = { name: 'x' }
  assert.equal((await call('plain', 'POST', '/api/api-tokens', body)).statusCode, 403)
  assert.equal((await call('plain', 'GET', '/api/api-tokens')).statusCode, 403)
  const dev = await call('developer', 'POST', '/api/api-tokens', body)
  assert.equal(dev.statusCode, 403)
  assert.equal(dev.json().error, 'developer_cannot_own_tokens')
  assert.equal((await call('admin', 'POST', '/api/api-tokens', {})).statusCode, 400)
  assert.equal((await call('admin', 'POST', '/api/api-tokens', { name: '' })).statusCode, 400)
  const unknown = await call('admin', 'POST', '/api/api-tokens', {
    name: 'x',
    deviceSns: ['alpha', 'nosuchdrone'],
  })
  assert.equal(unknown.statusCode, 400)
  assert.deepEqual(unknown.json().drones, ['nosuchdrone'])
  // A scoped account cannot hand out a drone it may not see.
  const beyond = await call('scopedapi', 'POST', '/api/api-tokens', {
    name: 'x',
    deviceSns: ['alpha', 'charlie'],
  })
  assert.equal(beyond.statusCode, 400)
})

test('other customers cannot see or revoke a token', async () => {
  const mine = await makeToken('admin', { name: 'mine' })
  const theirs = await call('other', 'GET', '/api/api-tokens')
  assert.equal((theirs.json().tokens as ApiTokenRecord[]).length, 0)
  assert.equal((await call('other', 'DELETE', `/api/api-tokens/${mine.record.id}`)).statusCode, 404)
  // Its own team can: the Sub-admin works for the same Admin.
  const team = await call('scopedapi', 'GET', '/api/api-tokens')
  assert.ok((team.json().tokens as ApiTokenRecord[]).some((t) => t.id === mine.record.id))
  assert.equal((await call('admin', 'DELETE', `/api/api-tokens/${mine.record.id}`)).statusCode, 204)
  assert.equal((await withToken(mine.token, 'GET', '/api/v1/whoami')).statusCode, 401)
  // Revoking again is fine.
  assert.equal((await call('admin', 'DELETE', `/api/api-tokens/${mine.record.id}`)).statusCode, 204)
})

/* ------------------------------------------------------------- using tokens */

test('a token reads what its owner may, limited to its drones, and says who it is', async () => {
  const { token, record } = await makeToken('admin', { name: 'AI tool', deviceSns: ['alpha'] })
  const who = await withToken(token, 'GET', '/api/v1/whoami')
  assert.equal(who.statusCode, 200)
  const body = who.json() as ApiWhoami
  assert.equal(body.kind, 'token')
  assert.equal(body.name, 'AI tool')
  assert.deepEqual(
    body.drones.map((d) => d.sn),
    ['alpha'],
  )
  assert.ok(body.permissions.includes('telemetry.view'))
  assert.ok(!body.permissions.includes('drones.delete'))
  assert.ok(!body.permissions.includes('users.manage'))

  const devices = await withToken(token, 'GET', '/api/devices')
  assert.equal(devices.statusCode, 200)
  assert.deepEqual(
    (devices.json().devices as { sn: string }[]).map((d) => d.sn),
    ['alpha'],
  )
  assert.equal((await withToken(token, 'GET', '/api/devices/alpha/telemetry')).statusCode, 200)
  assert.equal((await withToken(token, 'GET', '/api/devices/alpha/trail')).statusCode, 200)
  assert.equal((await withToken(token, 'GET', '/api/devices/bravo/telemetry')).statusCode, 403)
  assert.equal((await withToken(token, 'GET', '/api/alerts')).statusCode, 200)
  assert.equal((await withToken(token, 'GET', '/api/flights')).statusCode, 200)
  assert.equal((await withToken(token, 'GET', '/api/screenshots')).statusCode, 200)
  assert.equal((await withToken(token, 'GET', '/api/recordings')).statusCode, 200)
  assert.equal((await withToken(token, 'GET', '/api/zones')).statusCode, 200)
  assert.equal((await withToken(token, 'GET', '/api/streams')).statusCode, 200)

  // Used: remembered, with the address it came from.
  await new Promise((resolve) => setTimeout(resolve, 80))
  const listed = (await call('admin', 'GET', '/api/api-tokens')).json().tokens as ApiTokenRecord[]
  const row = listed.find((t) => t.id === record.id)!
  assert.ok(row.lastUsedAt)
  assert.ok(row.lastUsedIp)
})

test('a token never changes anything and never reaches the rest of the API', async () => {
  const { token } = await makeToken('admin', { name: 'read only' })
  const refused = async (
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    error: string,
  ) => {
    const res = await withToken(token, method, url, {})
    assert.equal(res.statusCode, 403, `${method} ${url}`)
    assert.equal(res.json().error, error, `${method} ${url}`)
  }
  await refused('POST', '/api/devices/alpha/recording', 'api_token_read_only')
  await refused('PATCH', '/api/devices/alpha', 'api_token_read_only')
  await refused('DELETE', '/api/devices/alpha', 'api_token_read_only')
  await refused(
    'POST',
    '/api/alerts/00000000-0000-4000-8000-000000000000/ack',
    'api_token_read_only',
  )
  await refused('POST', '/api/api-tokens', 'api_token_read_only')
  // Reads that are not on the list: accounts, the audit trail, the token list itself, the admin screens.
  for (const url of [
    '/api/users',
    '/api/me',
    '/api/api-tokens',
    '/api/admin/controllers',
    '/api/video-sources',
    '/api/recordings/storage',
    '/api/recordings/location',
    '/api/debug/messages',
  ]) {
    const res = await withToken(token, 'GET', url)
    assert.equal(res.statusCode, 403, url)
    assert.equal(res.json().error, 'not_available_to_api_tokens', url)
  }
  // Not a pilot's route either.
  assert.equal((await withToken(token, 'GET', '/api/pilot/user-info')).statusCode, 403)
})

test('a token stops working when it is revoked, expires, or its owner is disabled', async () => {
  const revoked = await makeToken('admin', { name: 'revoked' })
  assert.equal((await withToken(revoked.token, 'GET', '/api/v1/whoami')).statusCode, 200)
  await call('admin', 'DELETE', `/api/api-tokens/${revoked.record.id}`)
  assert.equal((await withToken(revoked.token, 'GET', '/api/v1/whoami')).statusCode, 401)

  const expiring = await makeToken('admin', { name: 'short', expiresInDays: 1 })
  assert.ok(expiring.record.expiresAt)
  assert.equal((await withToken(expiring.token, 'GET', '/api/v1/whoami')).statusCode, 200)
  await db.query(`UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
    expiring.record.id,
  ])
  assert.equal((await withToken(expiring.token, 'GET', '/api/v1/whoami')).statusCode, 401)

  const owned = await makeToken('other', { name: 'owner goes' })
  assert.equal((await withToken(owned.token, 'GET', '/api/v1/whoami')).statusCode, 200)
  await db.query(`UPDATE users SET disabled = true WHERE id = $1`, [ids.other])
  assert.equal((await withToken(owned.token, 'GET', '/api/v1/whoami')).statusCode, 401)
  await db.query(`UPDATE users SET disabled = false WHERE id = $1`, [ids.other])

  // Garbage and look-alikes.
  assert.equal((await withToken('ne_notatoken', 'GET', '/api/v1/whoami')).statusCode, 401)
  assert.equal((await withToken('not-even-close', 'GET', '/api/v1/whoami')).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/whoami' })).statusCode, 401)
})

test('a token follows its owner: never wider, and narrower the moment the owner loses a drone', async () => {
  // The owner may read alpha and bravo; a token without a list gets exactly that.
  const { token } = await makeToken('scopedapi', { name: 'scoped owner' })
  const sns = async () =>
    ((await withToken(token, 'GET', '/api/devices')).json().devices as { sn: string }[]).map(
      (d) => d.sn,
    )
  assert.deepEqual((await sns()).sort(), ['alpha', 'bravo'])
  await db.query(`UPDATE users SET drone_permissions = $2::jsonb WHERE id = $1`, [
    ids.scopedapi,
    JSON.stringify({ alpha: READ }),
  ])
  assert.deepEqual(await sns(), ['alpha'])
  assert.equal((await withToken(token, 'GET', '/api/devices/bravo/telemetry')).statusCode, 403)

  // The pure rule: looking rights only, whatever the owner holds.
  const owner = {
    permissions: [...defaultPermissions('admin')],
    allDrones: true,
    dronePermissions: {},
  }
  const all = narrowAccess(owner, null)
  assert.equal(all.allDrones, true)
  for (const p of [
    'drones.delete',
    'recordings.record',
    'users.manage',
    'audit.view',
    'zones.manage',
  ])
    assert.ok(!all.permissions.includes(p as Permission), p)
  for (const p of READ) assert.ok(all.permissions.includes(p), p)
  const some = narrowAccess(owner, ['alpha'])
  assert.equal(some.allDrones, false)
  assert.deepEqual(Object.keys(some.dronePermissions), ['alpha'])
  assert.deepEqual([...some.dronePermissions.alpha!].sort(), [...READ].sort())
})

test('a Developer-owned token does not work, even if one is put in the database', async () => {
  const made = newApiToken()
  await store.tokens.create({
    id: randomUUID(),
    userId: ids.developer!,
    name: 'dev',
    tokenHash: made.hash,
    prefix: made.prefix,
    deviceSns: null,
    expiresAt: null,
  })
  assert.equal((await withToken(made.token, 'GET', '/api/v1/whoami')).statusCode, 401)
})

test('the API describes itself', async () => {
  const { token } = await makeToken('admin', { name: 'docs' })
  const res = await withToken(token, 'GET', '/api/v1/openapi.json')
  assert.equal(res.statusCode, 200)
  const doc = res.json()
  assert.equal(doc.openapi, '3.0.3')
  const paths = Object.keys(doc.paths)
  for (const p of [
    '/api/devices',
    '/api/devices/{sn}/frame',
    '/api/devices/{sn}/live',
    '/api/alerts',
    '/api/recordings/{id}/video',
  ])
    assert.ok(paths.includes(p), p)
  // Everything it lists is read-only.
  for (const item of Object.values(doc.paths) as Record<string, unknown>[])
    assert.deepEqual(Object.keys(item), ['get'])
})

/* ---------------------------------------------------------------- websocket */

test('a token can follow telemetry over the websocket, only for its drones, and is cut off when revoked', async () => {
  const { token, record } = await makeToken('admin', { name: 'socket', deviceSns: ['alpha'] })
  const ws = await app.injectWS('/ws', { headers: { authorization: `Bearer ${token}` } })
  const seen: { type: string; data?: { sn?: string } | unknown[] }[] = []
  ws.on('message', (data) => seen.push(JSON.parse(data.toString())))
  const first = once(ws, 'message')
  ws.send(JSON.stringify({ type: 'subscribe', channels: ['devices'] }))
  await first
  hub.publish(['devices'], { type: 'device.cameras', data: { sn: 'bravo', cameras: [] } })
  hub.publish(['devices'], { type: 'device.cameras', data: { sn: 'alpha', cameras: [] } })
  await once(ws, 'message')
  const cameras = seen.filter((m) => m.type === 'device.cameras' && !Array.isArray(m.data))
  assert.deepEqual(
    cameras.map((m) => (m.data as { sn: string }).sn),
    ['alpha'],
  )
  const closed = once(ws, 'close')
  await call('admin', 'DELETE', `/api/api-tokens/${record.id}`)
  await closed
})

/* -------------------------------------------------------------------- video */

test(
  'a picture from the live video, limited to the token’s drones',
  { skip: !hasFfmpeg, timeout: 30_000 },
  async () => {
    await liveStream('alpha')
    const { token } = await makeToken('admin', { name: 'frames', deviceSns: ['alpha'] })

    const first = await withToken(token, 'GET', '/api/devices/alpha/frame')
    assert.equal(first.statusCode, 200, first.body)
    assert.equal(first.headers['content-type'], 'image/jpeg')
    assert.equal(first.headers['cache-control'], 'no-store')
    const bytes = first.rawPayload
    assert.equal(bytes[0], 0xff)
    assert.equal(bytes[1], 0xd8, 'a JPEG starts with FF D8')
    assert.ok(bytes.length > 1000)
    assert.ok(first.headers['x-frame-time'])

    // Asked again at once, it is the same picture (no second ffmpeg).
    const again = await withToken(token, 'GET', '/api/devices/alpha/frame')
    assert.equal(again.headers['x-frame-time'], first.headers['x-frame-time'])

    // Not its drone, not a drone, not allowed to write.
    assert.equal((await withToken(token, 'GET', '/api/devices/bravo/frame')).statusCode, 403)
    assert.equal((await withToken(token, 'GET', '/api/devices/nosuch/frame')).statusCode, 403)
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/devices/alpha/frame' })).statusCode,
      401,
    )
    // A person signed in may take one too.
    assert.equal((await call('admin', 'GET', '/api/devices/alpha/frame')).statusCode, 200)
  },
)

test(
  'a drone that is not streaming is told to be asked again, not failed',
  { skip: !hasFfmpeg, timeout: 30_000 },
  async () => {
    const { token } = await makeToken('admin', { name: 'waiting' })
    const res = await withToken(token, 'GET', '/api/devices/charlie/frame')
    assert.equal(res.statusCode, 503)
    assert.equal(res.json().error, 'drone_not_streaming')
    assert.equal(res.headers['retry-after'], '5')
    const live = await withToken(token, 'GET', '/api/devices/charlie/live')
    assert.equal(live.statusCode, 503)
    assert.equal(exporter.liveCount, 0, 'a refused request holds nothing')
  },
)

test(
  'the live video is passed on as MPEG-TS, within the limit, and let go of when it ends',
  { skip: !hasFfmpeg, timeout: 40_000 },
  async () => {
    await liveStream('bravo')
    const { token } = await makeToken('admin', { name: 'live' })
    // The limit is one: while the first is open a second is turned away.
    const firstP = withToken(token, 'GET', '/api/devices/bravo/live')
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(exporter.liveCount, 1)
    const second = await withToken(token, 'GET', '/api/devices/alpha/live')
    assert.equal(second.statusCode, 429)
    assert.equal(second.json().error, 'too_many_live_feeds')

    const first = await firstP
    assert.equal(first.statusCode, 200)
    assert.equal(first.headers['content-type'], 'video/mp2t')
    assert.equal(first.headers['x-accel-buffering'], 'no')
    const ts = first.rawPayload
    assert.ok(ts.length > 10_000, 'several seconds of video')
    assert.equal(ts[0], 0x47, 'MPEG-TS packets start with 0x47')
    assert.equal(ts[188], 0x47)
    assert.equal(exporter.liveCount, 0, 'finished: the drone and the media server are let go')
  },
)

test(
  'a real client reads the live video with the token header, and hanging up lets go of the drone',
  { skip: !hasFfmpeg, timeout: 40_000 },
  async () => {
    const { token } = await makeToken('admin', { name: 'ffmpeg' })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    // The command an AI tool's developer would use (docs/api.md): ffmpeg decodes ten frames, then hangs up.
    const run = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-headers', `Authorization: Bearer ${token}\r\n`]
        .concat(['-i', `http://127.0.0.1:${port}/api/devices/bravo/live`, '-frames:v', '10'])
        .concat(['-f', 'null', '-']),
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let errors = ''
    run.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()))
    const [code] = (await once(run, 'close')) as [number]
    assert.equal(code, 0, `ffmpeg failed: ${errors}`)
    // Gone: the server noticed and released the drone and ffmpeg.
    for (let i = 0; i < 20 && exporter.liveCount > 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(exporter.liveCount, 0)

    // Without the header the same address is refused.
    const refused = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        `http://127.0.0.1:${port}/api/devices/bravo/live`,
      ].concat(['-frames:v', '1', '-f', 'null', '-']),
      { stdio: ['ignore', 'ignore', 'ignore'] },
    )
    const [refusedCode] = (await once(refused, 'close')) as [number]
    assert.notEqual(refusedCode, 0)
  },
)
