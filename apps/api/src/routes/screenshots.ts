import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { can } from '@dji/protocol'
import type {
  Access,
  PeopleCount,
  PeopleCountResponse,
  PeopleDetection,
  PeopleMark,
  ScreenshotRecord,
} from '@dji/protocol'
import { z } from 'zod'
import { config } from '../config'
import type { RouteContext } from '../http/context'
import { PeopleDetector } from '../people/detector'
import { iso, type PeopleRow, type ScreenshotRow } from '../store'
import { ensureThumb, thumbPath } from '../screenshots/thumbs'

const SAFE_KEY = /^[A-Za-z0-9_.-]+$/
const MISSION_ID = /^[A-Za-z0-9_-]{1,64}$/
// A client capture time further than this from the server clock is replaced by the
// server's receive time.
const MAX_CLOCK_SKEW_MS = 5 * 60_000
// Location comes from the newest fix no older than this.
const POSITION_MAX_AGE_MS = 2 * 60_000
// Upper bound on marks in one verified count; far beyond any still a feed produces.
const MAX_PEOPLE_MARKS = 5000

interface ImageInfo {
  contentType: 'image/jpeg' | 'image/png'
  ext: 'jpg' | 'png'
  width: number | null
  height: number | null
}

/**
 * Identify the image from its bytes rather than the declared content type, and read its
 * dimensions. Returns null for anything that is not a well-formed JPEG or PNG header.
 */
export function sniffImage(data: Buffer): ImageInfo | null {
  if (
    data.length > 24 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    data.subarray(12, 16).toString('ascii') === 'IHDR'
  ) {
    return {
      contentType: 'image/png',
      ext: 'png',
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    }
  }

  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    // Walk the marker segments to the first start-of-frame for the dimensions.
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) return null
      const marker = data[offset + 1] ?? 0
      const length = data.readUInt16BE(offset + 2)
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
      if (isSof) {
        return {
          contentType: 'image/jpeg',
          ext: 'jpg',
          height: data.readUInt16BE(offset + 5),
          width: data.readUInt16BE(offset + 7),
        }
      }
      if (length < 2) return null
      offset += 2 + length
    }
    return null
  }

  return null
}

/** `YYYYMMDD` and `HHMMSS` in the configured operator time zone. */
function stampParts(date: Date): { day: string; time: string } {
  const parts = Object.fromEntries(
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
      .map((part) => [part.type, part.value]),
  )
  return {
    day: `${parts.year}${parts.month}${parts.day}`,
    time: `${parts.hour}${parts.minute}${parts.second}`,
  }
}

function toRecord(row: ScreenshotRow): ScreenshotRecord {
  return {
    id: row.id,
    deviceSn: row.device_sn,
    deviceLabel: row.device_label,
    missionId: row.mission_id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    width: row.width,
    height: row.height,
    capturedAt: iso(row.captured_at) ?? '',
    operatorId: row.operator_id,
    operatorEmail: row.operator_email,
    lat: row.lat,
    lon: row.lon,
    altRel: row.alt_rel,
    people:
      row.people_ai_count === null
        ? null
        : { aiCount: row.people_ai_count, verifiedCount: row.people_verified_count },
  }
}

function toPeople(row: PeopleRow): PeopleCount {
  return {
    screenshotId: row.screenshot_id,
    stage: row.stage === 'quick' ? 'quick' : 'thorough',
    model: row.model,
    aiCount: row.ai_count,
    detections: (row.detections ?? []) as PeopleDetection[],
    durationMs: row.duration_ms,
    analyzedAt: iso(row.analyzed_at) ?? '',
    analyzedBy: row.analyzed_by_email,
    verifiedCount: row.verified_count,
    marks: (row.marks ?? null) as PeopleMark[] | null,
    verifiedAt: iso(row.verified_at),
    verifiedBy: row.verified_by_email,
  }
}

