import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  can,
  cleanNote,
  cleanTags,
  FOLDER_NAME_MAX,
  RECORDING_SORTS,
  recordingAnnotationSchema,
  VIDEO_TITLE_MAX,
  type RecordingAutoDrone,
  type RecordingLocation,
  type RecordingMode,
  type RecordingRecord,
} from '@dji/protocol'
import type { CurrentUser } from '../auth'
import { config } from '../config'
import { noteAudit } from '../http/audit'
import type { RouteContext } from '../http/context'
import { readableSns } from '../http/scope'
import { cleanName, UploadError } from '../recordings/library'
import { PlaceError } from '../recordings/place'
import { RecorderError, SAFE_SN } from '../recordings/recorder'
import type { RecordingRow, RecordingScope } from '../recordings/store'

const iso = (value: Date | string): string => new Date(value).toISOString()

/** The file name with nothing in it a file system or a browser would mind. */
function fileSafe(text: string): string {
  return text
    .replace(/[\p{Cc}/\\:*?"<>|]/gu, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
}

/** `2026-11-18_10-57-36` in the installation's own time zone: the date and time people read on the screen. */
function localStamp(date: Date): string {
  const part = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: config.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  )
  return `${part.year}-${part.month}-${part.day}_${part.hour}-${part.minute}-${part.second}`
}

/**
 * What a download is called. A recorded clip: `<brand>_<drone name>_<date>_<time>.mp4`, the drone's
 * name as the dashboard shows it and the time the clip began, so a file copied off the server says
 * what it is. An upload: the name its uploader gave it.
 */
function downloadName(row: RecordingRow): string {
  if (row.source === 'upload')
    return `${fileSafe(row.title ?? 'video') || 'video'}${path.extname(row.file) || '.mp4'}`
  const drone = fileSafe(row.device_label ?? row.device_sn ?? 'drone') || 'drone'
  return `${config.brand.filePrefix}_${drone}_${localStamp(new Date(row.started_at))}.mp4`
}

/** A name with any letters in it: the ASCII form for old clients, the real one (RFC 5987) for the rest. */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function toRecord(row: RecordingRow): RecordingRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source === 'upload' ? 'upload' : 'drone',
    deviceSn: row.device_sn,
    deviceName: row.device_label,
    mode: row.source === 'upload' ? null : (row.mode as RecordingMode),
    title: row.title,
    folder: row.folder,
    state: row.state === 'processing' || row.state === 'failed' ? row.state : 'ready',
    error: row.error,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    durationS: row.duration_s,
    sizeBytes: row.size_bytes,
    startedBy: row.operator_email,
    tags: row.tags ?? [],
    note: row.note,
    filename: downloadName(row),
  }
}

/** What this account may see of the archive: its drones' clips, and its own customer's uploads. */
function scopeFor(user: CurrentUser): RecordingScope {
  return {
    allowedSns: readableSns(user, 'recordings.view'),
    // A Developer sees every customer's; everyone else only the uploads of their own Admin's team.
    tenantId: user.role === 'developer' ? undefined : (user.adminId ?? user.id),
  }
}

