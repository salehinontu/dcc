import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Store } from '../store'
import type { RecordingRow } from './store'

/** Folders inside RECORDING_DIR that are not a drone's: no drone serial may use these names. */
export const RESERVED_DIRS = new Set(['library', '_incoming'])

export class UploadError extends Error {
  constructor(
    readonly code: 'too_large' | 'not_video' | 'no_space' | 'empty',
    message?: string,
  ) {
    super(message ?? code)
  }
}

/**
 * A name as a person typed it, kept as is except that it is one line of at most `max` letters
 * with no control characters. Bengali and every other script stay; only the disk name is plain.
 */
export function cleanName(value: string | undefined | null, max: number): string | null {
  const text = (value ?? '')
    .normalize('NFC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return Array.from(text).slice(0, max).join('')
}

/**
 * The same name as a folder or file on disk: letters, digits, `-`, `.` and `_` only, so nothing a
 * person types (`../`, a slash, a drive letter) can reach outside the library. A name with no such
 * letters at all (written in Bengali, say) becomes `<fallback>-<short hash>`, so it still gets a
 * folder of its own. The typed name stays in the database and on the screen.
 */
export function diskName(text: string, fallback: string, max = 60): string {
  const plain = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, max)
    .replace(/[-._]+$/g, '')
  if (plain) return plain
  return `${fallback}-${createHash('sha1').update(text.normalize('NFC')).digest('hex').slice(0, 8)}`
}

export interface VideoProbe {
  durationS: number
  /** The `creation_time` the file carries, when it is a believable date. */
  createdAt: Date | null
  video: { codec: string; pixFmt: string; width: number; height: number } | null
  audio: { codec: string } | null
}

/** A still image reads as a one-frame "video" to ffprobe; it is not one. */
const IMAGE_CODECS = new Set([
  'mjpeg',
  'png',
  'bmp',
  'gif',
  'webp',
  'tiff',
  'jpeg2000',
  'ppm',
  'pgm',
])

interface Run {
  code: number | null
  out: string
  err: string
}

function run(cmd: string, args: string[], opts: { nice?: boolean } = {}): Promise<Run> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child: ChildProcess
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ code: null, out, err: 'could not start' })
      return
    }
    // A conversion must not starve the live streams and the API of the same CPU.
    if (opts.nice && child.pid) {
      try {
        os.setPriority(child.pid, 10)
      } catch {
        /* not allowed here; run at the normal priority */
      }
    }
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
    child.stderr
      ?.setEncoding('utf8')
      .on('data', (chunk: string) => (err = (err + chunk).slice(-2000)))
    child.on('error', () => resolve({ code: null, out, err: err || 'could not start' }))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

/** What ffprobe says about a file, or null when it cannot read it at all. */
export async function probeVideo(ffprobePath: string, file: string): Promise<VideoProbe | null> {
  const result = await run(ffprobePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ])
  if (result.code !== 0) return null
  let data: {
    format?: { duration?: string; tags?: { creation_time?: string } }
    streams?: {
      codec_type?: string
      codec_name?: string
      pix_fmt?: string
      width?: number
      height?: number
      duration?: string
      disposition?: { attached_pic?: number }
    }[]
  }
  try {
    data = JSON.parse(result.out)
  } catch {
    return null
  }
  const streams = Array.isArray(data.streams) ? data.streams : []
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.find((s) => s.codec_type === 'audio')
  const duration = Number(data.format?.duration ?? video?.duration)
  const created = Date.parse(data.format?.tags?.creation_time ?? '')
  const plausible = created > Date.UTC(2000, 0, 1) && created < Date.now() + 24 * 3600_000
  return {
    durationS: Number.isFinite(duration) && duration > 0 ? duration : 0,
    createdAt: plausible ? new Date(created) : null,
    video: video
      ? {
          codec: String(video.codec_name ?? ''),
          pixFmt: String(video.pix_fmt ?? ''),
          width: Number(video.width ?? 0),
          height: Number(video.height ?? 0),
        }
      : null,
    audio: audio ? { codec: String(audio.codec_name ?? '') } : null,
  }
}

/** How a file is made playable in a browser. The cheapest way that works. */
export type Plan =
  { kind: 'mp4'; audio: 'copy' | 'aac' | 'none' } | { kind: 'webm' } | { kind: 'transcode' }

