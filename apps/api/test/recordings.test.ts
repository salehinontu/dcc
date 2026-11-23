import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import {
  defaultPermissions,
  type Permission,
  type RecordingAutoDrone,
  type RecordingRecord,
  type RecordingStorage,
} from '@dji/protocol'
import { AuditLog } from '../src/audit'
import { hashPassword, issueSession, publicUser } from '../src/auth'
import { migrate, type Db } from '../src/db'
import { Hub } from '../src/hub'
import { MqttAuthorizer } from '../src/mqtt-auth'
import { cleanName, diskName, VideoLibrary } from '../src/recordings/library'
import { parseStorageRoots, PlaceError, RecordingPlace } from '../src/recordings/place'
import { clipStart, RecordingManager, type RecorderOptions } from '../src/recordings/recorder'
import { Janitor, type JanitorOptions } from '../src/janitor'
import { Registry } from '../src/registry'
import { parseRange } from '../src/routes/recordings'
import { buildServer } from '../src/server'
import { Store } from '../src/store'
import { StreamManager } from '../src/streams/manager'
import { WhepSessions } from '../src/streams/whep'
import type { MqttBridge } from '../src/mqtt'

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0

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

let folder: string
let source: string
let app: Awaited<ReturnType<typeof buildServer>>
let recorder: RecordingManager
let library: VideoLibrary
let janitor: Janitor
let place: RecordingPlace
const ids: Record<string, string> = {}

async function call(
  name: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
) {
  const token = await issueSession(publicUser((await store.findUserById(ids[name]!))!), store)
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload: payload as Record<string, unknown> | undefined,
  })
}

async function account(
  name: string,
  role: string,
  access?: { dronePermissions: Record<string, Permission[]> },
) {
  const id = randomUUID()
  ids[name] = id
  await store.createUser(
    id,
    `${name}@example.com`,
    await hashPassword('initial-password-123'),
    role,
    {
      permissions: access ? ['map.view', 'recs.view'] : defaultPermissions(role),
      allDrones: !access,
      dronePermissions: access?.dronePermissions ?? {},
      mustChangePassword: false,
      adminId: null,
    },
  )
}

async function device(sn: string, online = true) {
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
  // Claiming a drone does not say whether it is online; the test says so either way.
  await db.query(`UPDATE devices SET online = $2 WHERE sn = $1`, [sn, online])
}

/** A clip as the recorder leaves it: a row, and the bytes it points to. */
async function clip(
  sn: string,
  startedAt: string,
  seconds: number,
  bytes: Buffer = Buffer.from('0123456789'.repeat(100)),
  file?: string,
) {
  const name =
    file ??
    `${sn}/${sn}_${startedAt.replace(/[-:T]/g, '').slice(0, 8)}_${startedAt.slice(11, 19).replace(/:/g, '')}.mp4`
  const abs = path.join(folder, name)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, bytes)
  const id = randomUUID()
  await store.recordings.insert({
    id,
    sessionId: `session-${sn}`,
    deviceSn: sn,
    mode: 'manual',
    file: name,
    startedAt: new Date(startedAt),
    endedAt: new Date(new Date(startedAt).getTime() + seconds * 1000),
    durationS: seconds,
    sizeBytes: bytes.length,
    operatorEmail: 'admin@example.com',
  })
  return { id, abs, name }
}