function storagePath(key: string): string | null {
  if (!SAFE_KEY.test(key)) return null
  const root = path.resolve(config.screenshotDir)
  const file = path.resolve(root, key)
  return file.startsWith(root + path.sep) ? file : null
}

export function registerScreenshotRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, requireOperator } = ctx
  const common = {
    minScore: config.peopleMinScore,
    threads: config.peopleThreads,
  }
  // The quick model answers in a couple of seconds; the thorough one then refines the result.
  const quick = new PeopleDetector({
    ...common,
    modelPath: config.peopleQuickModelPath,
    countScore: config.peopleQuickCountScore,
    fineTile: config.peopleQuickTile,
    priority: 0,
  })
  const thorough = new PeopleDetector({
    ...common,
    modelPath: config.peopleModelPath,
    countScore: config.peopleCountScore,
    priority: 1,
  })

  // Warm both models shortly after boot, quick first, once the API is serving.
  setTimeout(() => {
    void quick
      .warm()
      .then(() => thorough.warm())
      .catch((error: unknown) => app.log.warn({ err: error }, 'people model warm-up failed'))
  }, 5000).unref()

  /** Counting works when at least one of the two models is installed. */
  async function countingAvailable(): Promise<boolean> {
    return (await thorough.available()) || (await quick.available())
  }

  // One count per still at a time. A request that arrives while the capture's own count is
  // running joins it instead of queueing the same work again.
  type CountOutcome = { ok: true } | { ok: false; code: number; error: string }
  interface CountJob {
    /** Settles when the first result is stored: the quick one, or the thorough if no quick. */
    first: Promise<CountOutcome>
    /** Settles when the thorough result is stored too. */
    done: Promise<CountOutcome>
  }
  const jobs = new Map<string, CountJob>()

  function startCount(row: ScreenshotRow, userId: string | null, force: boolean): CountJob {
    const running = jobs.get(row.id)
    if (running) return running

    let firstDone: (outcome: CountOutcome) => void = () => undefined
    const first = new Promise<CountOutcome>((resolve) => (firstDone = resolve))

    const store1 = async (
      stage: 'quick' | 'thorough',
      detector: PeopleDetector,
      image: Buffer,
    ): Promise<CountOutcome> => {
      try {
        const result = await detector.detect(image)
        // Deleted while the model was working: there is nothing left to attach the count to.
        if (!(await store.getScreenshot(row.id)))
          return { ok: false, code: 404, error: 'screenshot deleted' }
        const counted = result.detections.filter((detection) => detection.counted).length
        await store.savePeopleAnalysis({
          screenshotId: row.id,
          stage,
          model: result.model,
          aiCount: counted,
          detections: result.detections,
          durationMs: result.durationMs,
          analyzedBy: userId,
          replaceVerified: force,
        })
        app.log.info(
          {
            screenshot: row.id,
            stage,
            people: counted,
            possible: result.detections.length - counted,
            passes: result.passes,
            ms: result.durationMs,
          },
          'people counted',
        )
        return { ok: true }
      } catch (error) {
        app.log.error({ err: error, stage }, 'people count failed')
        return { ok: false, code: 500, error: 'people counting failed' }
      }
    }

    const done = (async (): Promise<CountOutcome> => {
      const file = storagePath(row.storage_key)
      const image = file ? await readFile(file).catch(() => null) : null
      if (!image) {
        const missing: CountOutcome = { ok: false, code: 404, error: 'image file missing' }
        firstDone(missing)
        return missing
      }
      let outcome: CountOutcome = { ok: true }
      let answered = false
      if (await quick.available()) {
        outcome = await store1('quick', quick, image)
        firstDone(outcome)
        answered = outcome.ok
      }
      if (await thorough.available()) {
        const refined = await store1('thorough', thorough, image)
        if (!answered) firstDone(refined)
        outcome = refined.ok || !answered ? refined : outcome
      } else if (!answered) {
        firstDone({ ok: false, code: 503, error: 'no people-counting model is installed' })
      }
      return outcome
    })().finally(() => jobs.delete(row.id))

    const job: CountJob = { first, done }
    jobs.set(row.id, job)
    return job
  }

  // Scoped so the raw-image body parser only applies to the upload route.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      ['image/jpeg', 'image/png'],
      { parseAs: 'buffer', bodyLimit: config.screenshotMaxBytes },
      (_req, body, done) => done(null, body),
    )

    scope.post(
      '/api/devices/:sn/screenshots',
      {
        preHandler: requireOperator,
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        const params = z
          .object({ sn: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
          .safeParse(req.params)
        const query = z
          .object({
            capturedAt: z.string().datetime({ offset: true }).optional(),
            missionId: z.string().regex(MISSION_ID).optional(),
          })
          .safeParse(req.query)
        if (!params.success || !query.success) {
          return reply.code(400).send({ error: 'invalid request' })
        }

        const body = req.body
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return reply.code(400).send({ error: 'expected an image/jpeg or image/png body' })
        }
        const image = sniffImage(body)
        if (!image) return reply.code(415).send({ error: 'not a JPEG or PNG image' })

        const sn = params.data.sn
        if (!(await store.deviceExists(sn))) {
          return reply.code(404).send({ error: 'unknown device' })
        }

        const now = Date.now()
        const claimed = query.data.capturedAt ? Date.parse(query.data.capturedAt) : NaN
        const capturedAt = new Date(
          Number.isFinite(claimed) && Math.abs(claimed - now) <= MAX_CLOCK_SKEW_MS ? claimed : now,
        )

        const [label, position] = await Promise.all([
          store.deviceLabel(sn),
          store.latestPosition(sn, new Date(now - POSITION_MAX_AGE_MS).toISOString()),
        ])

        // <BRAND_FILE_PREFIX>_<serial>_<YYYYMMDD>_<HHMMSS>.<ext>; a second capture in the same
        // second gets _2, _3 … The exclusive create makes the name check atomic.
        const { day, time } = stampParts(capturedAt)
        const base = `${config.brand.filePrefix}_${sn}_${day}_${time}`
        await mkdir(config.screenshotDir, { recursive: true })

        let filename: string | null = null
        for (let attempt = 1; attempt <= 100 && !filename; attempt += 1) {
          const candidate = `${base}${attempt > 1 ? `_${attempt}` : ''}.${image.ext}`
          const file = storagePath(candidate)
          if (!file) break
          try {
            await writeFile(file, body, { flag: 'wx' })
            filename = candidate
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
              req.log.error({ err: error }, 'screenshot write failed')
              return reply.code(500).send({ error: 'could not store the image' })
            }
          }
        }
        if (!filename) return reply.code(500).send({ error: 'could not allocate a file name' })

        const id = randomUUID()
        try {
          await store.insertScreenshot({
            id,
            deviceSn: sn,
            deviceLabel: label,
            missionId: query.data.missionId ?? null,
            filename,
            storageKey: filename,
            contentType: image.contentType,
            sizeBytes: body.length,
            width: image.width,
            height: image.height,
            capturedAt: capturedAt.toISOString(),
            operatorId: req.user?.id ?? null,
            lat: position?.lat ?? null,
            lon: position?.lon ?? null,
            altRel: position?.alt_rel ?? null,
          })
        } catch (error) {
          req.log.error({ err: error }, 'screenshot metadata insert failed')
          const file = storagePath(filename)
          if (file) await unlink(file).catch(() => undefined)
          return reply.code(500).send({ error: 'could not record the screenshot' })
        }

        const row = await store.getScreenshot(id)
        if (!row) return reply.code(500).send({ error: 'could not read back the screenshot' })

        // The gallery's small copy is made now, in the background, so it is ready when the gallery is opened.
        const stored = storagePath(filename)
        if (stored) void ensureThumb(stored, thumbPath(config.screenshotDir, id))

        // Count in the background; the operator is not kept waiting for it.
        if (config.peopleAutoCount && jobs.size < config.peopleAutoMaxQueue) {
          void countingAvailable()
            .then((ready) => {
              if (ready) void startCount(row, req.user?.id ?? null, false).done
            })
            .catch((error: unknown) => req.log.warn({ err: error }, 'automatic count not started'))
        }
        return reply.code(201).send({ screenshot: toRecord(row) })
      },
    )
  })

  app.get('/api/screenshots', { preHandler: requireOperator }, async (req, reply) => {
    const query = z
      .object({
        deviceSn: z.string().min(1).max(64).optional(),
        missionId: z.string().regex(MISSION_ID).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        before: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(48),
      })
      .safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid request' })

    const rows = await store.listScreenshots({
      allowedSns:
        req.user!.role === 'developer' ||
        (req.user!.allDrones &&
          req.user!.permissions.includes('screenshots.view') &&
          req.user!.permissions.includes('drones.view'))
          ? undefined
          : Object.keys(req.user!.dronePermissions).filter((sn) =>
              can(req.user!, 'screenshots.view', sn),
            ),
      deviceSn: query.data.deviceSn,
      missionId: query.data.missionId,
      fromIso: query.data.from,
      toIso: query.data.to,
      beforeIso: query.data.before,
      limit: query.data.limit,
    })
    return { screenshots: rows.map(toRecord) }
  })

  app.get('/api/screenshots/:id', { preHandler: requireOperator }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    const row = await store.getScreenshot(params.data.id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    return { screenshot: toRecord(row) }
  })

  // The gallery's small copy of a still (see `screenshots/thumbs.ts`). The same rights as the picture itself apply, through
  // the access table. Where it cannot be made (a damaged file) the answer is 404 and the screen falls back to the picture.
  app.get('/api/screenshots/:id/thumbnail', { preHandler: requireOperator }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid request' })
    const row = await store.getScreenshot(params.data.id)
    const file = row ? storagePath(row.storage_key) : null
    if (!row || !file) return reply.code(404).send({ error: 'not found' })
    const thumb = thumbPath(config.screenshotDir, row.id)
    if (!(await ensureThumb(file, thumb))) return reply.code(404).send({ error: 'no thumbnail' })
    const info = await stat(thumb).catch(() => null)
    if (!info?.isFile()) return reply.code(404).send({ error: 'no thumbnail' })
    return (
      reply
        .header('content-type', 'image/jpeg')
        .header('content-length', info.size)
        // A still never changes, so its small copy may be kept for a while; the full picture below is never cached.
        .header('cache-control', 'private, max-age=3600')
        .header('x-content-type-options', 'nosniff')
        .send(createReadStream(thumb))
    )
  })

  app.get('/api/screenshots/:id/image', { preHandler: requireOperator }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    const query = z.object({ download: z.enum(['0', '1']).optional() }).safeParse(req.query)
    if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid request' })

    const row = await store.getScreenshot(params.data.id)
    const file = row ? storagePath(row.storage_key) : null
    if (!row || !file) return reply.code(404).send({ error: 'not found' })

    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) return reply.code(404).send({ error: 'image file missing' })

    const disposition = query.data.download === '1' ? 'attachment' : 'inline'
    return reply
      .header('content-type', row.content_type)
      .header('content-length', info.size)
      .header('content-disposition', `${disposition}; filename="${row.filename}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(file))
  })

  // People counting. Reading a count, or asking the model for one, needs screenshots.view on
  // the aircraft; saving the operator-checked count needs screenshots.capture. A still the
  // account may not see is reported as missing.
  async function peopleResponse(row: ScreenshotRow, user: Access): Promise<PeopleCountResponse> {
    const people = await store.getPeople(row.id)
    return {
      available: await countingAvailable(),
      canVerify: can(user, 'screenshots.capture', row.device_sn),
      counting: jobs.has(row.id),
      people: people ? toPeople(people) : null,
    }
  }

  async function visibleShot(id: unknown, user: Access): Promise<ScreenshotRow | null> {
    const params = z.object({ id: z.string().uuid() }).safeParse(id)
    if (!params.success) return null
    const row = await store.getScreenshot(params.data.id)
    return row && can(user, 'screenshots.view', row.device_sn) ? row : null
  }

  /**
   * Deletes stills for good: the row, its people count and the file. Allowed only for a still
   * the account may see and has `screenshots.delete` on. The audit log keeps who and which file.
   */
  async function removeShots(rows: ScreenshotRow[], by: string): Promise<number> {
    const removed = await store.deleteScreenshots(rows.map((row) => row.id))
    for (const shot of removed) {
      await unlink(thumbPath(config.screenshotDir, shot.id)).catch(() => undefined)
      const file = storagePath(shot.storage_key)
      if (file)
        await unlink(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') app.log.error({ err: error }, 'screenshot file not removed')
        })
      await store
        .logDeviceEvent(shot.device_sn, 'screenshot.deleted', { by, filename: shot.filename })
        .catch(() => undefined)
    }
    return removed.length
  }

  const mayDelete = (user: Access, row: ScreenshotRow): boolean =>
    can(user, 'screenshots.view', row.device_sn) && can(user, 'screenshots.delete', row.device_sn)

  app.delete('/api/screenshots/:id', { preHandler: requireOperator }, async (req, reply) => {
    const row = await visibleShot(req.params, req.user!)
    if (!row || !mayDelete(req.user!, row)) return reply.code(404).send({ error: 'not found' })
    await removeShots([row], req.user!.email)
    return reply.code(204).send()
  })

  app.post('/api/screenshots/delete', { preHandler: requireOperator }, async (req, reply) => {
    const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid request' })
    const rows: ScreenshotRow[] = []
    for (const id of new Set(body.data.ids)) {
      const row = await store.getScreenshot(id)
      if (row && mayDelete(req.user!, row)) rows.push(row)
    }
    const deleted = await removeShots(rows, req.user!.email)
    return { deleted, skipped: new Set(body.data.ids).size - deleted }
  })

  app.get('/api/screenshots/:id/people', { preHandler: requireOperator }, async (req, reply) => {
    const row = await visibleShot(req.params, req.user!)
    if (!row) return reply.code(404).send({ error: 'not found' })
    return peopleResponse(row, req.user!)
  })

  app.post(
    '/api/screenshots/:id/people',
    {
      preHandler: requireOperator,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const row = await visibleShot(req.params, req.user!)
      if (!row) return reply.code(404).send({ error: 'not found' })
      if (!(await countingAvailable())) {
        return reply.code(503).send({
          error: 'The people-counting model is not installed on the server (pnpm models:fetch).',
        })
      }

      // "Count again": an operator asked, so any earlier verification is replaced. The reply
      // comes with the first result (about two seconds); the thorough scan finishes after.
      const outcome = await startCount(row, req.user?.id ?? null, true).first
      if (!outcome.ok) return reply.code(outcome.code).send({ error: outcome.error })
      return peopleResponse(row, req.user!)
    },
  )

  app.put(
    '/api/screenshots/:id/people/verification',
    { preHandler: requireOperator },
    async (req, reply) => {
      const row = await visibleShot(req.params, req.user!)
      if (!row) return reply.code(404).send({ error: 'not found' })
      if (!can(req.user!, 'screenshots.capture', row.device_sn)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
      const body = z
        .object({
          marks: z
            .array(
              z.object({
                x: z.number().min(0).max(1),
                y: z.number().min(0).max(1),
                source: z.enum(['ai', 'manual']),
              }),
            )
            .max(MAX_PEOPLE_MARKS),
        })
        .safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: 'invalid request' })

      const marks = body.data.marks.map((mark) => ({
        x: Number(mark.x.toFixed(5)),
        y: Number(mark.y.toFixed(5)),
        source: mark.source,
      }))
      if (!(await store.savePeopleVerification(row.id, marks, req.user?.id ?? null))) {
        return reply.code(409).send({ error: 'run the people count before verifying it' })
      }
      return peopleResponse(row, req.user!)
    },
  )
}
