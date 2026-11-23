import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import {
  cleanNote,
  cleanTag,
  cleanTags,
  defaultPermissions,
  RECORDING_NOTE_MAX,
  RECORDING_TAG_MAX,
  RECORDING_TAGS_MAX,
  type Permission,
  type RecordingRecord,
  type RecordingTagCount,
} from '@dji/protocol'
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
let app: Awaited<ReturnType<typeof buildServer>>
const ids: Record<string, string> = {}

const SCREENS: Permission[] = ['recs.view', 'map.view', 'fleet.view']

async function account(
  name: string,
  role: string,
  access?: {
    permissions?: Permission[]
    dronePermissions?: Record<string, Permission[]>
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

async function call(name: string, method: 'GET' | 'PATCH', url: string, payload?: unknown) {
  const token = await issueSession(publicUser((await store.findUserById(ids[name]!))!), store)
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown> | undefined,
  })
}

async function clip(
  sn: string | null,
  extra: { source?: 'drone' | 'upload'; title?: string; tenantId?: string } = {},
): Promise<string> {
  const id = randomUUID()
  await store.recordings.insert({
    id,
    sessionId: randomUUID(),
    deviceSn: sn,
    mode: 'manual',
    source: extra.source ?? 'drone',
    title: extra.title ?? null,
    tenantId: extra.tenantId ?? null,
    file: `${sn ?? 'upload'}/${id}.mp4`,
    startedAt: new Date('2026-11-20T10:00:00Z'),
    endedAt: new Date('2026-11-20T10:10:00Z'),
    durationS: 600,
    sizeBytes: 1000,
    operatorEmail: 'test@example.com',
  })
  return id
}

const ids2: Record<string, string> = {}

before(async () => {
  await migrate(db)
  await account('developer', 'developer')
  await account('admin', 'admin')
  await account('other', 'admin')
  // May watch only.
  await account('viewer', 'subadmin', {
    adminOf: 'admin',
    permissions: SCREENS,
    dronePermissions: {
      alpha: ['drones.view', 'recordings.view'],
      bravo: ['drones.view', 'recordings.view'],
    },
  })
  // May record on alpha only.
  await account('recorder', 'subadmin', {
    adminOf: 'admin',
    permissions: SCREENS,
    dronePermissions: {
      alpha: ['drones.view', 'recordings.view', 'recordings.record'],
      bravo: ['drones.view', 'recordings.view'],
    },
  })
  // May upload, nothing else about recordings.
  await account('uploader', 'subadmin', {
    adminOf: 'admin',
    permissions: [...SCREENS, 'recordings.upload'],
    dronePermissions: { alpha: ['drones.view', 'recordings.view'] },
  })
  for (const sn of ['alpha', 'bravo']) await device(sn)
  await registry.init()
  app = await buildServer({ store, hub, registry, bridge, whep, manager, authorizer })
  await app.ready()
  ids2.alpha1 = await clip('alpha')
  ids2.alpha2 = await clip('alpha')
  ids2.bravo1 = await clip('bravo')
  ids2.upload = await clip(null, { source: 'upload', title: 'Border survey', tenantId: ids.admin })
})
after(async () => {
  manager.dispose()
  await app.close()
  await db.close()
})

test('tags and notes are cleaned the same way for everyone', () => {
  assert.equal(cleanTag('  #Night   patrol  '), 'Night patrol')
  assert.equal(cleanTag('a,b;c'), 'a b c')
  assert.equal(cleanTag('###'), null)
  assert.equal(cleanTag('   '), null)
  assert.equal(cleanTag('x'.repeat(100))?.length, RECORDING_TAG_MAX)
  assert.equal(cleanTag('রাতের টহল'), 'রাতের টহল', 'any language')
  assert.deepEqual(cleanTags(['Flood', 'flood', ' #FLOOD ', 'Bridge', '', 'bridge ']), [
    'Flood',
    'Bridge',
  ])
  assert.equal(cleanTags(Array.from({ length: 60 }, (_, i) => `t${i}`)).length, RECORDING_TAGS_MAX)
  assert.equal(cleanNote('  \r\nfirst\r\n\r\nsecond\u0000 \n'), 'first\n\nsecond')
  assert.equal(cleanNote('   '), null)
  assert.equal(cleanNote(null), null)
  assert.equal(cleanNote('n'.repeat(5000))?.length, RECORDING_NOTE_MAX)
})