export function planFor(probe: VideoProbe): Plan {
  const video = probe.video!
  const audio = probe.audio?.codec ?? null
  // Chrome and Edge play these as they are: only the container is rewritten.
  if (
    ['vp8', 'vp9', 'av1'].includes(video.codec) &&
    (audio == null || ['opus', 'vorbis'].includes(audio))
  )
    return { kind: 'webm' }
  // H.264 in any container becomes an MP4 by copy (seconds, no quality loss). The picture must be
  // the plain 4:2:0 kind browsers decode; audio that is not AAC is the only part re-encoded.
  if (video.codec === 'h264' && ['yuv420p', 'yuvj420p'].includes(video.pixFmt))
    return { kind: 'mp4', audio: audio == null ? 'none' : audio === 'aac' ? 'copy' : 'aac' }
  // Anything else (H.265, MPEG-4, ProRes, 10-bit...) is converted to H.264. This is the slow one.
  return { kind: 'transcode' }
}

function ffmpegArgs(plan: Plan, input: string, output: string): string[] {
  const head = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input]
  const map = ['-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn']
  if (plan.kind === 'webm') return [...head, ...map, '-c', 'copy', '-f', 'webm', output]
  if (plan.kind === 'mp4') {
    const audio =
      plan.audio === 'copy'
        ? ['-c:a', 'copy']
        : plan.audio === 'aac'
          ? ['-c:a', 'aac', '-b:a', '128k']
          : []
    return [
      ...head,
      ...map,
      '-c:v',
      'copy',
      ...audio,
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      output,
    ]
  }
  return [
    ...head,
    ...map,
    // H.264 4:2:0 needs even sides.
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    output,
  ]
}

/**
 * A still from a video, 480 px wide, written beside it as `<video>.jpg` (made once, then reused).
 * A tenth of the way in, never past 5 s, because the first frame is often black. Returns its path,
 * or null when ffmpeg could not make one: the card then shows a placeholder.
 */
export async function makeStill(
  ffmpegPath: string,
  video: string,
  durationS: number,
): Promise<string | null> {
  const jpg = `${video}.jpg`
  const have = await stat(jpg).catch(() => null)
  if (have?.size) return jpg
  const at = Math.min(Math.max(durationS * 0.1, 0), 5)
  const made = await run(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-ss',
    at.toFixed(2),
    '-i',
    video,
    '-frames:v',
    '1',
    '-vf',
    'scale=480:-2',
    '-q:v',
    '5',
    jpg,
  ])
  const info = made.code === 0 ? await stat(jpg).catch(() => null) : null
  if (info?.size) return jpg
  await rm(jpg, { force: true })
  return null
}

export interface LibraryOptions {
  /** The main folder: uploads live in `library/` and wait in `_incoming/` until they are playable. */
  dir: string
  /** Folders used before `dir`; a video saved in one of them is still found there. */
  olderDirs?: () => string[]
  ffmpegPath: string
  ffprobePath: string
  maxBytes: number
}

/**
 * Videos people upload: kept in folders they name, made playable in a browser, shown with a
 * thumbnail. A folder is created the first time a video is put in it, as a real directory under
 * `library/` (its disk name made safe) and as a name in the database (as typed).
 */
export class VideoLibrary {
  /** Making files playable happens one at a time: a conversion uses a whole CPU core. */
  private queue: Promise<void> = Promise.resolve()
  private readonly stills = new Map<string, Promise<string | null>>()
  private activeStills = 0
  private readonly stillQueue: (() => void)[] = []

  constructor(
    private readonly store: Store,
    private readonly opts: LibraryOptions,
  ) {}

  get maxBytes(): number {
    return this.opts.maxBytes
  }

  private get incomingDir(): string {
    return path.join(this.opts.dir, '_incoming')
  }

  private get libraryDir(): string {
    return path.join(this.opts.dir, 'library')
  }

  /** Room for the file and the playable copy made from it. */
  async hasSpaceFor(bytes: number): Promise<boolean> {
    try {
      await mkdir(this.opts.dir, { recursive: true })
      const fs = await statfs(this.opts.dir)
      return fs.bavail * fs.bsize > bytes * 2 + 256 * 1024 * 1024
    } catch {
      return true
    }
  }