before(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'drone-rec-'))
  await migrate(db)
  await account('admin', 'admin')
  await account('viewer', 'subadmin')
  await account('scoped', 'subadmin', {
    dronePermissions: { alpha: ['drones.view', 'recordings.view'] },
  })
  await account('pilot', 'pilot')
  await account('admin2', 'admin')
  // May record auto5 (and so set it to record automatically) but not auto6, and may not delete.
  await account('recorder', 'subadmin', {
    dronePermissions: { auto5: ['drones.view', 'recordings.view', 'recordings.record'] },
  })
  await account('developer', 'developer')
  // May delete clips of alpha only.
  await account('alphaDeleter', 'subadmin', {
    dronePermissions: { alpha: ['drones.view', 'recordings.view', 'recordings.delete'] },
  })
  // Works for the first Admin: sees what its team uploads, and may not upload or delete itself.
  const team: [string, { dronePermissions: Record<string, Permission[]>; allDrones: boolean }][] = [
    ['teammate', { dronePermissions: {}, allDrones: true }],
    [
      'scoped2',
      { dronePermissions: { alpha: ['drones.view', 'recordings.view'] }, allDrones: false },
    ],
  ]
  for (const [name, access] of team) {
    const id = randomUUID()
    ids[name] = id
    await store.createUser(
      id,
      `${name}@example.com`,
      await hashPassword('initial-password-123'),
      'subadmin',
      {
        permissions: access.allDrones ? defaultPermissions('subadmin') : ['map.view', 'recs.view'],
        allDrones: access.allDrones,
        dronePermissions: access.dronePermissions,
        mustChangePassword: false,
        adminId: ids.admin!,
      },
    )
  }
  await device('alpha')
  await device('bravo')
  await device('offline', false)
  await device('auto5')
  await device('auto6')

  place = new RecordingPlace(folder, false, store)
  recorder = new RecordingManager(
    { store, manager },
    {
      get dir() {
        return place.dir
      },
      olderDirs: () => place.olderDirs,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      segmentSeconds: 3,
      gapSeconds: 30,
      maxActive: 2,
      // A test reads a file in place of the media server, at playing speed like a live feed.
      inputUrl: () => source,
      pollMs: 100,
      realtimeInput: true,
    },
  )
  library = new VideoLibrary(store, {
    get dir() {
      return place.dir
    },
    olderDirs: () => place.olderDirs,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    // Small on purpose: the tests send small videos, and one that is over this to prove the limit.
    maxBytes: 2 * 1024 * 1024,
  })
  janitor = new Janitor(
    { store, recorder, library },
    {
      dir: folder,
      retentionDays: 30,
      maxBytes: 0,
      minFreeBytes: 10 * 1024 ** 3,
      intervalSeconds: 60,
      autoDefault: false,
      telemetryRetentionDays: 0,
      mqttLogRetentionDays: 0,
      freeSpace: async () => ({ free: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 }),
    },
  )
  app = await buildServer({
    store,
    hub,
    registry,
    bridge,
    whep,
    manager,
    authorizer,
    recorder,
    library,
    janitor,
    place,
    audit,
  })
  await app.ready()

  if (hasFfmpeg) {
    source = path.join(folder, 'source.flv')
    // 9 s of H.264 with a keyframe every second and AAC audio, as a drone pushes.
    const made = spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=25',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '9',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '25',
      '-keyint_min',
      '25',
      '-sc_threshold',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-f',
      'flv',
      source,
    ])
    assert.equal(made.status, 0, 'the test source must be made')
  }
})
after(async () => {
  await recorder.dispose()
  manager.dispose()
  await app.close()
  await db.close()
  await rm(folder, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ pure parts */

test('a clip name carries its opening time in UTC, and a range header is read like a browser sends it', () => {
  assert.equal(clipStart('1ZSIM_20261118_044438.mp4')?.toISOString(), '2026-11-18T04:44:38.000Z')
  assert.equal(clipStart('1ZSIM_notatime.mp4'), null)

  assert.deepEqual(parseRange(undefined, 100), null)
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(
    parseRange('bytes=50-5000', 100),
    { start: 50, end: 99 },
    'an end past the file is clamped',
  )
  for (const bad of [
    'bytes=100-',
    'bytes=5-2',
    'bytes=-0',
    'bytes=-',
    'items=0-1',
    'bytes=0-1,5-6',
  ])
    assert.equal(parseRange(bad, 100), 'invalid', bad)
})

/* --------------------------------------------------------------------- archive */

test('the archive lists clips that overlap a date-time range, newest first, for one drone or all', async () => {
  const a1 = await clip('alpha', '2026-11-10T10:00:00Z', 600)
  const a2 = await clip('alpha', '2026-11-10T10:10:00Z', 600)
  const b1 = await clip('bravo', '2026-11-10T10:05:00Z', 300)

  const all = (await call('admin', 'GET', '/api/recordings')).json()
  assert.equal(all.total, 3)
  assert.deepEqual(
    all.recordings.map((r: RecordingRecord) => r.id),
    [a2.id, b1.id, a1.id],
    'newest first',
  )
  const first = all.recordings[2] as RecordingRecord
  assert.equal(first.deviceSn, 'alpha')
  assert.equal(first.durationS, 600)
  assert.equal(first.startedBy, 'admin@example.com')
  assert.match(first.filename, /^DRONE-FLEET_alpha_2026-11-10_\d\d-00-00\.mp4$/)

  const only = (await call('admin', 'GET', '/api/recordings?deviceSn=bravo')).json()
  assert.deepEqual(
    only.recordings.map((r: RecordingRecord) => r.id),
    [b1.id],
  )

  // 10:08 to 10:12 touches the end of a1 (until 10:10), a2 and b1 (10:05 to 10:10) is over by then.
  const range = (
    await call('admin', 'GET', '/api/recordings?from=2026-11-10T10:08:00Z&to=2026-11-10T10:12:00Z')
  ).json()
  assert.deepEqual(
    new Set(range.recordings.map((r: RecordingRecord) => r.id)),
    new Set([a1.id, a2.id, b1.id]),
  )
  const later = (await call('admin', 'GET', '/api/recordings?from=2026-11-10T10:11:00Z')).json()
  assert.deepEqual(
    later.recordings.map((r: RecordingRecord) => r.id),
    [a2.id],
  )
  const before = (await call('admin', 'GET', '/api/recordings?to=2026-11-10T10:02:00Z')).json()
  assert.deepEqual(
    before.recordings.map((r: RecordingRecord) => r.id),
    [a1.id],
  )

  const page = (await call('admin', 'GET', '/api/recordings?limit=1&offset=1')).json()
  assert.equal(page.total, 3)
  assert.deepEqual(
    page.recordings.map((r: RecordingRecord) => r.id),
    [b1.id],
  )
  assert.equal((await call('admin', 'GET', '/api/recordings?from=yesterday')).statusCode, 400)
})

test('who may watch, record and delete is decided per grant and per drone', async () => {
  const alpha = (await call('admin', 'GET', '/api/recordings?deviceSn=alpha')).json().recordings[0]
  const bravo = (await call('admin', 'GET', '/api/recordings?deviceSn=bravo')).json().recordings[0]

  // A Sub-admin may watch, not record or delete.
  assert.equal((await call('viewer', 'GET', '/api/recordings')).statusCode, 200)
  assert.equal((await call('viewer', 'POST', '/api/devices/alpha/recording')).statusCode, 403)
  assert.equal((await call('viewer', 'DELETE', `/api/recordings/${alpha.id}`)).statusCode, 403)

  // An account limited to alpha sees alpha's clips only, and bravo's do not exist for it.
  const scoped = (await call('scoped', 'GET', '/api/recordings')).json()
  assert.ok(scoped.recordings.length > 0)
  assert.ok(scoped.recordings.every((r: RecordingRecord) => r.deviceSn === 'alpha'))
  assert.equal(
    scoped.total,
    scoped.recordings.length,
    'the count is of what it may see, not of everything',
  )
  assert.equal((await call('scoped', 'GET', `/api/recordings/${alpha.id}`)).statusCode, 200)
  assert.equal((await call('scoped', 'GET', `/api/recordings/${bravo.id}`)).statusCode, 403)
  assert.equal((await call('scoped', 'GET', `/api/recordings/${bravo.id}/video`)).statusCode, 403)
  assert.equal((await call('scoped', 'GET', '/api/recordings/active')).statusCode, 200)

  // A Pilot signs a controller in and has no dashboard.
  assert.equal((await call('pilot', 'GET', '/api/recordings')).statusCode, 403)

  // Nobody is signed in: no route is open.
  assert.equal((await app.inject({ method: 'GET', url: '/api/recordings' })).statusCode, 401)
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/recordings/${alpha.id}/video` })).statusCode,
    401,
  )
})

test('a clip plays from the middle (Range), downloads, and a path can never leave the folder', async () => {
  const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))
  const { id } = await clip('alpha', '2026-11-11T09:00:00Z', 60, body)

  const whole = await call('admin', 'GET', `/api/recordings/${id}/video`)
  assert.equal(whole.statusCode, 200)
  assert.equal(whole.headers['content-type'], 'video/mp4')
  assert.equal(whole.headers['accept-ranges'], 'bytes')
  assert.equal(whole.headers['content-length'], '1000')
  assert.deepEqual(whole.rawPayload, body)

  const middle = await call('admin', 'GET', `/api/recordings/${id}/video`, {
    range: 'bytes=100-199',
  })
  assert.equal(middle.statusCode, 206)
  assert.equal(middle.headers['content-range'], 'bytes 100-199/1000')
  assert.equal(middle.headers['content-length'], '100')
  assert.deepEqual(middle.rawPayload, body.subarray(100, 200))

  const tail = await call('admin', 'GET', `/api/recordings/${id}/video`, { range: 'bytes=-50' })
  assert.equal(tail.statusCode, 206)
  assert.deepEqual(tail.rawPayload, body.subarray(950))

  const beyond = await call('admin', 'GET', `/api/recordings/${id}/video`, { range: 'bytes=5000-' })
  assert.equal(beyond.statusCode, 416)
  assert.equal(beyond.headers['content-range'], 'bytes */1000')

  const download = await call('admin', 'GET', `/api/recordings/${id}/video?download=1`)
  assert.match(
    String(download.headers['content-disposition']),
    /^attachment; filename="DRONE-FLEET_alpha_2026-11-11_\d\d-00-00\.mp4"; filename\*=UTF-8''DRONE-FLEET_alpha_2026-11-11_\d\d-00-00\.mp4$/,
  )

  // A row that points outside the folder (a corrupted or planted one) serves nothing.
  const outside = path.join(path.dirname(folder), 'drone-rec-outside.txt')
  await writeFile(outside, 'secret')
  const planted = randomUUID()
  await store.recordings.insert({
    id: planted,
    sessionId: 's',
    deviceSn: 'alpha',
    mode: 'manual',
    file: `../${path.basename(outside)}`,
    startedAt: new Date('2026-11-12T00:00:00Z'),
    endedAt: new Date('2026-11-12T00:01:00Z'),
    durationS: 60,
    sizeBytes: 6,
    operatorEmail: null,
  })
  assert.equal((await call('admin', 'GET', `/api/recordings/${planted}/video`)).statusCode, 404)
  await rm(outside, { force: true })
})

test('deleting a clip removes the file and the row, and leaves a trace', async () => {
  const { id, abs } = await clip('bravo', '2026-11-13T08:00:00Z', 30)
  assert.equal((await call('admin', 'DELETE', `/api/recordings/${id}`)).statusCode, 204)
  await assert.rejects(stat(abs), 'the file is gone')
  assert.equal((await call('admin', 'GET', `/api/recordings/${id}`)).statusCode, 404)
  const events = await db.query<{ kind: string }>(
    `SELECT kind FROM device_events WHERE device_sn = 'bravo' AND kind = 'recording.deleted'`,
  )
  assert.equal(events.length, 1)
})

test('several videos are deleted together; what an account may not delete is skipped and counted, not named', async () => {
  const a1 = await clip('alpha', '2026-11-14T08:00:00Z', 30)
  const a2 = await clip('alpha', '2026-11-14T09:00:00Z', 30)
  const b1 = await clip('bravo', '2026-11-14T10:00:00Z', 30)
  const b2 = await clip('bravo', '2026-11-14T11:00:00Z', 30)
  // An upload of the first Admin's customer, tied to no drone.
  const up = randomUUID()
  const upFile = 'library/Bulk/bulk-upload.mp4'
  await mkdir(path.join(folder, 'library', 'Bulk'), { recursive: true })
  await writeFile(path.join(folder, upFile), 'an uploaded video')
  await writeFile(path.join(folder, `${upFile}.jpg`), 'its thumbnail')
  await store.recordings.insert({
    id: up,
    sessionId: up,
    deviceSn: null,
    mode: 'upload',
    source: 'upload',
    title: 'Bulk upload',
    folder: 'Bulk',
    state: 'ready',
    tenantId: ids.admin!,
    file: upFile,
    startedAt: new Date('2026-11-14T12:00:00Z'),
    endedAt: new Date('2026-11-14T12:00:30Z'),
    durationS: 30,
    sizeBytes: 17,
    operatorEmail: 'admin@example.com',
  })
  const post = (name: string, list: string[]) =>
    call(name, 'POST', '/api/recordings/delete', {}, { ids: list })
  const here = async (file: string) =>
    stat(path.join(folder, file)).then(
      () => true,
      () => false,
    )

  // Nobody without the grant, and nothing that is not a list of ids.
  assert.equal((await post('viewer', [a1.id])).statusCode, 403)
  assert.equal((await post('teammate', [a1.id])).statusCode, 403)
  assert.equal((await post('pilot', [a1.id])).statusCode, 403)
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/recordings/delete' })).statusCode,
    401,
  )
  assert.equal((await post('admin', [])).statusCode, 400)
  assert.equal((await post('admin', ['not-an-id'])).statusCode, 400)
  assert.ok(await here(a1.name))

  // An account that may delete alpha's clips only: bravo's, and another customer's upload, are skipped.
  const some = await post('alphaDeleter', [a1.id, b1.id, up, a1.id])
  assert.equal(some.statusCode, 200)
  assert.deepEqual(some.json(), { deleted: 1, skipped: 2 })
  assert.equal(await here(a1.name), false, 'the clip it may delete is gone, file and all')
  assert.ok(await here(b1.name), "bravo's clip is still there")
  assert.ok(await here(upFile), 'an upload of another customer is untouched')
  assert.equal((await call('admin', 'GET', `/api/recordings/${a1.id}`)).statusCode, 404)

  // Another customer's Admin cannot take the upload either, and is not told whether it exists.
  assert.deepEqual((await post('admin2', [up])).json(), { deleted: 0, skipped: 1 })
  assert.ok(await here(upFile))

  // The customer's own Admin deletes the rest in one call; an id that is not there is skipped.
  const rest = await post('admin', [a2.id, b1.id, b2.id, up, randomUUID()])
  assert.deepEqual(rest.json(), { deleted: 4, skipped: 1 })
  for (const file of [a2.name, b1.name, b2.name, upFile, `${upFile}.jpg`])
    assert.equal(await here(file), false, `${file} is gone`)
  assert.equal((await call('admin', 'GET', `/api/recordings/${up}`)).statusCode, 404)

  // The trail names what went, because a list of ids would say nothing later.
  await audit.flush()
  const lines = await db.query<{
    target_label: string
    status: number
    details: { count: number; skipped: number; deleted: { name: string; file: string }[] }
  }>(
    `SELECT target_label, status, details FROM audit_log
     WHERE action = 'recording.deleted' AND target_type = 'recording' AND target_label LIKE '% video%'
     ORDER BY seq`,
  )
  assert.deepEqual(
    lines.map((line) => [line.target_label, line.status]),
    [
      ['1 video', 200],
      ['0 videos', 200],
      ['4 videos', 200],
    ],
  )
  const last = lines[2]!.details
  assert.equal(last.count, 4)
  assert.equal(last.skipped, 1)
  assert.ok(last.deleted.some((item) => item.name === 'Bulk upload' && item.file === upFile))
})

test('the Recordings screen is a grant of its own: without it the data is closed, and the Live wall still knows what is recording', async () => {
  const clip1 = await clip('alpha', '2026-11-15T08:00:00Z', 30)
  const make = async (name: string, permissions: Permission[], drone: Permission[]) => {
    await account(name, 'subadmin', { dronePermissions: { alpha: drone } })
    await db.query(`UPDATE users SET permissions = $2::jsonb WHERE id = $1`, [
      ids[name],
      JSON.stringify(permissions),
    ])
  }
  const rights: Permission[] = [
    'drones.view',
    'recordings.view',
    'recordings.delete',
    'recordings.record',
  ]
  // The data right alone: no screen, no recordings, though the rights say it may.
  await make('no-screen', ['map.view'], rights)
  for (const [method, url] of [
    ['GET', '/api/recordings'],
    ['GET', '/api/recordings/folders'],
    ['GET', `/api/recordings/${clip1.id}`],
    ['GET', `/api/recordings/${clip1.id}/video`],
    ['GET', `/api/recordings/${clip1.id}/thumbnail`],
    ['GET', '/api/recordings/auto'],
    ['GET', '/api/recordings/storage'],
  ] as const)
    assert.equal((await call('no-screen', method, url)).statusCode, 403, url)
  assert.equal((await call('no-screen', 'DELETE', `/api/recordings/${clip1.id}`)).statusCode, 403)
  assert.equal(
    (await call('no-screen', 'POST', '/api/recordings/delete', {}, { ids: [clip1.id] })).statusCode,
    403,
  )
  assert.equal((await call('no-screen', 'PUT', '/api/recordings/upload')).statusCode, 403)
  // What the Live wall's REC buttons read stays open to whoever may watch.
  assert.equal((await call('no-screen', 'GET', '/api/recordings/active')).statusCode, 200)

  // The screen and the data right together open it.
  await make('with-screen', ['map.view', 'recs.view'], rights)
  assert.equal((await call('with-screen', 'GET', '/api/recordings?deviceSn=alpha')).statusCode, 200)
  assert.equal((await call('with-screen', 'GET', `/api/recordings/${clip1.id}`)).statusCode, 200)
  // The screen alone opens nothing: the data is still the drone right.
  await make('screen-only', ['map.view', 'recs.view'], ['drones.view'])
  assert.equal((await call('screen-only', 'GET', '/api/recordings')).statusCode, 403)
  // Everyone the defaults make has the screen, so a new Sub-admin opens Recordings as before.
  assert.ok(defaultPermissions('subadmin').includes('recs.view'))
  assert.ok(defaultPermissions('admin').includes('recs.view'))
})

test('an account that could already watch or upload recordings gets the Recordings screen once; one switched off later stays off', async () => {
  const make = async (
    name: string,
    permissions: string[],
    drones: Record<string, string[]> = {},
  ) => {
    const id = randomUUID()
    ids[name] = id
    await store.createUser(
      id,
      `${name}@example.com`,
      await hashPassword('initial-password-123'),
      'subadmin',
      {
        permissions: [],
        allDrones: Object.keys(drones).length === 0,
        dronePermissions: {},
        mustChangePassword: false,
        adminId: null,
      },
    )
    await db.query(
      `UPDATE users SET permissions = $2::jsonb, drone_permissions = $3::jsonb WHERE id = $1`,
      [id, JSON.stringify(permissions), JSON.stringify(drones)],
    )
  }
  await make('old-watcher', ['drones.view', 'recordings.view'])
  await make('old-scoped', ['map.view'], { alpha: ['drones.view', 'recordings.view'] })
  await make('old-uploader', ['recordings.upload'])
  await make('old-unrelated', ['drones.view', 'streams.view'])
  await db.query(`DELETE FROM schema_marks WHERE name = 'recs_permission'`)
  await migrate(db)
  const grants = async (name: string) => (await store.findUserById(ids[name]!))!.permissions
  assert.ok((await grants('old-watcher')).includes('recs.view'), 'watching on every drone')
  assert.ok((await grants('old-scoped')).includes('recs.view'), 'watching on one drone')
  assert.ok((await grants('old-uploader')).includes('recs.view'), 'uploading needs the screen')
  assert.ok(!(await grants('old-unrelated')).includes('recs.view'), 'nothing to do with recordings')
  // Taken away later, it is not given back by the next start.
  await db.query(`UPDATE users SET permissions = permissions - 'recs.view' WHERE id = $1`, [
    ids['old-watcher'],
  ])
  await migrate(db)
  assert.ok(!(await grants('old-watcher')).includes('recs.view'))
})

test('starting needs an online drone, stopping with nothing running is harmless, and the first grants reach an Admin once', async () => {
  assert.equal((await call('admin', 'POST', '/api/devices/offline/recording')).statusCode, 409)
  assert.equal((await call('admin', 'POST', '/api/devices/nosuch/recording')).statusCode, 404)
  assert.equal((await call('admin', 'DELETE', '/api/devices/alpha/recording')).statusCode, 204)

  // The Admin created above has all three grants. An Admin that predates them gets them once, a
  // Sub-admin and a later change do not.
  const old = randomUUID()
  await store.createUser(
    old,
    'old-admin@example.com',
    await hashPassword('initial-password-123'),
    'admin',
    {
      permissions: ['users.manage', 'drones.view'],
      allDrones: true,
      dronePermissions: {},
      mustChangePassword: false,
      adminId: null,
    },
  )
  const sub = randomUUID()
  await store.createUser(
    sub,
    'old-sub@example.com',
    await hashPassword('initial-password-123'),
    'subadmin',
    {
      permissions: ['drones.view'],
      allDrones: true,
      dronePermissions: {},
      mustChangePassword: false,
      adminId: null,
    },
  )
  await db.query(`DELETE FROM schema_marks WHERE name = 'recordings_permissions'`)
  await migrate(db)
  const grants = async (id: string) => (await store.findUserById(id))!.permissions
  assert.deepEqual((await grants(old)).filter((p) => p.startsWith('recordings.')).sort(), [
    'recordings.delete',
    'recordings.record',
    'recordings.view',
  ])
  assert.deepEqual(
    (await grants(sub)).filter((p) => p.startsWith('recordings.')),
    [],
  )
  await db.query(`UPDATE users SET permissions = '["drones.view"]'::jsonb WHERE id = $1`, [old])
  await migrate(db)
  assert.deepEqual(
    (await grants(old)).filter((p) => p.startsWith('recordings.')),
    [],
    'once only: a recordings grant switched off stays off',
  )
})

/* ----------------------------------------------------------------- the recorder */

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

async function until<T>(read: () => Promise<T | false>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

test(
  'recording a live feed makes playable, seekable clips that the archive can find',
  { skip: !hasFfmpeg, timeout: 60_000 },
  async () => {
    await liveStream('alpha')
    const started = Date.now()

    const res = await call('admin', 'POST', '/api/devices/alpha/recording')
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().recording.deviceSn, 'alpha')
    assert.equal(res.json().recording.startedBy, 'admin@example.com')
    assert.equal(recorder.isRecording('alpha'), true)
    // Starting twice is the same recording, not a second one.
    const again = await call('admin', 'POST', '/api/devices/alpha/recording')
    assert.equal(again.json().recording.sessionId, res.json().recording.sessionId)
    assert.equal((await call('admin', 'GET', '/api/recordings/active')).json().recordings.length, 1)

    // One more drone fills the limit of two, a third is turned away.
    await liveStream('bravo')
    assert.equal((await call('admin', 'POST', '/api/devices/bravo/recording')).statusCode, 200)
    await device('charlie')
    assert.equal((await call('admin', 'POST', '/api/devices/charlie/recording')).statusCode, 429)
    await call('admin', 'DELETE', '/api/devices/bravo/recording')

    // A 9 s feed cut at 3 s: at least three finished clips.
    const clips = await until(
      async () => {
        const rows = (
          await call(
            'admin',
            'GET',
            `/api/recordings?deviceSn=alpha&from=${new Date(started - 1000).toISOString()}`,
          )
        ).json().recordings as RecordingRecord[]
        return rows.length >= 3 && rows
      },
      40_000,
      'three clips',
    )
    assert.equal((await call('admin', 'DELETE', '/api/devices/alpha/recording')).statusCode, 204)
    assert.equal(recorder.isRecording('alpha'), false)

    const rows = (
      await call(
        'admin',
        'GET',
        `/api/recordings?deviceSn=alpha&from=${new Date(started - 1000).toISOString()}`,
      )
    ).json().recordings as RecordingRecord[]
    assert.ok(rows.length >= clips.length)
    assert.equal(new Set(rows.map((r) => r.sessionId)).size >= 1, true)
    for (const row of rows) {
      assert.equal(row.mode, 'manual')
      assert.equal(row.startedBy, 'admin@example.com')
      assert.ok(
        row.durationS >= 1 && row.durationS <= 5,
        `a clip of about 3 s, got ${row.durationS}`,
      )
      assert.ok(
        Math.abs(new Date(row.startedAt).getTime() - started) < 120_000,
        'the clip is dated when it was recorded',
      )
      assert.ok(row.sizeBytes > 2048)

      // It is a real file a browser can seek in: the index (moov) comes before the video data.
      const stored = await store.recordings.get(row.id)
      const abs = path.join(folder, stored!.file)
      const head = (await readFile(abs)).subarray(0, 64).toString('latin1')
      assert.ok(head.includes('ftyp') && head.includes('moov'), 'moov up front')
      const probe = spawnSync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name',
        '-of',
        'csv=p=0',
        abs,
      ])
      assert.match(probe.stdout.toString(), /h264/)
      const played = await call('admin', 'GET', `/api/recordings/${row.id}/video`, {
        range: 'bytes=0-1023',
      })
      assert.equal(played.statusCode, 206)
    }
    const kinds = (
      await db.query<{ kind: string }>(
        `SELECT kind FROM device_events WHERE device_sn = 'alpha' AND kind IN ('recording.started', 'recording.stopped') ORDER BY id`,
      )
    ).map((r) => r.kind)
    assert.deepEqual([kinds[0], kinds.at(-1)], ['recording.started', 'recording.stopped'])
  },
)

test(
  'a recording ends by itself when the feed is gone for good',
  { skip: !hasFfmpeg, timeout: 30_000 },
  async () => {
    const quick = new RecordingManager(
      { store, manager },
      {
        dir: folder,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        segmentSeconds: 3,
        gapSeconds: 1,
        maxActive: 2,
        inputUrl: () => source,
        pollMs: 100,
      },
    )
    await device('delta') // online, but no stream is ever live for it
    await quick.start('delta', { email: 'admin@example.com' })
    assert.equal(quick.isRecording('delta'), true)
    await until(async () => !quick.isRecording('delta'), 10_000, 'the recording to give up')
    const stopped = await db.query<{ payload: { reason: string } }>(
      `SELECT payload FROM device_events WHERE device_sn = 'delta' AND kind = 'recording.stopped'`,
    )
    assert.equal(stopped[0]?.payload.reason, 'the feed was gone too long')
  },
)

test(
  'with no clip length set a recording is one file for as long as the feed runs, not a run of short clips',
  { skip: !hasFfmpeg, timeout: 40_000 },
  async () => {
    const whole = new RecordingManager(
      { store, manager },
      {
        dir: folder,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        segmentSeconds: 0, // the default: no time limit
        gapSeconds: 30,
        maxActive: 2,
        inputUrl: () => source,
        pollMs: 100,
        realtimeInput: true,
      },
    )
    await device('foxtrot')
    await liveStream('foxtrot')
    await whole.start('foxtrot', { email: 'admin@example.com' })
    // The 9 s feed comes in one piece (the other recordings cut it into three clips of 3 s).
    const rows = await until(
      async () => {
        const found = (await call('admin', 'GET', '/api/recordings?deviceSn=foxtrot')).json()
          .recordings as RecordingRecord[]
        return found.length >= 1 && found
      },
      30_000,
      'the first clip',
    )
    await whole.stop('foxtrot')
    await whole.dispose()
    const first = [...rows].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]!
    assert.ok(first.durationS >= 8, `one clip of the whole 9 s feed, got ${first.durationS} s`)
  },
)

test(
  'clips left on disk by a restart are archived, and a half-finished copy is cleaned up',
  { skip: !hasFfmpeg, timeout: 30_000 },
  async () => {
    // A fragmented clip as a killed ffmpeg leaves it, plus the copy a restart interrupted.
    const dir = path.join(folder, 'echo')
    await mkdir(dir, { recursive: true })
    const lost = path.join(dir, 'echo_20261114_120000.mp4')
    const made = spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      '-t',
      '3',
      '-c',
      'copy',
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      lost,
    ])
    assert.equal(made.status, 0)
    await writeFile(path.join(dir, 'echo_20261114_120000.part.mp4'), 'half a copy')
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(lost, old, old)

    const added = await recorder.indexOrphans()
    assert.equal(added, 1)
    const found = (await call('admin', 'GET', '/api/recordings?deviceSn=echo')).json()
      .recordings as RecordingRecord[]
    assert.equal(found.length, 1)
    assert.equal(found[0]!.startedAt, '2026-11-14T12:00:00.000Z')
    assert.ok(found[0]!.durationS >= 2 && found[0]!.durationS <= 4)
    assert.equal(found[0]!.startedBy, null, 'nobody is known to have started it')
    await assert.rejects(
      stat(path.join(dir, 'echo_20261114_120000.part.mp4')),
      'the half copy is removed',
    )
    assert.equal(await recorder.indexOrphans(), 0, 'indexing again adds nothing')
  },
)

/* -------------------------------------------------------------------- uploads */

/** Makes a 3 s test video, as another camera or phone would have recorded it. */
function makeVideo(file: string, extra: string[], withAudio = true): void {
  const made = spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=160x90:rate=15',
    ...(withAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440'] : []),
    '-t',
    '3',
    ...extra,
    file,
  ])
  assert.equal(made.status, 0, `could not make ${path.basename(file)}: ${made.stderr?.toString()}`)
}

function streamsOf(file: string): { video: string; audio: string } {
  const probe = spawnSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name',
    '-of',
    'csv=p=0',
    file,
  ])
  const lines = probe.stdout.toString().trim().split('\n')
  const pick = (kind: string) => lines.find((l) => l.endsWith(kind))?.split(',')[0] ?? ''
  return { video: pick('video'), audio: pick('audio') }
}

async function upload(
  name: string | null,
  body: Buffer,
  query: Record<string, string>,
  headers: Record<string, string> = {},
) {
  const token = name
    ? await issueSession(publicUser((await store.findUserById(ids[name]!))!), store)
    : null
  return app.inject({
    method: 'PUT',
    url: `/api/recordings/upload?${new URLSearchParams(query).toString()}`,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/octet-stream',
      ...headers,
    },
    payload: body,
  })
}

/** Waits until an upload has been made playable (or has failed), as the grid does by polling. */
async function settled(name: string, id: string): Promise<RecordingRecord> {
  return until(
    async () => {
      const found = (await call(name, 'GET', `/api/recordings/${id}`)).json()
        .recording as RecordingRecord
      return found.state !== 'processing' && found
    },
    40_000,
    'the upload to be made ready',
  )
}

let mp4: Buffer
let sources: Record<string, string> = {}

test('names stay as typed and become safe names on disk', () => {
  assert.equal(cleanName('  Dhaka   ops \n day 1 ', 80), 'Dhaka ops day 1')
  assert.equal(cleanName('ঢাকা অভিযান', 80), 'ঢাকা অভিযান', 'Bengali is kept')
  assert.equal(cleanName('x'.repeat(200), 10), 'xxxxxxxxxx')
  assert.equal(cleanName('   ', 10), null)
  assert.equal(cleanName(undefined, 10), null)

  assert.equal(diskName('Dhaka ops: Day 1', 'folder'), 'Dhaka-ops-Day-1')
  assert.equal(diskName('Gate camera', 'video', 80), 'Gate-camera')
  // Nothing a person types can climb out of the library or hide as a dot file.
  for (const hostile of ['../../etc', '..', '/', '.hidden', 'a/../../b', 'C:\\Windows', '....'])
    assert.match(diskName(hostile, 'folder'), /^[A-Za-z0-9][A-Za-z0-9._-]*$/, hostile)
  assert.equal(diskName('../../etc', 'folder'), 'etc')
  // No letters a file system keeps: a short hash, and different names get different folders.
  const a = diskName('ঢাকা অভিযান', 'folder')
  const b = diskName('চট্টগ্রাম', 'folder')
  assert.match(a, /^folder-[0-9a-f]{8}$/)
  assert.notEqual(a, b)
  assert.equal(
    diskName('ঢাকা অভিযান', 'folder'),
    a,
    'the same name always lands in the same folder',
  )
})

test(
  'an uploaded video goes into a folder made for it, plays, downloads and has a thumbnail',
  { skip: !hasFfmpeg, timeout: 90_000 },
  async () => {
    sources = {
      mp4: path.join(folder, 'u-h264.mp4'),
      mkv: path.join(folder, 'u-h264-ac3.mkv'),
      avi: path.join(folder, 'u-mpeg4.avi'),
      jpg: path.join(folder, 'u-still.jpg'),
    }
    makeVideo(sources.mp4!, [
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
    ])
    makeVideo(sources.mkv!, [
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'ac3',
    ])
    makeVideo(sources.avi!, ['-c:v', 'mpeg4', '-c:a', 'mp2'])
    makeVideo(sources.jpg!, ['-frames:v', '1'], false)
    mp4 = await readFile(sources.mp4!)
    assert.ok(mp4.length < 2 * 1024 * 1024, 'the test video must be under the test limit')

    const res = await upload('admin', mp4, {
      folder: 'Dhaka ops: Day 1',
      title: 'Gate camera',
      file: 'IMG_0042.mp4',
    })
    assert.equal(res.statusCode, 202)
    const created = res.json().recording as RecordingRecord
    assert.equal(created.source, 'upload')
    assert.equal(created.title, 'Gate camera')
    assert.equal(created.folder, 'Dhaka ops: Day 1', 'the folder keeps the name it was typed with')
    assert.equal(created.state, 'processing')
    assert.equal(created.deviceSn, null)
    assert.equal(created.mode, null)
    assert.equal(created.startedBy, 'admin@example.com')

    const ready = await settled('admin', created.id)
    assert.equal(ready.state, 'ready')
    assert.ok(ready.durationS >= 2 && ready.durationS <= 4, `about 3 s, got ${ready.durationS}`)
    assert.ok(ready.sizeBytes > 0)
    assert.equal(ready.filename, 'Gate camera.mp4')

    // The folder was created for it: a real directory, with the file in it, and nothing left waiting.
    const stored = (await store.recordings.get(created.id))!
    assert.equal(stored.file, 'library/Dhaka-ops-Day-1/Gate-camera.mp4')
    assert.ok((await stat(path.join(folder, 'library', 'Dhaka-ops-Day-1'))).isDirectory())
    assert.ok((await stat(path.join(folder, stored.file))).size > 0)
    await assert.rejects(
      stat(path.join(folder, '_incoming', `${created.id}.upload`)),
      'the waiting copy is removed',
    )

    // It plays, from the middle too, and downloads under the name it was given.
    const played = await call('admin', 'GET', `/api/recordings/${created.id}/video`, {
      range: 'bytes=0-1023',
    })
    assert.equal(played.statusCode, 206)
    assert.equal(played.headers['content-type'], 'video/mp4')
    const download = await call('admin', 'GET', `/api/recordings/${created.id}/video?download=1`)
    assert.equal(
      download.headers['content-disposition'],
      `attachment; filename="Gate camera.mp4"; filename*=UTF-8''Gate%20camera.mp4`,
    )

    // The grid card's picture.
    const thumb = await call('admin', 'GET', `/api/recordings/${created.id}/thumbnail`)
    assert.equal(thumb.statusCode, 200)
    assert.equal(thumb.headers['content-type'], 'image/jpeg')
    assert.deepEqual([...thumb.rawPayload.subarray(0, 2)], [0xff, 0xd8], 'a JPEG')
    assert.ok(
      (await stat(path.join(folder, `${stored.file}.jpg`))).size > 0,
      'kept beside the video',
    )

    // A second video with the same name in the same folder is numbered, not refused.
    const twin = (
      await upload('admin', mp4, { folder: 'Dhaka ops: Day 1', title: 'Gate camera' })
    ).json().recording as RecordingRecord
    assert.equal(twin.title, 'Gate camera (2)')
    await settled('admin', twin.id)
    assert.equal(
      (await store.recordings.get(twin.id))!.file,
      'library/Dhaka-ops-Day-1/Gate-camera-2.mp4',
    )

    // Folders are listed with their counts, and the archive filters by folder, name and source.
    const folders = (await call('admin', 'GET', '/api/recordings/folders')).json().folders
    assert.deepEqual(folders, [{ name: 'Dhaka ops: Day 1', count: 2 }])
    const inFolder = (
      await call('admin', 'GET', `/api/recordings?folder=${encodeURIComponent('Dhaka ops: Day 1')}`)
    ).json()
    assert.equal(inFolder.total, 2)
    assert.equal((await call('admin', 'GET', '/api/recordings?q=gate')).json().total, 2)
    assert.equal(
      (await call('admin', 'GET', '/api/recordings?q=nothing-like-this')).json().total,
      0,
    )
    assert.equal(
      (await call('admin', 'GET', '/api/recordings?q=50%25')).json().total,
      0,
      '% is a letter, not a wildcard',
    )
    const uploads = (await call('admin', 'GET', '/api/recordings?source=upload')).json()
    assert.ok(uploads.recordings.every((r: RecordingRecord) => r.source === 'upload'))
    const drone = (await call('admin', 'GET', '/api/recordings?source=drone')).json()
    assert.ok(drone.recordings.every((r: RecordingRecord) => r.source === 'drone'))
  },
)

test(
  'other formats are made playable: H.264 is copied, anything else converted, audio made AAC',
  { skip: !hasFfmpeg, timeout: 120_000 },
  async () => {
    // H.264 with AC-3 audio in a Matroska file: the picture is copied, only the audio is converted.
    const mkv = (
      await upload('admin', await readFile(sources.mkv!), { folder: 'Formats', title: 'From mkv' })
    ).json().recording as RecordingRecord
    const mkvDone = await settled('admin', mkv.id)
    assert.equal(mkvDone.state, 'ready')
    const mkvFile = path.join(folder, (await store.recordings.get(mkv.id))!.file)
    assert.deepEqual(streamsOf(mkvFile), { video: 'h264', audio: 'aac' })
    assert.ok(mkvFile.endsWith('.mp4'))

    // MPEG-4 in an AVI: a browser cannot play it, so it is converted to H.264.
    const avi = (
      await upload('admin', await readFile(sources.avi!), { folder: 'Formats', title: 'From avi' })
    ).json().recording as RecordingRecord
    assert.equal((await settled('admin', avi.id)).state, 'ready')
    const aviFile = path.join(folder, (await store.recordings.get(avi.id))!.file)
    assert.deepEqual(streamsOf(aviFile), { video: 'h264', audio: 'aac' })

    // A folder named in Bengali still gets a folder of its own, and keeps its name on screen.
    const bn = (await upload('admin', mp4, { folder: 'ঢাকা অভিযান', title: 'প্রথম ভিডিও' })).json()
      .recording as RecordingRecord
    assert.equal(bn.folder, 'ঢাকা অভিযান')
    assert.equal(bn.title, 'প্রথম ভিডিও')
    await settled('admin', bn.id)
    assert.match(
      (await store.recordings.get(bn.id))!.file,
      /^library\/folder-[0-9a-f]{8}\/video-[0-9a-f]{8}\.mp4$/,
    )
    const named = await call('admin', 'GET', `/api/recordings/${bn.id}/video?download=1`)
    assert.match(
      String(named.headers['content-disposition']),
      /filename\*=UTF-8''%E0%A6%AA.*\.mp4$/,
      'the real name is sent for browsers that read it',
    )

    // Whatever is typed, the file lands inside the library.
    const hostile = (
      await upload('admin', mp4, { folder: '../../etc', title: '../../../passwd' })
    ).json().recording as RecordingRecord
    await settled('admin', hostile.id)
    const place = (await store.recordings.get(hostile.id))!.file
    assert.match(place, /^library\/etc\/passwd\.mp4$/)
    await assert.rejects(
      stat(path.join(path.dirname(folder), 'etc')),
      'nothing was made outside the recordings folder',
    )
  },
)

test(
  'a file that is not a video, an empty one and one over the limit are refused and leave nothing',
  { skip: !hasFfmpeg },
  async () => {
    const before = (await call('admin', 'GET', '/api/recordings?source=upload')).json().total
    assert.equal(
      (await upload('admin', Buffer.from('just some text, not a video'), { title: 'Notes' }))
        .statusCode,
      415,
    )
    assert.equal(
      (await upload('admin', await readFile(sources.jpg!), { title: 'A photo' })).statusCode,
      415,
      'a still image is not a video',
    )
    assert.equal((await upload('admin', Buffer.alloc(0), { title: 'Empty' })).statusCode, 400)
    const big = await upload('admin', Buffer.alloc(3 * 1024 * 1024, 1), { title: 'Too big' })
    assert.equal(big.statusCode, 413)
    assert.match(big.json().message ?? big.json().error, /./)
    assert.equal(
      (await call('admin', 'GET', '/api/recordings?source=upload')).json().total,
      before,
      'nothing was entered in the archive',
    )
    assert.deepEqual(
      (await readdir(path.join(folder, '_incoming'))).filter((f) => !f.startsWith('x-')),
      [],
      'nothing is left waiting',
    )
  },
)

test(
  'who may upload, and whose uploads an account sees',
  { skip: !hasFfmpeg, timeout: 90_000 },
  async () => {
    // Uploading is its own right: a Sub-admin who can only watch, a Pilot and a stranger are refused.
    assert.equal((await upload('viewer', mp4, { title: 'x' })).statusCode, 403)
    assert.equal((await upload('teammate', mp4, { title: 'x' })).statusCode, 403)
    assert.equal((await upload('pilot', mp4, { title: 'x' })).statusCode, 403)
    assert.equal((await upload(null, mp4, { title: 'x' })).statusCode, 401)
    assert.equal((await upload('admin', mp4, { title: 'x', sn: 'nosuch' })).statusCode, 404)

    // Each customer's uploads are its own: a second Admin's team sees none of the first's.
    const mine = (await upload('admin', mp4, { folder: 'Mine', title: 'Private to admin' })).json()
      .recording as RecordingRecord
    await settled('admin', mine.id)
    const theirs = (
      await upload('admin2', mp4, { folder: 'Theirs', title: 'Private to admin2' })
    ).json().recording as RecordingRecord
    await settled('admin2', theirs.id)
    const seen = async (name: string) =>
      (
        (await call(name, 'GET', '/api/recordings?source=upload')).json()
          .recordings as RecordingRecord[]
      ).map((r) => r.id)
    assert.ok((await seen('admin')).includes(mine.id) && !(await seen('admin')).includes(theirs.id))
    assert.ok(
      (await seen('admin2')).includes(theirs.id) && !(await seen('admin2')).includes(mine.id),
    )
    assert.ok((await seen('teammate')).includes(mine.id), "the Admin's own team shares them")
    const everything = await seen('developer')
    assert.ok(
      everything.includes(mine.id) && everything.includes(theirs.id),
      'a Developer sees every customer',
    )
    assert.deepEqual((await call('admin2', 'GET', '/api/recordings/folders')).json().folders, [
      { name: 'Theirs', count: 1 },
    ])

    // For anyone else an upload does not exist: not a "forbidden" that confirms it is there.
    for (const url of [
      `/api/recordings/${mine.id}`,
      `/api/recordings/${mine.id}/video`,
      `/api/recordings/${mine.id}/thumbnail`,
    ])
      assert.equal((await call('admin2', 'GET', url)).statusCode, 404, url)
    assert.equal((await call('admin2', 'DELETE', `/api/recordings/${mine.id}`)).statusCode, 404)
    // A teammate may watch it but not delete it.
    assert.equal(
      (await call('teammate', 'GET', `/api/recordings/${mine.id}/video`, { range: 'bytes=0-9' }))
        .statusCode,
      206,
    )
    assert.equal((await call('teammate', 'DELETE', `/api/recordings/${mine.id}`)).statusCode, 403)

    // An upload tied to a drone also needs the grant on that drone.
    const onAlpha = (await upload('admin', mp4, { title: 'From alpha', sn: 'alpha' })).json()
      .recording as RecordingRecord
    const onBravo = (await upload('admin', mp4, { title: 'From bravo', sn: 'bravo' })).json()
      .recording as RecordingRecord
    await settled('admin', onAlpha.id)
    await settled('admin', onBravo.id)
    assert.equal(onAlpha.deviceSn, 'alpha')
    const limited = await seen('scoped2')
    assert.ok(limited.includes(onAlpha.id), 'footage of a drone it may see')
    assert.ok(!limited.includes(onBravo.id), 'footage of a drone it may not')
    assert.ok(
      limited.includes(mine.id),
      "an upload tied to no drone is the whole team's, whichever drones an account is limited to",
    )
  },
)

test(
  'deleting an upload removes its file and thumbnail; a restart finishes or fails what was mid-way',
  { skip: !hasFfmpeg, timeout: 60_000 },
  async () => {
    const gone = (await upload('admin', mp4, { folder: 'Temporary', title: 'To delete' })).json()
      .recording as RecordingRecord
    await settled('admin', gone.id)
    const file = path.join(folder, (await store.recordings.get(gone.id))!.file)
    await call('admin', 'GET', `/api/recordings/${gone.id}/thumbnail`)
    assert.equal((await call('admin', 'DELETE', `/api/recordings/${gone.id}`)).statusCode, 204)
    await assert.rejects(stat(file))
    await assert.rejects(stat(`${file}.jpg`))
    assert.equal((await call('admin', 'GET', `/api/recordings/${gone.id}`)).statusCode, 404)

    // The API stopped while one upload was still being converted and another was still arriving.
    await mkdir(path.join(folder, '_incoming'), { recursive: true })
    const half = path.join(folder, '_incoming', 'x-arriving.part')
    await writeFile(half, 'half a file')
    const waiting = randomUUID()
    await writeFile(path.join(folder, '_incoming', `${waiting}.upload`), mp4)
    await store.recordings.insert({
      id: waiting,
      sessionId: waiting,
      deviceSn: null,
      mode: 'upload',
      source: 'upload',
      title: 'Left over',
      folder: 'Recovered',
      state: 'processing',
      tenantId: ids.admin!,
      file: `_incoming/${waiting}.upload`,
      startedAt: new Date(),
      endedAt: new Date(),
      durationS: 3,
      sizeBytes: mp4.length,
      operatorEmail: 'admin@example.com',
    })
    const lost = randomUUID()
    await store.recordings.insert({
      id: lost,
      sessionId: lost,
      deviceSn: null,
      mode: 'upload',
      source: 'upload',
      title: 'Lost',
      folder: 'Recovered',
      state: 'processing',
      tenantId: ids.admin!,
      file: `_incoming/${lost}.upload`,
      startedAt: new Date(),
      endedAt: new Date(),
      durationS: 3,
      sizeBytes: 10,
      operatorEmail: 'admin@example.com',
    })

    await library.resume()
    await assert.rejects(stat(half), 'a file that never finished arriving is removed')
    assert.equal((await settled('admin', waiting)).state, 'ready')
    assert.equal((await store.recordings.get(waiting))!.file, 'library/Recovered/Left-over.mp4')
    const failed = await settled('admin', lost)
    assert.equal(failed.state, 'failed')
    assert.match(failed.error ?? '', /upload it again/)
    assert.equal(
      (await call('admin', 'GET', `/api/recordings/${lost}/video`)).statusCode,
      409,
      'nothing to play',
    )
  },
)

/* ------------------------------------------------------------ automatic recording */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function makeRecorder(extra: Partial<RecorderOptions> = {}): RecordingManager {
  return new RecordingManager(
    { store, manager },
    {
      dir: folder,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      segmentSeconds: 3,
      // One second: a recording someone started is over after this; an automatic one must go on.
      gapSeconds: 1,
      maxActive: 50,
      inputUrl: () => source ?? '/nonexistent',
      pollMs: 100,
      realtimeInput: true,
      ...extra,
    },
  )
}

test('automatic recording follows the setting for each drone and the default, waits for a drone that is away, and mends itself', async () => {
  await device('auto1')
  await device('auto2')
  await device('auto3')
  const auto = makeRecorder({ autoDefault: false })

  // Nothing is set: nobody records.
  await auto.reconcile()
  assert.equal(auto.isAuto('auto1'), false)

  // One drone is set: its recording exists at once, waiting for the drone to connect.
  await store.recordings.setAuto('auto1', true)
  await auto.reconcile()
  assert.equal(auto.isAuto('auto1'), true)
  assert.equal(auto.stateOf('auto1'), 'waiting')

  // The drone is away for longer than a manual recording would wait: the automatic one stays,
  // and a manual one in the same position is over.
  await auto.start('auto2', { email: 'someone@example.com' })
  await sleep(2200)
  assert.equal(auto.isAuto('auto1'), true, 'an automatic recording waits for as long as it is on')
  assert.equal(auto.isRecording('auto2'), false, 'a manual recording ends when its feed is gone')

  // A manual recording of a drone that is then set to automatic becomes the automatic one.
  const manual = await auto.start('auto2', { email: 'someone@example.com' })
  await store.recordings.setAuto('auto2', true)
  await auto.reconcile()
  assert.equal(auto.isAuto('auto2'), true)
  assert.equal(
    (await auto.active()).find((r) => r.deviceSn === 'auto2')?.sessionId,
    manual.sessionId,
  )

  // Turned off: it stops. A drone that is taken out of service stops too.
  await store.recordings.setAuto('auto1', false)
  await auto.reconcile()
  assert.equal(auto.isRecording('auto1'), false)
  await db.query(`UPDATE devices SET disabled_at = now() WHERE sn = 'auto2'`)
  await auto.reconcile()
  assert.equal(auto.isRecording('auto2'), false)
  await db.query(`UPDATE devices SET disabled_at = NULL WHERE sn = 'auto2'`)
  await auto.dispose()

  // The installation default: a drone with no choice of its own records, one set off does not.
  await store.recordings.setAuto('auto2', null)
  const byDefault = makeRecorder({ autoDefault: true })
  await byDefault.reconcile()
  assert.equal(byDefault.isAuto('auto3'), true, 'no choice made: follows the default')
  assert.equal(byDefault.isAuto('auto2'), true)
  assert.equal(byDefault.isAuto('auto1'), false, 'set off for this drone')
  await byDefault.dispose()
  assert.equal(byDefault.isRecording('auto3'), false)
  await byDefault.reconcile() // after shutdown nothing starts again
  assert.equal(byDefault.isRecording('auto3'), false)
})

test(
  'an automatic recording records each time the drone connects, in clips named for the drone, and pauses and resumes for the disk',
  { skip: !hasFfmpeg, timeout: 120_000 },
  async () => {
    await device('auto4')
    await db.query(`UPDATE devices SET display_name = 'Gate drone' WHERE sn = 'auto4'`)
    const auto = makeRecorder()
    await store.recordings.setAuto('auto4', true)
    await auto.reconcile()
    assert.equal(auto.stateOf('auto4'), 'waiting')

    // The drone connects (its feed goes live) after the recording has been waiting longer than a manual one would.
    await sleep(2200)
    assert.equal(auto.isAuto('auto4'), true)
    await liveStream('auto4')
    const clipsOf = async () =>
      (await call('admin', 'GET', '/api/recordings?deviceSn=auto4&limit=100')).json()
        .recordings as RecordingRecord[]
    const first = await until(
      async () => {
        const found = await clipsOf()
        return found.length >= 2 && found
      },
      40_000,
      'automatic clips',
    )
    for (const clip of first) {
      assert.equal(clip.mode, 'continuous')
      assert.equal(clip.startedBy, null, 'nobody started it: the setting did')
    }

    // The file says whose it is and that it was automatic; the download is named for the drone and the time.
    const stored = (await store.recordings.get(first[0]!.id))!
    assert.match(stored.file, /^auto4\/Gate-drone_auto4_auto_\d{8}_\d{6}Z\.mp4$/)
    assert.match(
      first[0]!.filename,
      /^DRONE-FLEET_Gate drone_20\d\d-\d\d-\d\d_\d\d-\d\d-\d\d\.mp4$/,
    )
    assert.ok(
      (await stat(path.join(folder, `${stored.file}.jpg`))).size > 0,
      'the thumbnail is made as the clip is archived',
    )

    // The disk is too full: the recording pauses, writes nothing, and says so.
    auto.setPaused('The disk is almost full.')
    await until(async () => auto.stateOf('auto4') === 'paused', 15_000, 'the recording to pause')
    await sleep(2500)
    const atPause = (await clipsOf()).length
    await sleep(4500)
    assert.equal((await clipsOf()).length, atPause, 'nothing is written while it is paused')
    assert.equal(auto.isPaused, true)

    // There is room again: it carries on by itself, as a new recording.
    auto.setPaused(null)
    await until(async () => (await clipsOf()).length > atPause, 40_000, 'the recording to resume')
    const sessions = new Set((await clipsOf()).map((clip) => clip.sessionId))
    assert.ok(sessions.size >= 2, 'each connection is a recording of its own')

    await store.recordings.setAuto('auto4', false)
    await auto.reconcile()
    assert.equal(auto.isAuto('auto4'), false)
    await auto.dispose()
  },
)

/* --------------------------------------------------------------------- cleanup */

test('cleanup deletes only automatic clips, by age, by size and for free space, and pauses recording rather than fill the disk', async () => {
  const jdir = await mkdtemp(path.join(tmpdir(), 'drone-clean-'))
  const embeddedJ = new PGlite()
  const jdb: Db = {
    query: async <T>(sql: string, params?: unknown[]) =>
      (await embeddedJ.query<T>(sql, params)).rows,
    exec: async (sql) => {
      await embeddedJ.exec(sql)
    },
    close: () => embeddedJ.close(),
  }
  await migrate(jdb)
  const jstore = new Store(jdb)
  const jrecorder = makeRecorder({ dir: jdir })
  const jlibrary = new VideoLibrary(jstore, {
    dir: jdir,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    maxBytes: 1e9,
  })
  const janitorWith = (over: Partial<JanitorOptions>) =>
    new Janitor(
      { store: jstore, recorder: jrecorder, library: jlibrary },
      {
        dir: jdir,
        retentionDays: 0,
        maxBytes: 0,
        minFreeBytes: 1,
        intervalSeconds: 60,
        autoDefault: false,
        telemetryRetentionDays: 0,
        mqttLogRetentionDays: 0,
        freeSpace: async () => ({ free: 1e12, total: 2e12 }),
        ...over,
      },
    )
  const day = 86_400_000
  let n = 0
  const add = async (daysAgo: number, kind: 'auto' | 'manual' | 'upload', size = 1000) => {
    const id = randomUUID()
    const rel = `${kind === 'upload' ? 'library/x' : 'drone9'}/c${++n}-${id}.mp4`
    const abs = path.join(jdir, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, 'video')
    await writeFile(`${abs}.jpg`, 'still')
    const started = new Date(Date.now() - daysAgo * day)
    await jstore.recordings.insert({
      id,
      sessionId: id,
      deviceSn: kind === 'upload' ? null : 'drone9',
      mode: kind === 'auto' ? 'continuous' : kind === 'manual' ? 'manual' : 'upload',
      source: kind === 'upload' ? 'upload' : 'drone',
      title: kind === 'upload' ? `upload ${n}` : null,
      folder: kind === 'upload' ? 'X' : null,
      tenantId: kind === 'upload' ? 'tenant' : null,
      file: rel,
      startedAt: started,
      endedAt: new Date(started.getTime() + 600_000),
      durationS: 600,
      sizeBytes: size,
      operatorEmail: null,
    })
    return { id, abs }
  }
  const exists = async (clip: { id: string; abs: string }) => ({
    row: (await jstore.recordings.get(clip.id)) !== null,
    file: await stat(clip.abs).then(
      () => true,
      () => false,
    ),
    still: await stat(`${clip.abs}.jpg`).then(
      () => true,
      () => false,
    ),
  })
  const clearAll = async () => jdb.exec('DELETE FROM recordings')

  // 1. Age: an automatic clip past the retention goes, with its file and thumbnail. A manual
  //    recording and an upload, however old, stay.
  const old = await add(40, 'auto')
  const mid = await add(10, 'auto')
  const fresh = await add(1, 'auto')
  const oldManual = await add(60, 'manual')
  const oldUpload = await add(90, 'upload')
  const byAge = janitorWith({ retentionDays: 30 })
  await byAge.run()
  assert.deepEqual(await exists(old), { row: false, file: false, still: false })
  for (const kept of [mid, fresh, oldManual, oldUpload])
    assert.deepEqual(await exists(kept), { row: true, file: true, still: true })
  const cleaned = (await byAge.status()).lastCleanup
  assert.equal(cleaned?.clips, 1)
  assert.match(cleaned?.reason ?? '', /older than 30 days/)

  // 2. Size: over the limit the oldest automatic clips go first, down to 97 % of it.
  await clearAll()
  const a = await add(5, 'auto')
  const b = await add(4, 'auto')
  const c = await add(3, 'auto')
  const m = await add(2, 'manual')
  const u = await add(1, 'upload')
  await janitorWith({ maxBytes: 4000 }).run() // 5000 used: A and B must go to get under 3880
  assert.equal((await exists(a)).row || (await exists(b)).row, false, 'the oldest two are gone')
  for (const kept of [c, m, u]) assert.equal((await exists(kept)).row, true)
  assert.equal((await jstore.recordings.usage()).usedBytes, 3000)

  // 3. Free space: the oldest automatic clips go until there is room again, never a manual one.
  await clearAll()
  const autos = []
  for (let i = 5; i >= 1; i--) autos.push(await add(i, 'auto', 1e9))
  const keepM = await add(0.5, 'manual', 1e9)
  const startUsed = (await jstore.recordings.usage()).usedBytes
  let base = 9e9
  const lowSpace = async () => ({
    free: base + (startUsed - (await jstore.recordings.usage()).usedBytes),
    total: 1e12,
  })
  const floor = janitorWith({ minFreeBytes: 10e9, freeSpace: lowSpace })
  jrecorder.setPaused(null)
  await floor.run() // wants 12.5 GB free: needs four of the five
  assert.deepEqual(
    await Promise.all(autos.map(async (clip) => (await exists(clip)).row)),
    [false, false, false, false, true],
    'oldest first, and only as many as needed',
  )
  assert.equal((await exists(keepM)).row, true)
  assert.equal(jrecorder.isPaused, false, 'there is room, so recording goes on')

  // 4. Nothing automatic left and still too full: recording pauses (and the manual clip stays);
  //    when a person frees space it resumes by itself.
  base = 2e9
  await floor.run()
  assert.equal((await exists(autos[4]!)).row, false)
  assert.equal((await exists(keepM)).row, true, 'a manual recording is never deleted to make room')
  assert.equal(jrecorder.isPaused, true)
  assert.match(jrecorder.pausedReason ?? '', /almost full/)
  const status = await floor.status()
  assert.equal(status.paused, true)
  assert.equal(status.minFreeBytes, 10e9)
  assert.equal(status.autoBytes, 0)
  assert.equal(status.usedBytes, 1e9)
  base = 50e9
  await floor.run()
  assert.equal(jrecorder.isPaused, false, 'it resumes by itself')
  assert.equal((await floor.status()).paused, false)

  // 5. The tables that would grow for good are trimmed.
  await jdb.exec(
    `INSERT INTO mqtt_log (ts, topic, payload) VALUES (now() - interval '10 days', 'old', '{}'), (now() - interval '1 day', 'new', '{}')`,
  )
  // By default nothing is trimmed: the raw MQTT log is what real aircraft captures are studied from. Only a
  // set retention removes lines, and then only the old ones.
  const logLines = async () =>
    (await jdb.query<{ n: number }>('SELECT count(*)::int AS n FROM mqtt_log'))[0]!.n
  await janitorWith({ mqttLogRetentionDays: 0 }).run()
  assert.equal(await logLines(), 2, 'kept by default')
  await janitorWith({ mqttLogRetentionDays: 7 }).run()
  assert.equal(await logLines(), 1, 'a set retention removes the old line only')
  assert.equal(await jstore.pruneMqttLog(7), 0, 'nothing older is left')
  await jdb.exec(`INSERT INTO telemetry_samples (device_sn, ts, raw)
    SELECT 'x', now() - interval '40 days' - (g || ' seconds')::interval, '{}' FROM generate_series(1, 5) g`)
  await jdb.exec(`INSERT INTO telemetry_samples (device_sn, ts, raw) VALUES ('x', now(), '{}')`)
  assert.equal(await jstore.pruneTelemetry(30, 2), 5, 'trimmed in batches until none is left')
  assert.equal(
    (await jdb.query<{ n: number }>('SELECT count(*)::int AS n FROM telemetry_samples'))[0]!.n,
    1,
  )

  await jrecorder.dispose()
  await jdb.close()
  await rm(jdir, { recursive: true, force: true })
})

test('automatic recording and the storage figures are for whoever may record, and an automatic recording is not stopped from outside', async () => {
  // Someone who may only watch sees and changes nothing here.
  for (const [method, url] of [
    ['GET', '/api/recordings/auto'],
    ['GET', '/api/recordings/storage'],
    ['PUT', '/api/devices/auto5/recording/auto'],
  ] as const)
    assert.equal(
      (await call('viewer', method, url, {}, { enabled: true })).statusCode,
      403,
      `${method} ${url}`,
    )

  // An account that may record auto5 only: it sees auto5 in the list, may set it, and not auto6.
  const own = (await call('recorder', 'GET', '/api/recordings/auto')).json()
    .drones as RecordingAutoDrone[]
  assert.deepEqual(
    own.map((d) => d.deviceSn),
    ['auto5'],
  )
  assert.equal(
    (await call('recorder', 'PUT', '/api/devices/auto6/recording/auto', {}, { enabled: true }))
      .statusCode,
    403,
  )
  assert.equal(
    (await call('admin', 'PUT', '/api/devices/nosuch/recording/auto', {}, { enabled: true }))
      .statusCode,
    404,
  )
  assert.equal(
    (await call('admin', 'PUT', '/api/devices/auto5/recording/auto', {}, { enabled: 'yes' }))
      .statusCode,
    400,
  )

  const on = await call(
    'recorder',
    'PUT',
    '/api/devices/auto5/recording/auto',
    {},
    { enabled: true },
  )
  assert.equal(on.statusCode, 200)
  assert.deepEqual(on.json(), { enabled: true, setting: true })
  assert.equal(recorder.isAuto('auto5'), true, 'set up at once, without waiting for the next check')
  const listed = (
    (await call('admin', 'GET', '/api/recordings/auto')).json().drones as RecordingAutoDrone[]
  ).find((d) => d.deviceSn === 'auto5')!
  assert.equal(listed.enabled, true)
  assert.equal(listed.setting, true)
  assert.ok(['waiting', 'recording'].includes(listed.state))

  // It records automatically, so it cannot be stopped here: it would start again at once.
  const refused = await call('admin', 'DELETE', '/api/devices/auto5/recording')
  assert.equal(refused.statusCode, 409)
  assert.match(refused.json().error, /automatically/)
  assert.equal(recorder.isAuto('auto5'), true)

  // Following the default (off here) stops it.
  const off = await call('admin', 'PUT', '/api/devices/auto5/recording/auto', {}, { enabled: null })
  assert.deepEqual(off.json(), { enabled: false, setting: null })
  assert.equal(recorder.isRecording('auto5'), false)
  assert.equal((await call('admin', 'DELETE', '/api/devices/auto5/recording')).statusCode, 204)

  // The storage figures.
  const storage = (
    await call('recorder', 'GET', '/api/recordings/storage')
  ).json() as RecordingStorage
  assert.equal(storage.retentionDays, 30)
  assert.equal(storage.minFreeBytes, 10 * 1024 ** 3)
  assert.equal(storage.freeBytes, 500 * 1024 ** 3)
  assert.equal(storage.paused, false)
  assert.ok(storage.usedBytes > 0 && storage.clips > 0)
  assert.equal(storage.autoDefault, false)
})

test('the videos folder: only a usable folder is accepted, a change is remembered, and videos saved earlier are still found', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'drone-place-'))
  const saved = new Map<string, unknown>()
  const settings = {
    getSetting: async <T>(key: string) => (saved.get(key) as T | undefined) ?? null,
    setSetting: async (key: string, value: unknown) => void saved.set(key, value),
  }
  const a = path.join(base, 'a')
  const b = path.join(base, 'b')
  const place = new RecordingPlace(a, false, settings)
  await place.load()
  assert.equal(place.dir, a)

  // What is refused, and why.
  await writeFile(path.join(base, 'file.txt'), 'not a folder')
  const refused: [string, string][] = [
    ['', 'relative'],
    ['relative/folder', 'relative'],
    [path.parse(base).root, 'root'],
    [path.join(base, 'file.txt'), 'not_dir'],
  ]
  if (process.platform !== 'win32') refused.push(['/etc/drone-fleet', 'system'])
  for (const [input, code] of refused)
    await assert.rejects(
      () => place.set(input, 'dev@example.com'),
      (error: unknown) => error instanceof PlaceError && error.code === code,
      `${input || '(empty)'} should be refused as ${code}`,
    )
  assert.equal(place.dir, a, 'a refused folder changes nothing')
  assert.equal(saved.size, 0)

  // A folder the server cannot write into (skipped as root, which can write anywhere).
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = path.join(base, 'locked')
    await mkdir(locked, { mode: 0o500 })
    await assert.rejects(
      () => place.set(locked, null),
      (error: unknown) => error instanceof PlaceError && error.code === 'not_writable',
    )
  }

  // A video saved in the first folder, then the folder is changed: it is still found, and a new one goes to the new folder.
  await mkdir(path.join(a, 'alpha'), { recursive: true })
  await writeFile(path.join(a, 'alpha', 'old.mp4'), 'old')
  const moved = await place.set(b, 'dev@example.com')
  assert.deepEqual(moved, { from: a, to: b })
  assert.equal(place.dir, b)
  assert.deepEqual(place.olderDirs, [a])
  assert.deepEqual(saved.get('recordings.location'), { dir: b, older: [a] })
  assert.equal(place.resolve('alpha/old.mp4'), path.join(a, 'alpha', 'old.mp4'))
  assert.equal(place.resolve('alpha/new.mp4'), path.join(b, 'alpha', 'new.mp4'))
  assert.equal(place.resolve('../escape.mp4'), null)
  assert.equal((await place.set(b, null)).from, b, 'choosing the folder in use changes nothing')
  assert.deepEqual(place.olderDirs, [a])

  // Going back makes the folder in use the main one again, and the other the older one.
  await place.set(a, null)
  assert.deepEqual(place.olderDirs, [b])

  // After a restart the saved folder is used; if its disk is gone the server still starts and says so.
  const restarted = new RecordingPlace(path.join(base, 'default'), false, settings)
  await restarted.load()
  assert.equal(restarted.dir, a)
  assert.equal(restarted.warning, null)
  await rm(a, { recursive: true, force: true })
  const orphaned = new RecordingPlace(path.join(base, 'default'), false, settings)
  await orphaned.load()
  assert.equal(orphaned.dir, path.join(base, 'default'))
  assert.match(orphaned.warning ?? '', /cannot be used now/)

  // A Docker install fixes the folder: nothing here can change it.
  const fixed = new RecordingPlace(b, true, settings)
  await assert.rejects(
    () => fixed.set(a, null),
    (error: unknown) => error instanceof PlaceError && error.code === 'locked',
  )

  // The picker: folders only, sorted, and a new folder can be made; slips are refused.
  await mkdir(path.join(base, 'Zeta'))
  await mkdir(path.join(base, '.hidden'))
  const listing = await place.browse(base)
  assert.equal(listing.path, base)
  assert.deepEqual(
    listing.folders.map((f) => f.name),
    ['b', 'locked', 'Zeta'].filter((name) =>
      process.platform !== 'win32' && process.getuid?.() !== 0 ? true : name !== 'locked',
    ),
  )
  assert.equal(listing.parent, path.dirname(base))
  assert.equal(listing.writable, true)
  assert.ok(listing.shortcuts.length >= 1)
  const made = await place.makeFolder(base, 'New videos')
  assert.equal(made, path.join(base, 'New videos'))
  assert.equal(await place.makeFolder(base, 'New videos'), made, 'making it twice is fine')
  for (const name of ['', '..', 'a/b', 'a\\b', 'x'.repeat(81)])
    await assert.rejects(
      () => place.makeFolder(base, name),
      (error: unknown) => error instanceof PlaceError && error.code === 'bad_name',
    )
  await assert.rejects(() => place.browse('relative'), PlaceError)
  // A folder that is not there yet shows the nearest one that is.
  assert.equal((await place.browse(path.join(base, 'nothing', 'here'))).path, base)

  await rm(base, { recursive: true, force: true })
})

test(
  'only a Developer chooses the videos folder; old videos still play, new ones and live recordings go to the new folder',
  { skip: !hasFfmpeg, timeout: 90_000 },
  async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'drone-move-'))
    const newer = path.join(base, 'Videos')

    // Nobody but a Developer may even look.
    for (const name of ['admin', 'recorder', 'pilot', 'viewer']) {
      assert.equal((await call(name, 'GET', '/api/recordings/location')).statusCode, 403, name)
      assert.equal(
        (
          await call(
            name,
            'GET',
            `/api/recordings/location/browse?path=${encodeURIComponent(base)}`,
          )
        ).statusCode,
        403,
        name,
      )
      assert.equal(
        (await call(name, 'PUT', '/api/recordings/location', {}, { dir: newer })).statusCode,
        403,
        name,
      )
      assert.equal(
        (
          await call(
            name,
            'POST',
            '/api/recordings/location/folder',
            {},
            { parent: base, name: 'x' },
          )
        ).statusCode,
        403,
        name,
      )
    }

    const shown = (await call('developer', 'GET', '/api/recordings/location')).json().location
    assert.equal(shown.dir, folder)
    assert.equal(shown.locked, false)
    assert.ok(shown.freeBytes > 0)
    assert.equal(shown.warning, null)

    // The picker and "New folder".
    const browse = await call(
      'developer',
      'GET',
      `/api/recordings/location/browse?path=${encodeURIComponent(base)}`,
    )
    assert.equal(browse.statusCode, 200)
    assert.equal(browse.json().path, base)
    assert.equal(
      (await call('developer', 'GET', '/api/recordings/location/browse?path=relative')).statusCode,
      400,
    )
    const madeFolder = await call(
      'developer',
      'POST',
      '/api/recordings/location/folder',
      {},
      { parent: base, name: 'Videos' },
    )
    assert.equal(madeFolder.statusCode, 201)
    assert.equal(madeFolder.json().path, newer)
    assert.equal(
      (
        await call(
          'developer',
          'POST',
          '/api/recordings/location/folder',
          {},
          { parent: base, name: '../x' },
        )
      ).statusCode,
      400,
    )

    // A video saved before the change, and a recording that is running during it.
    const before = await clip('alpha', '2026-11-01T08:00:00Z', 30)
    await device('mover')
    await liveStream('mover')
    const t0 = Date.now()
    assert.equal((await call('admin', 'POST', '/api/devices/mover/recording')).statusCode, 200)
    await until(
      async () => (await readdir(path.join(folder, 'mover')).catch(() => [])).length > 0,
      30_000,
      'a first clip in the old folder',
    )

    for (const bad of ['relative', path.join(folder, 'source.flv'), '/etc/fleet']) {
      const refused = await call('developer', 'PUT', '/api/recordings/location', {}, { dir: bad })
      assert.equal(refused.statusCode, 400, bad)
      assert.ok(refused.json().error.length > 10)
    }
    assert.equal(place.dir, folder, 'a refused folder changes nothing')

    const changed = await call('developer', 'PUT', '/api/recordings/location', {}, { dir: newer })
    assert.equal(changed.statusCode, 200, changed.body)
    assert.equal(changed.json().location.dir, newer)
    assert.deepEqual(changed.json().location.older, [folder])
    assert.ok(changed.json().location.clips >= 1)
    assert.deepEqual((await store.getSetting<{ dir: string }>('recordings.location'))?.dir, newer)
    const kinds = (
      await db.query<{ kind: string }>(
        `SELECT kind FROM device_events WHERE kind = 'recording.location_changed'`,
      )
    ).map((r) => r.kind)
    assert.equal(kinds.length, 1)

    // The video from before still plays and can be deleted, from the folder it is in.
    const played = await call('admin', 'GET', `/api/recordings/${before.id}/video`, {
      range: 'bytes=0-9',
    })
    assert.equal(played.statusCode, 206)

    // The running recording closes its clip and carries on in the new folder.
    await until(
      async () => (await readdir(path.join(newer, 'mover')).catch(() => [])).length > 0,
      30_000,
      'a clip in the new folder',
    )
    assert.equal(recorder.isRecording('mover'), true)
    await call('admin', 'DELETE', '/api/devices/mover/recording')
    const rows = (
      await call(
        'admin',
        'GET',
        `/api/recordings?deviceSn=mover&from=${new Date(t0 - 1000).toISOString()}`,
      )
    ).json().recordings as RecordingRecord[]
    assert.ok(rows.length >= 2, 'clips from both folders are in the archive')
    for (const row of rows) {
      const ok = await call('admin', 'GET', `/api/recordings/${row.id}/video`, {
        range: 'bytes=0-9',
      })
      assert.equal(ok.statusCode, 206, 'every clip plays, whichever folder it is in')
    }

    // An upload after the change is kept in the new folder.
    const file = path.join(base, 'u.mp4')
    makeVideo(file, [
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
    ])
    const res = await upload('admin', await readFile(file), {
      folder: 'Moved',
      title: 'After the move',
    })
    assert.equal(res.statusCode, 202, res.body)
    const done = await settled('admin', res.json().recording.id)
    assert.equal(done.state, 'ready')
    const stored = (
      await db.query<{ file: string }>(`SELECT file FROM recordings WHERE id = $1`, [done.id])
    )[0]!.file
    assert.ok((await stat(path.join(newer, stored))).isFile(), 'the upload is in the new folder')
    await assert.rejects(() => stat(path.join(folder, stored)))

    // Deleting the old clip removes the file where it is.
    assert.equal((await call('admin', 'DELETE', `/api/recordings/${before.id}`)).statusCode, 204)
    await assert.rejects(() => stat(before.abs))

    // Back to the first folder, so what follows is unchanged.
    const back = await call('developer', 'PUT', '/api/recordings/location', {}, { dir: folder })
    assert.equal(back.statusCode, 200)
    assert.deepEqual(back.json().location.older, [newer])
    await rm(base, { recursive: true, force: true })
  },
)

test('storage areas: a folder can only be chosen inside one, and the picker never leaves them', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'drone-areas-'))
  const one = path.join(base, 'one')
  const two = path.join(base, 'two')
  for (const dir of [one, two, path.join(base, 'outside'), path.join(base, 'two-evil')])
    await mkdir(dir)

  // The setting: folders and labels, in order; anything that is not an absolute path or repeats is left out.
  const roots = parseStorageRoots(`${one}=Default storage, ${two}=Big disk,relative/path,${one},`)
  assert.deepEqual(roots, [
    { path: one, label: 'Default storage' },
    { path: two, label: 'Big disk' },
  ])
  assert.deepEqual(parseStorageRoots(undefined), [])
  assert.equal(
    parseStorageRoots(`${one}`)[0]!.label,
    'one',
    'a folder with no label is named after itself',
  )

  const place = new RecordingPlace(one, false, undefined, roots)
  const code = (expected: string) => (error: unknown) =>
    error instanceof PlaceError && error.code === expected

  // Inside an area (made if needed) is fine; outside, or a folder that only starts with an area's name, is not.
  const moved = await place.set(path.join(two, 'videos'), 'dev@example.com')
  assert.equal(moved.to, path.join(two, 'videos'))
  await assert.rejects(() => place.set(path.join(base, 'outside'), null), code('outside'))
  await assert.rejects(() => place.set(path.join(base, 'two-evil'), null), code('outside'))
  await assert.rejects(
    () => place.set(path.join(two, '..', 'outside'), null),
    code('outside'),
    'a path that climbs out is judged by where it ends up',
  )
  await assert.rejects(
    () => place.set(path.join(base, 'outside'), null),
    /Default storage, Big disk/,
  )

  // The picker lists the areas to go to, stops at the top of one, and refuses to look outside.
  const top = await place.browse(two)
  assert.equal(top.path, two)
  assert.equal(top.parent, null, 'no way up from a storage area')
  assert.deepEqual(
    top.shortcuts.map((item) => item.label),
    ['Default storage', 'Big disk'],
  )
  assert.deepEqual(
    top.folders.map((item) => item.name),
    ['videos'],
  )
  assert.ok(top.freeBytes! > 0 && top.totalBytes! >= top.freeBytes!)
  const inner = await place.browse(path.join(two, 'videos'))
  assert.equal(inner.parent, two)
  await assert.rejects(() => place.browse(path.join(base, 'outside')), code('outside'))
  await assert.rejects(() => place.makeFolder(path.join(base, 'outside'), 'x'), code('outside'))
  assert.equal(
    await place.makeFolder(two, 'more'),
    path.join(two, 'more'),
    'a folder can be made inside an area',
  )
  // Without a place to start, the picker opens the first area.
  const stray = new RecordingPlace(path.join(base, 'outside'), false, undefined, roots)
  assert.equal((await stray.browse()).path, one)
  // A saved folder that is no longer inside an area is not used at start-up.
  const saved = new Map<string, unknown>([
    ['recordings.location', { dir: path.join(base, 'outside'), older: [] }],
  ])
  const reloaded = new RecordingPlace(
    one,
    false,
    {
      getSetting: async <T>(key: string) => (saved.get(key) as T | undefined) ?? null,
      setSetting: async () => undefined,
    },
    roots,
  )
  await reloaded.load()
  assert.equal(reloaded.dir, one)
  assert.match(reloaded.warning ?? '', /storage areas/)

  await rm(base, { recursive: true, force: true })
})

test('the list can be ordered by when footage was recorded or when it was added', async () => {
  await device('sorter')
  // Added in this order; recorded in another. The times they were added are set apart so none ties.
  const first = await clip('sorter', '2026-02-03T08:00:00Z', 5)
  const second = await clip('sorter', '2026-02-01T08:00:00Z', 5)
  const third = await clip('sorter', '2026-02-02T08:00:00Z', 5)
  for (const [n, added] of [first, second, third].entries())
    await db.query(
      `UPDATE recordings SET created_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
      [added.id, String(10 - n)],
    )
  const days = async (query: string) =>
    (
      (await call('admin', 'GET', `/api/recordings?deviceSn=sorter${query}`)).json()
        .recordings as RecordingRecord[]
    ).map((r) => r.startedAt.slice(8, 10))
  assert.deepEqual(await days(''), ['03', '02', '01'], 'newest footage first by default')
  assert.deepEqual(await days('&sort=recorded'), ['03', '02', '01'])
  assert.deepEqual(await days('&sort=oldest'), ['01', '02', '03'])
  assert.deepEqual(await days('&sort=added'), ['02', '01', '03'], 'the last one added comes first')
  assert.equal((await call('admin', 'GET', '/api/recordings?sort=sideways')).statusCode, 400)
})