test('whoever may record on a drone tags and notes its videos; the answer carries them', async () => {
  const res = await call('admin', 'PATCH', `/api/recordings/${ids2.alpha1}`, {
    tags: ['Flood', ' #bridge ', 'flood'],
    note: 'Water over the bridge at 10:04.\nCheck with the district office.',
  })
  assert.equal(res.statusCode, 200, res.body)
  const rec = res.json().recording as RecordingRecord
  assert.deepEqual(rec.tags, ['Flood', 'bridge'])
  assert.equal(rec.note, 'Water over the bridge at 10:04.\nCheck with the district office.')

  // It comes back with the list and the single video.
  const listed = (await call('admin', 'GET', '/api/recordings')).json()
    .recordings as RecordingRecord[]
  const again = listed.find((r) => r.id === ids2.alpha1)!
  assert.deepEqual(again.tags, ['Flood', 'bridge'])
  assert.equal(
    (await call('admin', 'GET', `/api/recordings/${ids2.alpha1}`)).json().recording.note,
    rec.note,
  )
  // An untouched video has none.
  assert.deepEqual(listed.find((r) => r.id === ids2.alpha2)!.tags, [])
  assert.equal(listed.find((r) => r.id === ids2.alpha2)!.note, null)

  // Only what is sent changes: a note alone leaves the tags; an empty note clears it; tags replace the list.
  const noteOnly = await call('admin', 'PATCH', `/api/recordings/${ids2.alpha1}`, { note: null })
  assert.equal(noteOnly.json().recording.note, null)
  assert.deepEqual(noteOnly.json().recording.tags, ['Flood', 'bridge'])
  const replaced = await call('admin', 'PATCH', `/api/recordings/${ids2.alpha1}`, {
    tags: ['Flood'],
  })
  assert.deepEqual(replaced.json().recording.tags, ['Flood'])
  const cleared = await call('admin', 'PATCH', `/api/recordings/${ids2.alpha1}`, { tags: [] })
  assert.deepEqual(cleared.json().recording.tags, [])
  await call('admin', 'PATCH', `/api/recordings/${ids2.alpha1}`, {
    tags: ['Flood', 'bridge'],
    note: 'Water over the bridge',
  })

  // Bad input.
  assert.equal((await call('admin', 'PATCH', `/api/recordings/${ids2.alpha1}`, {})).statusCode, 400)
  assert.equal(
    (await call('admin', 'PATCH', `/api/recordings/${ids2.alpha1}`, { tags: 'flood' })).statusCode,
    400,
  )
  assert.equal(
    (
      await call('admin', 'PATCH', `/api/recordings/${ids2.alpha1}`, {
        tags: Array.from({ length: 41 }, (_, i) => `t${i}`),
      })
    ).statusCode,
    400,
  )
  assert.equal(
    (await call('admin', 'PATCH', '/api/recordings/not-an-id', { note: 'x' })).statusCode,
    404,
  )
  assert.equal(
    (await call('admin', 'PATCH', `/api/recordings/${randomUUID()}`, { note: 'x' })).statusCode,
    404,
  )
})

test('watching is not enough to change a label, and a drone you cannot record on stays untouched', async () => {
  const body = { tags: ['mine'] }
  assert.equal(
    (await call('viewer', 'PATCH', `/api/recordings/${ids2.alpha2}`, body)).statusCode,
    403,
  )
  // May record on alpha: yes; on bravo: no.
  assert.equal(
    (await call('recorder', 'PATCH', `/api/recordings/${ids2.alpha2}`, { tags: ['seen'] }))
      .statusCode,
    200,
  )
  assert.equal(
    (await call('recorder', 'PATCH', `/api/recordings/${ids2.bravo1}`, body)).statusCode,
    403,
  )
  // The viewer still reads what the recorder wrote.
  const read = (await call('viewer', 'GET', `/api/recordings/${ids2.alpha2}`)).json().recording
  assert.deepEqual(read.tags, ['seen'])
  // A drone the account cannot even see is not there for it.
  await account('scopedout', 'subadmin', {
    adminOf: 'admin',
    permissions: SCREENS,
    dronePermissions: { alpha: ['drones.view', 'recordings.view', 'recordings.record'] },
  })
  assert.equal(
    (await call('scopedout', 'PATCH', `/api/recordings/${ids2.bravo1}`, body)).statusCode,
    403,
  )
})