  /** Streams an upload to disk, never holding it in memory, and refuses more than the limit. */
  async receive(stream: Readable, id: string): Promise<{ file: string; bytes: number }> {
    await mkdir(this.incomingDir, { recursive: true })
    const part = path.join(this.incomingDir, `${id}.part`)
    let bytes = 0
    const limit = this.opts.maxBytes
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length
        if (bytes > limit) done(new UploadError('too_large'))
        else done(null, chunk)
      },
    })
    try {
      await pipeline(stream, counter, createWriteStream(part, { flags: 'wx' }))
    } catch (error) {
      await rm(part, { force: true })
      throw error
    }
    if (bytes === 0) {
      await rm(part, { force: true })
      throw new UploadError('empty')
    }
    await rename(part, path.join(this.incomingDir, `${id}.upload`))
    return { file: `_incoming/${id}.upload`, bytes }
  }

  /**
   * Checks the received file is a video, enters it in the archive as `processing` and queues the
   * work that makes it playable. A file that is not a video is deleted at once.
   */
  async accept(input: {
    id: string
    tenantId: string | null
    email: string
    folder: string | null
    title: string
    deviceSn: string | null
    incomingFile: string
    bytes: number
  }): Promise<RecordingRow> {
    // Looked for in every folder: the main folder may have been changed since the file arrived.
    const abs = this.resolve(input.incomingFile) ?? path.join(this.opts.dir, input.incomingFile)
    const probe = await probeVideo(this.opts.ffprobePath, abs)
    if (!probe?.video || IMAGE_CODECS.has(probe.video.codec) || probe.video.width <= 0) {
      await rm(abs, { force: true })
      throw new UploadError('not_video')
    }

    // A second video with the same name in the same folder is numbered, never refused.
    let title = input.title
    for (
      let n = 2;
      n < 1000 && (await this.store.recordings.titleTaken(input.tenantId, input.folder, title));
      n++
    )
      title = `${input.title} (${n})`

    const startedAt = probe.createdAt ?? new Date()
    const seconds = probe.durationS
    await this.store.recordings.insert({
      id: input.id,
      sessionId: input.id,
      deviceSn: input.deviceSn,
      mode: 'upload',
      source: 'upload',
      title,
      folder: input.folder,
      state: 'processing',
      tenantId: input.tenantId,
      file: input.incomingFile,
      startedAt,
      endedAt: new Date(startedAt.getTime() + Math.round(seconds * 1000)),
      durationS: Math.max(1, Math.round(seconds)),
      sizeBytes: input.bytes,
      operatorEmail: input.email,
    })
    this.enqueue(input.id)
    return (await this.store.recordings.get(input.id))!
  }

  /** Carries on after a restart: uploads that were mid-way are finished or marked failed. */
  async resume(): Promise<void> {
    for (const name of await readdir(this.incomingDir).catch(() => [] as string[]))
      // Still arriving when the API stopped: the sender has to try again.
      if (name.endsWith('.part')) await rm(path.join(this.incomingDir, name), { force: true })
    for (const row of await this.store.recordings.processing()) {
      const found = this.resolve(row.file)
      const present = found
        ? await stat(found).then(
            () => true,
            () => false,
          )
        : false
      if (present) this.enqueue(row.id)
      else
        await this.store.recordings.finishUpload(row.id, {
          state: 'failed',
          error: 'The upload was interrupted by a restart. Please upload it again.',
        })
    }
  }

  /** Removes a video's files: the video, its thumbnail, and an upload still waiting to be made playable. */
  async deleteFiles(row: Pick<RecordingRow, 'file'>): Promise<void> {
    const abs = this.resolve(row.file)
    if (!abs) return
    await Promise.all([rm(abs, { force: true }), rm(`${abs}.jpg`, { force: true })])
  }

  /**
   * A file of the archive as an absolute path, or null for one that would leave the folder. It is
   * named relative to the main folder, so it is looked for there and then in the folders used before.
   */
  resolve(file: string): string | null {
    let first: string | null = null
    for (const root of [this.opts.dir, ...(this.opts.olderDirs?.() ?? [])]) {
      const base = path.resolve(root)
      const abs = path.resolve(base, file)
      if (!abs.startsWith(base + path.sep)) return null
      first ??= abs
      if (existsSync(abs)) return abs
    }
    return first
  }

  /**
   * The still shown on a grid card, made once and kept beside the video. Clips recorded before
   * there were thumbnails get theirs the first time they are shown.
   */
  thumbnail(row: Pick<RecordingRow, 'id' | 'file' | 'duration_s'>): Promise<string | null> {
    const video = this.resolve(row.file)
    if (!video) return Promise.resolve(null)
    const pending = this.stills.get(row.id)
    if (pending) return pending
    const job = this.withStillSlot(() => this.makeThumbnail(video, row.duration_s)).finally(() =>
      this.stills.delete(row.id),
    )
    this.stills.set(row.id, job)
    return job
  }

  // ------------------------------------------------------------------ internals

  private makeThumbnail(video: string, durationS: number): Promise<string | null> {
    return makeStill(this.opts.ffmpegPath, video, durationS)
  }

  /** At most two stills are made at once: a page of 48 cards must not start 48 ffmpeg processes. */
  private async withStillSlot<T>(job: () => Promise<T>): Promise<T> {
    while (this.activeStills >= 2)
      await new Promise<void>((resolve) => this.stillQueue.push(resolve))
    this.activeStills++
    try {
      return await job()
    } finally {
      this.activeStills--
      this.stillQueue.shift()?.()
    }
  }

  private enqueue(id: string): void {
    this.queue = this.queue
      .then(() => this.process(id))
      .catch((error) => console.error('[library] making a video playable failed', error))
  }

  private async process(id: string): Promise<void> {
    const row = await this.store.recordings.get(id)
    // Deleted while it waited its turn.
    if (!row || row.state !== 'processing') return
    const input = this.resolve(row.file)
    const fail = async (message: string): Promise<void> => {
      if (input) await rm(input, { force: true })
      await this.store.recordings.finishUpload(id, { state: 'failed', error: message })
    }
    if (!input) return fail('The server could not read this video.')

    const probe = await probeVideo(this.opts.ffprobePath, input)
    if (!probe?.video) return fail('The server could not read this video.')
    const plan = planFor(probe)
    const ext = plan.kind === 'webm' ? 'webm' : 'mp4'

    // The folder is created here the first time a video is put in it.
    const folderDir = row.folder ? diskName(row.folder, 'folder') : '_unfiled'
    const dir = path.join(this.libraryDir, folderDir)
    await mkdir(dir, { recursive: true })
    const base = diskName(row.title ?? 'video', 'video', 80)
    let name = ''
    for (let n = 1; n < 1000; n++) {
      const candidate = `${base}${n > 1 ? `_${n}` : ''}.${ext}`
      const taken = await stat(path.join(dir, candidate)).then(
        () => true,
        () => false,
      )
      if (!taken) {
        name = candidate
        break
      }
    }
    if (!name) return fail('The server could not choose a file name.')
    const final = path.join(dir, name)
    const partial = `${final}.part`

    const result = await run(this.opts.ffmpegPath, ffmpegArgs(plan, input, partial), {
      nice: plan.kind === 'transcode',
    })
    if (result.code !== 0) {
      console.error(`[library] ${plan.kind} failed for ${id}: ${result.err.trim().slice(-300)}`)
      await rm(partial, { force: true })
      return fail(
        plan.kind === 'transcode'
          ? 'The server could not convert this video to a format a browser plays.'
          : 'The server could not read this video.',
      )
    }
    await rename(partial, final)

    // Deleted while it was being converted: leave nothing behind.
    if (!(await this.store.recordings.get(id))) {
      await Promise.all([rm(final, { force: true }), rm(input, { force: true })])
      return
    }
    await rm(input, { force: true })

    const info = await stat(final)
    const measured = (await probeVideo(this.opts.ffprobePath, final))?.durationS || probe.durationS
    const startedAt = new Date(row.started_at)
    await this.store.recordings.finishUpload(id, {
      state: 'ready',
      file: `library/${folderDir}/${name}`,
      startedAt,
      endedAt: new Date(startedAt.getTime() + Math.round(measured * 1000)),
      durationS: Math.max(1, Math.round(measured)),
      sizeBytes: info.size,
    })
    // The card's picture is made now so the first look is instant; a failure only leaves a placeholder.
    await this.makeThumbnail(final, measured).catch(() => null)
  }
}