/**
 * `Range: bytes=a-b`, `bytes=a-` or `bytes=-n`. A browser seeks in a video by asking for the part it
 * needs, so without this a clip would have to download whole before it could be scrubbed.
 * Returns null when there is no header, 'invalid' when it cannot be satisfied.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    const last = Number(m[2])
    if (last === 0) return 'invalid'
    start = Math.max(0, size - last)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'invalid'
  return { start, end }
}

export function registerRecordingRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, recorder, library, janitor, place, requireOperator } = ctx
  const root = (): string => path.resolve(recorder?.directory ?? config.recordings.dir)

  /** A video's file inside the recordings folder, or null for a path that would leave it. */
  function filePath(row: RecordingRow): string | null {
    // Named relative to the main folder; the library also looks in the folders used before it.
    if (library) return library.resolve(row.file)
    const base = root()
    const file = path.resolve(base, row.file)
    return file.startsWith(base + path.sep) ? file : null
  }

  const gigabytes = (bytes: number): string => `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`

  app.post('/api/devices/:sn/recording', { preHandler: requireOperator }, async (req, reply) => {
    const params = z.object({ sn: z.string().regex(SAFE_SN) }).safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    if (!recorder) return reply.code(503).send({ error: 'recording is not available' })

    const device = await store.deviceForStream(params.data.sn)
    if (!device) return reply.code(404).send({ error: 'not found' })
    if (!device.online) return reply.code(409).send({ error: 'The drone is offline.' })
    try {
      const recording = await recorder.start(params.data.sn, { email: req.user!.email })
      return { recording }
    } catch (error) {
      if (error instanceof RecorderError && error.code === 'busy')
        return reply.code(429).send({ error: 'Too many recordings are running at once.' })
      throw error
    }
  })

  app.delete('/api/devices/:sn/recording', { preHandler: requireOperator }, async (req, reply) => {
    const params = z.object({ sn: z.string().regex(SAFE_SN) }).safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    if (!recorder) return reply.code(503).send({ error: 'recording is not available' })
    // An automatic recording is not stopped from here: it would start again at once.
    if (recorder.isAuto(params.data.sn))
      return reply.code(409).send({
        error: 'This drone records automatically. Turn automatic recording off for it to stop.',
      })
    await recorder.stop(params.data.sn)
    return reply.code(204).send()
  })

  // Which drones record automatically, for the drones this account may record.
  app.get('/api/recordings/auto', { preHandler: requireOperator }, async (req) => {
    const rows = await store.recordings.autoDevices()
    const names = await store.recordings.deviceNames(rows.map((row) => row.sn))
    const drones: RecordingAutoDrone[] = rows
      .filter((row) => can(req.user!, 'recordings.record', row.sn))
      .map((row) => {
        const enabled = row.auto_record ?? config.recordings.autoDefault
        return {
          deviceSn: row.sn,
          deviceName: names.get(row.sn) ?? null,
          setting: row.auto_record,
          enabled,
          state: !enabled
            ? 'off'
            : recorder?.isPaused
              ? 'paused'
              : (recorder?.stateOf(row.sn) ?? 'waiting'),
          online: row.online,
        }
      })
    return { drones }
  })

  // Record this drone automatically from now on: each time it connects, until it is turned off. The
  // recording is set up at once (it waits for the drone), and again after every restart.
  app.put(
    '/api/devices/:sn/recording/auto',
    { preHandler: requireOperator },
    async (req, reply) => {
      const params = z.object({ sn: z.string().regex(SAFE_SN) }).safeParse(req.params)
      const body = z.object({ enabled: z.boolean().nullable() }).safeParse(req.body)
      if (!params.success || !body.success)
        return reply.code(400).send({ error: 'invalid request' })
      if (!(await store.recordings.setAuto(params.data.sn, body.data.enabled)))
        return reply.code(404).send({ error: 'not found' })
      await store
        .logDeviceEvent(params.data.sn, 'recording.auto', {
          enabled: body.data.enabled,
          by: req.user!.email,
        })
        .catch(() => undefined)
      await recorder?.reconcile()
      return {
        enabled: body.data.enabled ?? config.recordings.autoDefault,
        setting: body.data.enabled,
      }
    },
  )

  // How much the recordings use, how much room is left and the rules that keep the disk from filling.
  app.get('/api/recordings/storage', { preHandler: requireOperator }, async (_req, reply) => {
    if (!janitor) return reply.code(503).send({ error: 'storage information is not available' })
    return janitor.status()
  })

  // ---- Where the videos are kept. A Developer's choice (the access policy refuses everyone else): the
  // vendor installs the server and picks a disk, so no customer account can point it at a path.
  const placeFailure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof PlaceError)
      return reply
        .code(error.code === 'locked' ? 409 : 400)
        .send({ error: error.message, code: error.code })
    throw error
  }

  async function locationNow(): Promise<RecordingLocation> {
    const usage = await store.recordings.usage()
    return {
      dir: place!.dir,
      locked: place!.locked,
      ...(await place!.space()),
      roots: place!.roots,
      older: place!.olderDirs,
      warning: place!.warning,
      clips: usage.clips,
      usedBytes: usage.usedBytes,
    }
  }

  app.get('/api/recordings/location', { preHandler: requireOperator }, async (_req, reply) => {
    if (!place) return reply.code(503).send({ error: 'storage information is not available' })
    return { location: await locationNow() }
  })

  app.get(
    '/api/recordings/location/browse',
    { preHandler: requireOperator },
    async (req, reply) => {
      if (!place) return reply.code(503).send({ error: 'storage information is not available' })
      const query = z.object({ path: z.string().max(400).optional() }).safeParse(req.query)
      if (!query.success) return reply.code(400).send({ error: 'invalid request' })
      try {
        return await place.browse(query.data.path)
      } catch (error) {
        return placeFailure(reply, error)
      }
    },
  )

  app.post(
    '/api/recordings/location/folder',
    { preHandler: requireOperator },
    async (req, reply) => {
      if (!place) return reply.code(503).send({ error: 'storage information is not available' })
      const body = z
        .object({ parent: z.string().max(400), name: z.string().max(200) })
        .safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: 'invalid request' })
      try {
        const made = await place.makeFolder(body.data.parent, body.data.name)
        await store
          .logDeviceEvent(null, 'recording.folder_created', { path: made, by: req.user!.email })
          .catch(() => undefined)
        return reply.code(201).send({ path: made })
      } catch (error) {
        return placeFailure(reply, error)
      }
    },
  )

  app.put('/api/recordings/location', { preHandler: requireOperator }, async (req, reply) => {
    if (!place) return reply.code(503).send({ error: 'storage information is not available' })
    const body = z.object({ dir: z.string().max(400) }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid request' })
    try {
      const { from, to } = await place.set(body.data.dir, req.user!.email)
      if (from !== to) {
        // Recordings close the clip they are writing and carry on in the new folder; the disk watch and
        // the figures follow at once.
        recorder?.relocate()
        void janitor?.run().catch(() => undefined)
        await store
          .logDeviceEvent(null, 'recording.location_changed', { from, to, by: req.user!.email })
          .catch(() => undefined)
        console.log(`[rec] videos folder changed: ${from} -> ${to} (${req.user!.email})`)
      }
      return { location: await locationNow() }
    } catch (error) {
      return placeFailure(reply, error)
    }
  })

  // Recordings in progress, for the drones this account may see.
  app.get('/api/recordings/active', { preHandler: requireOperator }, async (req) => {
    const allowed = readableSns(req.user!, 'recordings.view')
    const running = recorder ? await recorder.active() : []
    return { recordings: running.filter((r) => !allowed || allowed.includes(r.deviceSn)) }
  })

  // The folders uploads are kept in, for the folder picker and the filter.
  app.get('/api/recordings/folders', { preHandler: requireOperator }, async (req) => ({
    folders: await store.recordings.folders(scopeFor(req.user!)),
  }))

  // The tags in use on the videos this account may see, for the filter and the suggestions.
  app.get('/api/recordings/tags', { preHandler: requireOperator }, async (req) => ({
    tags: await store.recordings.tags(scopeFor(req.user!)),
  }))

  app.get('/api/recordings', { preHandler: requireOperator }, async (req, reply) => {
    const query = z
      .object({
        deviceSn: z.string().min(1).max(64).optional(),
        source: z.enum(['drone', 'upload']).optional(),
        folder: z.string().min(1).max(400).optional(),
        q: z.string().min(1).max(200).optional(),
        tag: z.string().min(1).max(100).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        sort: z.enum(RECORDING_SORTS).default('recorded'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid request' })

    const { rows, total } = await store.recordings.list({
      sort: query.data.sort,
      scope: scopeFor(req.user!),
      deviceSn: query.data.deviceSn,
      source: query.data.source,
      folder: query.data.folder,
      q: query.data.q,
      tag: query.data.tag,
      fromIso: query.data.from,
      toIso: query.data.to,
      limit: query.data.limit,
      offset: query.data.offset,
    })
    return { recordings: rows.map(toRecord), total }
  })

  app.get('/api/recordings/:id', { preHandler: requireOperator }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    const row = await store.recordings.get(params.data.id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    return { recording: toRecord(row) }
  })

  /**
   * Who may label a video: whoever may record on its drone, or (for an upload) whoever may upload. A person who may only
   * watch cannot change what the team sees written on it. An upload is only its own customer's.
   */
  function mayAnnotateClip(user: CurrentUser, row: RecordingRow): boolean {
    const allowed =
      can(user, 'recordings.record', row.device_sn ?? undefined) ||
      (row.source === 'upload' && can(user, 'recordings.upload'))
    if (!allowed) return false
    return (
      row.source !== 'upload' ||
      user.role === 'developer' ||
      row.tenant_id === (user.adminId ?? user.id)
    )
  }

  app.patch('/api/recordings/:id', { preHandler: requireOperator }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    const body = recordingAnnotationSchema.safeParse(req.body)
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid request' })
    const row = await store.recordings.get(params.data.id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    if (!mayAnnotateClip(req.user!, row)) return reply.code(403).send({ error: 'forbidden' })

    const tags = body.data.tags === undefined ? undefined : cleanTags(body.data.tags)
    const note = body.data.note === undefined ? undefined : cleanNote(body.data.note)
    const updated = await store.recordings.annotate(row.id, { tags, note })
    if (!updated) return reply.code(404).send({ error: 'not found' })
    // The line says what was done, not the text of a note: that belongs to the video.
    noteAudit(req, {
      details: {
        ...(tags ? { tags } : {}),
        ...(note !== undefined ? { note: note === null ? 'cleared' : 'changed' } : {}),
      },
    })
    return { recording: toRecord(updated) }
  })

  app.get('/api/recordings/:id/video', { preHandler: requireOperator }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    const query = z.object({ download: z.enum(['0', '1']).optional() }).safeParse(req.query)
    if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid request' })

    const row = await store.recordings.get(params.data.id)
    const file = row ? filePath(row) : null
    if (!row || !file) return reply.code(404).send({ error: 'not found' })
    if (row.state !== 'ready')
      return reply.code(409).send({
        error:
          row.state === 'processing'
            ? 'This video is still being made ready.'
            : (row.error ?? 'This video could not be processed.'),
      })
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) return reply.code(404).send({ error: 'video file missing' })

    reply
      .header('content-type', file.endsWith('.webm') ? 'video/webm' : 'video/mp4')
      .header('accept-ranges', 'bytes')
      .header(
        'content-disposition',
        disposition(query.data.download === '1' ? 'attachment' : 'inline', downloadName(row)),
      )
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')

    const range = parseRange(req.headers.range, info.size)
    if (range === 'invalid')
      return reply.code(416).header('content-range', `bytes */${info.size}`).send()
    if (range) {
      return reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
        .header('content-length', range.end - range.start + 1)
        .send(createReadStream(file, { start: range.start, end: range.end }))
    }
    return reply.header('content-length', info.size).send(createReadStream(file))
  })

  // The picture on a grid card.
  app.get('/api/recordings/:id/thumbnail', { preHandler: requireOperator }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    const row = await store.recordings.get(params.data.id)
    if (!row || row.state !== 'ready') return reply.code(404).send({ error: 'not found' })
    const still = library ? await library.thumbnail(row) : null
    if (!still) return reply.code(404).send({ error: 'no thumbnail' })
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'private, max-age=3600')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(still))
  })

  /**
   * Deletes videos for good: the row first (a video nobody can list is better than a listed one whose file is
   * gone), then the file and its thumbnail, and a device event that says who. Returns the rows removed.
   */
  async function removeClips(rows: RecordingRow[], by: string): Promise<RecordingRow[]> {
    const removed: RecordingRow[] = []
    for (const candidate of rows) {
      const row = await store.recordings.remove(candidate.id)
      if (!row) continue
      const file = filePath(row)
      if (file) await Promise.all([rm(file, { force: true }), rm(`${file}.jpg`, { force: true })])
      await store
        .logDeviceEvent(row.device_sn, 'recording.deleted', {
          id: row.id,
          file: row.file,
          title: row.title,
          by,
        })
        .catch(() => undefined)
      removed.push(row)
    }
    return removed
  }

  /** The same rule the access middleware applies to one video: the grant on its drone, and an upload only for its own customer. */
  function mayDeleteClip(user: CurrentUser, row: RecordingRow): boolean {
    if (!can(user, 'recordings.delete', row.device_sn ?? undefined)) return false
    return (
      row.source !== 'upload' ||
      user.role === 'developer' ||
      row.tenant_id === (user.adminId ?? user.id)
    )
  }

  app.delete('/api/recordings/:id', { preHandler: requireOperator }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    const row = await store.recordings.get(params.data.id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    await removeClips([row], req.user!.email)
    return reply.code(204).send()
  })

  // Several at once, ticked on the Recordings screen. Anything the account may not delete (or that is not there) is
  // skipped and counted, never named, so the answer does not confirm that a video exists.
  app.post('/api/recordings/delete', { preHandler: requireOperator }, async (req, reply) => {
    const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid request' })
    const user = req.user!
    const wanted = [...new Set(body.data.ids)]
    const rows: RecordingRow[] = []
    for (const id of wanted) {
      const row = await store.recordings.get(id)
      if (row && mayDeleteClip(user, row)) rows.push(row)
    }
    const removed = await removeClips(rows, user.email)
    // The audit line names what went, because a list of ids would say nothing a year later.
    noteAudit(req, {
      targetType: 'recording',
      targetLabel: `${removed.length} video${removed.length === 1 ? '' : 's'}`,
      details: {
        deleted: removed.slice(0, 50).map((row) => ({
          id: row.id,
          name: row.title ?? row.device_label ?? row.device_sn ?? 'Video',
          file: row.file,
        })),
        count: removed.length,
        skipped: wanted.length - removed.length,
      },
    })
    return { deleted: removed.length, skipped: wanted.length - removed.length }
  })

  // Upload a video file. The body is the file itself, streamed to disk (not a form, so a multi-GB
  // file never sits in memory). The name, folder and drone ride in the query. A folder that does not
  // exist yet is created; the server then makes the file playable in a browser, in the background.
  void app.register(async (scope) => {
    const raw = (
      _req: unknown,
      payload: unknown,
      done: (error: Error | null, body?: unknown) => void,
    ) => done(null, payload)
    scope.addContentTypeParser('application/octet-stream', raw)
    scope.addContentTypeParser(/^video\/.+$/, raw)

    scope.put(
      '/api/recordings/upload',
      {
        preHandler: requireOperator,
        bodyLimit: config.recordings.uploadMaxBytes,
        config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
      },
      async (req, reply) => {
        if (!library) return reply.code(503).send({ error: 'uploading is not available' })
        const query = z
          .object({
            folder: z.string().max(400).optional(),
            title: z.string().max(400).optional(),
            file: z.string().max(400).optional(),
            sn: z.string().regex(SAFE_SN).optional(),
          })
          .safeParse(req.query)
        if (!query.success) return reply.code(400).send({ error: 'invalid request' })

        const folder = cleanName(query.data.folder, FOLDER_NAME_MAX)
        const named = (query.data.file ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '')
        const title =
          cleanName(query.data.title, VIDEO_TITLE_MAX) ??
          cleanName(named, VIDEO_TITLE_MAX) ??
          'Video'
        const sn = query.data.sn ?? null
        if (sn) {
          if (!(await store.deviceExists(sn)))
            return reply.code(404).send({ error: 'unknown drone' })
          if (!can(req.user!, 'drones.view', sn))
            return reply.code(403).send({ error: 'forbidden' })
        }

        const declared = Number(req.headers['content-length'])
        if (Number.isFinite(declared) && declared > library.maxBytes)
          return reply
            .code(413)
            .send({ error: `The file is larger than the limit of ${gigabytes(library.maxBytes)}.` })
        if (Number.isFinite(declared) && !(await library.hasSpaceFor(declared)))
          return reply.code(507).send({ error: 'The server does not have room for this file.' })

        const id = randomUUID()
        try {
          const { file, bytes } = await library.receive(req.body as Readable, id)
          const row = await library.accept({
            id,
            tenantId: req.user!.role === 'developer' ? null : (req.user!.adminId ?? req.user!.id),
            email: req.user!.email,
            folder,
            title,
            deviceSn: sn,
            incomingFile: file,
            bytes,
          })
          await store
            .logDeviceEvent(sn, 'recording.uploaded', {
              id,
              title: row.title,
              folder,
              by: req.user!.email,
            })
            .catch(() => undefined)
          return reply.code(202).send({ recording: toRecord(row) })
        } catch (error) {
          if (error instanceof UploadError) {
            if (error.code === 'too_large')
              return reply.code(413).send({
                error: `The file is larger than the limit of ${gigabytes(library.maxBytes)}.`,
              })
            if (error.code === 'not_video')
              return reply
                .code(415)
                .send({ error: 'This file is not a video the server can read.' })
            return reply.code(400).send({ error: 'The file is empty.' })
          }
          // The sender went away mid-way: nothing to answer, nothing kept.
          if ((error as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE')
            return reply.code(400).send({ error: 'The upload was interrupted.' })
          throw error
        }
      },
    )
  })
}