test('an upload is labelled by whoever may upload, and only inside its own customer', async () => {
  assert.equal(
    (
      await call('uploader', 'PATCH', `/api/recordings/${ids2.upload}`, {
        tags: ['survey'],
        note: 'north border',
      })
    ).statusCode,
    200,
  )
  // Without the upload right (a viewer) it is refused.
  assert.equal(
    (await call('viewer', 'PATCH', `/api/recordings/${ids2.upload}`, { tags: ['x'] })).statusCode,
    403,
  )
  // Another customer's Admin cannot see it at all.
  assert.equal(
    (await call('other', 'PATCH', `/api/recordings/${ids2.upload}`, { tags: ['x'] })).statusCode,
    404,
  )
  assert.equal((await call('other', 'GET', `/api/recordings/${ids2.upload}`)).statusCode, 404)
})

test('search finds a video by its tag or its note, and the tag filter is exact', async () => {
  const found = async (query: string) =>
    (
      (await call('admin', 'GET', `/api/recordings?${query}`)).json()
        .recordings as RecordingRecord[]
    )
      .map((r) => r.id)
      .sort()
  const alpha1 = ids2.alpha1!
  // By a tag, whatever the case or a part of it.
  assert.deepEqual(await found('q=flood'), [alpha1])
  assert.deepEqual(await found('q=FLO'), [alpha1])
  // By a word in the note.
  assert.deepEqual(await found('q=bridge'), [alpha1])
  assert.deepEqual(await found('q=Water%20over'), [alpha1])
  // By a tag on an upload, and by its title as before.
  assert.deepEqual(await found('q=survey'), [ids2.upload])
  assert.deepEqual(await found('q=north'), [ids2.upload])
  assert.deepEqual(await found('q=nothing-like-this'), [])
  // The percent sign and underscore are text, not wildcards.
  assert.deepEqual(await found('q=%25'), [])

  // The tag filter matches the whole tag, any case, and combines with the rest.
  assert.deepEqual(await found('tag=flood'), [alpha1])
  assert.deepEqual(await found('tag=FLOOD'), [alpha1])
  assert.deepEqual(await found('tag=flo'), [])
  assert.deepEqual(await found('tag=seen'), [ids2.alpha2])
  assert.deepEqual(await found('tag=flood&deviceSn=bravo'), [])
  assert.deepEqual(await found('tag=flood&source=upload'), [])
})

test('the tags in use are counted for the videos an account may see, one tag in any case', async () => {
  // A second video with the same tag in another case.
  await call('admin', 'PATCH', `/api/recordings/${ids2.bravo1}`, { tags: ['FLOOD', 'drill'] })
  const tags = (await call('admin', 'GET', '/api/recordings/tags')).json()
    .tags as RecordingTagCount[]
  const flood = tags.find((t) => t.name.toLowerCase() === 'flood')!
  assert.equal(flood.count, 2)
  assert.ok(tags.some((t) => t.name === 'drill' && t.count === 1))
  assert.ok(tags.some((t) => t.name === 'survey'))
  // The most used first.
  assert.equal(tags[0]!.name.toLowerCase(), 'flood')

  // An account that may see only alpha does not learn the tags of bravo's videos.
  const scoped = (await call('scopedout', 'GET', '/api/recordings/tags')).json()
    .tags as RecordingTagCount[]
  assert.ok(!scoped.some((t) => t.name === 'drill'))
  assert.equal(scoped.find((t) => t.name.toLowerCase() === 'flood')!.count, 1)
  // Another customer's upload tags stay private to that customer.
  const other = (await call('other', 'GET', '/api/recordings/tags')).json()
    .tags as RecordingTagCount[]
  assert.ok(!other.some((t) => t.name === 'survey'))
  assert.ok(tags.some((t) => t.name === 'survey'))
})
