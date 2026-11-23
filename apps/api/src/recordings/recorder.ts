import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ActiveRecording, RecordingMode } from '@dji/protocol'
import { config } from '../config'
import type { Store } from '../store'
import type { StreamManager } from '../streams/manager'
import { diskName, makeStill, RESERVED_DIRS } from './library'
import type { RecordingPlace } from './place'

/**
 * Serials become directory names, so only letters, digits, - and _ pass: nothing can climb out of
 * the recordings folder through a serial.
 */
export const SAFE_SN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * `<drone name>_<serial>[_auto]_<YYYYMMDD>_<HHMMSSZ>.mp4`: the drone's name as it was when the clip was
 * opened, its serial, `_auto` for a clip of an automatic recording, then the opening time in UTC (the
 * `Z`). Older names without the `Z` are still read.
 */
const CLIP_NAME = /^(.+)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})Z?\.mp4$/
const AUTO_CLIP = /_auto_\d{8}_\d{6}Z?\.mp4$/
const MIN_CLIP_BYTES = 2048
const MAX_QUICK_FAILURES = 5
const QUICK_FAILURE_MS = 5000
// "No time limit": a clip length (ten years) that no recording reaches, so a clip ends only when the feed does.
const NO_CUT_SECONDS = 315_360_000
const RETRY_MS = 2000
const STOP_GRACE_MS = 15_000
/** An automatic recording looks at who should be recording this often. */
const RECONCILE_MS = 30_000
/** An automatic recording whose ffmpeg keeps failing never gives up: it waits this long and tries again. */
const BACKOFF_MS = 30_000
/** A recording waiting for its drone asks for the stream again this soon after it starts, then this often. */
const FIRST_KICK_MS = 5_000
const KICK_MS = 30_000
/** A file this fresh may still be written by a recorder; leave it alone when indexing. */
const ORPHAN_AGE_MS = 90_000

export class RecorderError extends Error {
  constructor(readonly code: 'bad_serial' | 'busy') {
    super(code)
  }
}

export interface RecorderOptions {
  /** The main folder clips are written to; read each time a clip is opened, so a change needs no restart. */
  dir: string
  /** Folders used before `dir`: clips a crash left there are still indexed. */
  olderDirs?: () => string[]
  ffmpegPath: string
  ffprobePath: string
  segmentSeconds: number
  gapSeconds: number
  maxActive: number
  /** What ffmpeg reads for the stream with this key. A test points it at a file. */
  inputUrl: (key: string) => string
  /** How often a recording waits between looks for its feed. */
  pollMs: number
  /** ffmpeg `-re`: read a file at playing speed, so a test file behaves like a live feed. */
  realtimeInput?: boolean
  /** Whether a drone with no choice of its own records automatically. */
  autoDefault?: boolean
  /** How often automatic recording checks who should be recording. */
  reconcileMs?: number
}

export function recorderOptionsFromConfig(place?: RecordingPlace): RecorderOptions {
  return {
    get dir() {
      return place?.dir ?? config.recordings.dir
    },
    olderDirs: () => place?.olderDirs ?? [],
    ffmpegPath: config.recordings.ffmpegPath,
    ffprobePath: config.recordings.ffprobePath,
    segmentSeconds: config.recordings.segmentSeconds,
    gapSeconds: config.recordings.gapSeconds,
    maxActive: config.recordings.maxActive,
    inputUrl: (key) => config.media.rtmpInternalTemplate.replace('{key}', encodeURIComponent(key)),
    pollMs: 2000,
    autoDefault: config.recordings.autoDefault,
  }
}

interface Session {
  id: string
  sn: string
  mode: RecordingMode
  email: string | null
  startedAt: Date
  stopRequested: boolean
  state: 'waiting' | 'recording' | 'paused'
  /** Clips finished and archived so far. */
  clips: number
  /** The last moment the feed was live; a feed gone for `gapSeconds` ends a manual recording. */
  lastLiveAt: number
  /** When a recording that is waiting for its drone next asks for the stream. */
  nextKickAt: number
  reason?: string
  child?: ChildProcess
  wake?: () => void
  done: Promise<void>
}

function viewerId(sn: string): string {
  return `recorder:${sn}`
}

/** When the clip was opened, read from its name. */
export function clipStart(name: string): Date | null {
  const m = CLIP_NAME.exec(name)
  if (!m) return null
  const [, , y, mo, d, h, mi, s] = m.map(Number)
  return new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!))
}

function exec(cmd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    let child: ChildProcess
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve({ code: null, out })
      return
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => (out += chunk))
    child.on('error', () => resolve({ code: null, out }))
    child.on('close', (code) => resolve({ code, out }))
  })
}

/**
 * Records a drone's live feed on the server: a copy of the stream (no re-encode, so next to no
 * CPU) written as MP4 files, indexed in the database. A file runs until the feed ends (the drone is
 * switched off, or the stream stops), whatever its length; `segmentSeconds` above 0 cuts it into clips.
 *
 * A recording is a session that outlives the feed: when the stream drops and comes back (a link
 * loss, a stop and resume, a new stream id) it picks the new one up and carries on, and it ends
 * only when someone stops it or the feed has been gone for `gapSeconds`. While it runs it counts
 * as a viewer, so the stream manager keeps the drone's stream up with nobody watching.
 */
export class RecordingManager {
  private readonly sessions = new Map<string, Session>()
  /** Why recording is paused (the disk is too full), or null. Set by the janitor. */
  private paused: string | null = null
  private autoTimer: NodeJS.Timeout | undefined
  private orphanTimer: NodeJS.Timeout | undefined
  private reconciling = false
  private disposed = false
  /** Finishing a clip (a copy and a probe) happens one at a time. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: { store: Store; manager: StreamManager },
    private readonly opts: RecorderOptions,
  ) {}

  private get store(): Store {
    return this.deps.store
  }

  /** Starts recording a drone, or returns the recording already running for it. */
  async start(
    sn: string,
    actor: { email: string | null },
    mode: RecordingMode = 'manual',
  ): Promise<ActiveRecording> {
    if (!SAFE_SN.test(sn) || RESERVED_DIRS.has(sn)) throw new RecorderError('bad_serial')
    const existing = this.sessions.get(sn)
    if (existing) return this.describe(existing)
    if (this.sessions.size >= this.opts.maxActive) throw new RecorderError('busy')

    const session: Session = {
      id: randomUUID(),
      sn,
      mode,
      email: actor.email,
      startedAt: new Date(),
      stopRequested: false,
      state: 'waiting',
      clips: 0,
      lastLiveAt: Date.now(),
      nextKickAt: Date.now() + FIRST_KICK_MS,
      done: Promise.resolve(),
    }
    this.sessions.set(sn, session)
    // Counted as a viewer so the stream starts, and stays, with nobody at a screen.
    this.deps.manager.watch(viewerId(sn), [sn])
    session.done = this.run(session)
      .catch((error) => console.error('[rec] session failed', error))
      .finally(() => this.end(session))
    await this.store
      .logDeviceEvent(sn, 'recording.started', { sessionId: session.id, by: actor.email, mode })
      .catch(() => undefined)
    return this.describe(session)
  }

  /** Stops the recording for a drone and waits until its last clip is archived. */
  async stop(sn: string): Promise<boolean> {
    const session = this.sessions.get(sn)
    if (!session) return false
    session.stopRequested = true
    session.wake?.()
    // SIGINT makes ffmpeg close the clip it is writing properly; the timer is only a backstop.
    session.child?.kill('SIGINT')
    const backstop = setTimeout(() => session.child?.kill('SIGKILL'), STOP_GRACE_MS)
    try {
      await session.done
    } finally {
      clearTimeout(backstop)
    }
    return true
  }

  isRecording(sn: string): boolean {
    return this.sessions.has(sn)
  }

  /** The folder the clips are in; the routes resolve a clip's file against it. */
  get directory(): string {
    return this.opts.dir
  }

  async active(): Promise<ActiveRecording[]> {
    const sessions = [...this.sessions.values()]
    const names = await this.store.recordings.deviceNames(sessions.map((s) => s.sn))
    return sessions.map((s) => this.toActive(s, names.get(s.sn) ?? null))
  }

  /** True while this drone is set to record automatically and a session for it is running. */
  isAuto(sn: string): boolean {
    return this.sessions.get(sn)?.mode === 'continuous'
  }

  /** What a running recording of this drone is doing, or null when none is running. */
  stateOf(sn: string): 'waiting' | 'recording' | 'paused' | null {
    return this.sessions.get(sn)?.state ?? null
  }

  get isPaused(): boolean {
    return this.paused !== null
  }

  get pausedReason(): string | null {
    return this.paused
  }

  /**
   * Pauses every recording (the disk is too full to write more) or lets them go on (`null`). A pause
   * closes the clip being written properly; the recordings stay in place and carry on by themselves.
   */
  setPaused(reason: string | null): void {
    if (this.paused === reason) return
    this.paused = reason
    for (const session of this.sessions.values()) {
      if (reason) session.child?.kill('SIGINT')
      session.wake?.()
    }
    console.warn(reason ? `[rec] recording paused: ${reason}` : '[rec] recording resumed')
  }

  /**
   * Makes the running recordings match what is set: every drone that should record automatically has
   * one (started whether or not it is connected: it waits for the drone), one that no longer should
   * is stopped, and a manual recording of a drone set to automatic becomes the automatic one. Run
   * every 30 s and after a change, so it also starts a drone added later and mends a recording that
   * ended by accident.
   */
  async reconcile(): Promise<void> {
    if (this.reconciling || this.disposed) return
    this.reconciling = true
    try {
      const wanted = new Set<string>()
      for (const device of await this.store.recordings.autoDevices())
        if (
          (device.auto_record ?? this.opts.autoDefault ?? false) &&
          SAFE_SN.test(device.sn) &&
          !RESERVED_DIRS.has(device.sn)
        )
          wanted.add(device.sn)
      for (const sn of wanted) {
        const session = this.sessions.get(sn)
        if (!session) {
          try {
            await this.start(sn, { email: null }, 'continuous')
          } catch (error) {
            if (!(error instanceof RecorderError)) console.error('[rec] could not start', sn, error)
          }
        } else if (session.mode !== 'continuous' && !session.stopRequested) {
          session.mode = 'continuous'
          session.email = null
        }
      }
      for (const session of [...this.sessions.values()])
        if (session.mode === 'continuous' && !session.stopRequested && !wanted.has(session.sn))
          await this.stop(session.sn)
    } finally {
      this.reconciling = false
    }
  }

  /** Starts the automatic recordings and keeps them matching what is set. Call once at start-up. */
  startAuto(): void {
    if (this.autoTimer) return
    const tick = (): void =>
      void this.reconcile().catch((error) => console.error('[rec] reconcile failed', error))
    tick()
    this.autoTimer = setInterval(tick, this.opts.reconcileMs ?? RECONCILE_MS)
    this.autoTimer.unref()
    // A clip left half-written by a crash is indexed at the next start only if it is old enough, so a
    // restart within a minute of a crash would miss it; looking again every 10 minutes finds it.
    this.orphanTimer = setInterval(
      () =>
        void this.indexOrphans().catch((error) => console.error('[rec] indexing failed', error)),
      10 * 60_000,
    )
    this.orphanTimer.unref()
  }

  /**
   * Clips left on disk by a restart (the API was killed while ffmpeg wrote one) are valid up to
   * the last fragment: index them so they are not lost. Run once at start-up.
   */
  async indexOrphans(): Promise<number> {
    const known = await this.store.recordings.files()
    let added = 0
    for (const root of [this.opts.dir, ...(this.opts.olderDirs?.() ?? [])])
      added += await this.indexOrphansIn(root, known)
    return added
  }

  private async indexOrphansIn(root: string, known: Set<string>): Promise<number> {
    let added = 0
    const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const dir of dirs) {
      // `library` and `_incoming` hold uploads, which the library looks after; they are not a drone's.
      if (!dir.isDirectory() || !SAFE_SN.test(dir.name) || RESERVED_DIRS.has(dir.name)) continue
      const folder = path.join(root, dir.name)
      for (const file of await readdir(folder).catch(() => [])) {
        const abs = path.join(folder, file)
        // A half-finished copy from a restart: the fragmented original is still beside it.
        if (file.endsWith('.part.mp4')) {
          await rm(abs, { force: true })
          continue
        }
        if (!CLIP_NAME.test(file) || known.has(`${dir.name}/${file}`)) continue
        const info = await stat(abs).catch(() => null)
        if (!info?.isFile() || Date.now() - info.mtimeMs < ORPHAN_AGE_MS) continue
        if (
          await this.archive({
            sn: dir.name,
            abs,
            csvSeconds: null,
            sessionId: randomUUID(),
            // A clip of an automatic recording says so in its name; it must stay one, or cleanup would never reach it.
            mode: AUTO_CLIP.test(file) ? 'continuous' : 'manual',
            email: null,
          })
        )
          added++
      }
    }
    return added
  }

  /**
   * The main folder was changed: each running recording closes the clip it is writing (it is archived
   * where it was written) and carries on in the new folder after a moment.
   */
  relocate(): void {
    for (const session of this.sessions.values()) session.child?.kill('SIGINT')
  }

  /** Stops every recording; called when the API shuts down. */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.autoTimer) clearInterval(this.autoTimer)
    if (this.orphanTimer) clearInterval(this.orphanTimer)
    await Promise.all([...this.sessions.keys()].map((sn) => this.stop(sn)))
  }

  // ------------------------------------------------------------------ internals

  private describe(session: Session): Promise<ActiveRecording> {
    return this.store.recordings
      .deviceNames([session.sn])
      .then((names) => this.toActive(session, names.get(session.sn) ?? null))
  }

  private toActive(session: Session, deviceName: string | null): ActiveRecording {
    return {
      sessionId: session.id,
      deviceSn: session.sn,
      deviceName,
      mode: session.mode,
      startedAt: session.startedAt.toISOString(),
      startedBy: session.email,
      state: session.state,
      clips: session.clips,
    }
  }

  private async run(session: Session): Promise<void> {
    let quickFailures = 0
    while (!session.stopRequested) {
      // The disk is too full to write more: wait, and carry on by itself when there is room again.
      if (this.paused) {
        session.state = 'paused'
        session.lastLiveAt = Date.now()
        await this.sleep(session, this.opts.pollMs)
        continue
      }
      const key = await this.store.liveStreamKeyFor(session.sn)
      if (!key) {
        session.state = 'waiting'
        // Nobody is at a screen to ask for the drone's stream, so the recording asks for it, and asks
        // again from time to time: the first ask can come before the drone has said what it can send.
        if (Date.now() >= session.nextKickAt) {
          session.nextKickAt = Date.now() + KICK_MS
          this.deps.manager.kick(session.sn)
        }
        // A recording someone started ends when its feed is gone for good. An automatic one waits for
        // the drone for as long as it is set to record: a drone may be away for a week.
        if (
          session.mode !== 'continuous' &&
          Date.now() - session.lastLiveAt > this.opts.gapSeconds * 1000
        ) {
          session.reason = 'the feed was gone too long'
          return
        }
        await this.sleep(session, this.opts.pollMs)
        continue
      }
      session.lastLiveAt = Date.now()
      session.state = 'recording'
      const result = await this.runFfmpeg(session, key)
      session.lastLiveAt = Date.now()
      if (session.stopRequested) return
      // ffmpeg was stopped to make room: the next turn of the loop waits.
      if (this.paused) continue
      quickFailures = result.produced === 0 && result.ms < QUICK_FAILURE_MS ? quickFailures + 1 : 0
      if (quickFailures >= MAX_QUICK_FAILURES) {
        console.error(`[rec] ${session.sn}: ffmpeg keeps failing`)
        if (session.mode !== 'continuous') {
          session.reason = 'ffmpeg keeps failing'
          return
        }
        // An automatic recording never gives up: it waits and tries again.
        quickFailures = 0
        session.state = 'waiting'
        await this.sleep(session, BACKOFF_MS)
        continue
      }
      session.state = 'waiting'
      await this.sleep(session, RETRY_MS)
    }
  }

  private async end(session: Session): Promise<void> {
    // The last clip is still being copied and probed; the recording is over only once it is archived.
    await this.queue
    this.deps.manager.unwatch(viewerId(session.sn), [session.sn])
    this.sessions.delete(session.sn)
    await this.store
      .logDeviceEvent(session.sn, 'recording.stopped', {
        sessionId: session.id,
        clips: session.clips,
        reason: session.reason ?? 'stopped',
      })
      .catch(() => undefined)
  }

  private sleep(session: Session, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      function done(): void {
        clearTimeout(timer)
        resolve()
      }
      session.wake = done
    })
  }

  /** One ffmpeg run: reads the feed until it ends or a stop arrives, writing clips as it goes. */
  private async runFfmpeg(
    session: Session,
    key: string,
  ): Promise<{ produced: number; ms: number }> {
    const folder = path.join(this.opts.dir, session.sn)
    await mkdir(folder, { recursive: true })
    // Each time an automatic recording's drone connects is a recording of its own, so the next-clip
    // playback follows one flight or one stretch, not a month.
    if (session.mode === 'continuous') session.id = randomUUID()
    const name = (await this.store.recordings.deviceNames([session.sn])).get(session.sn)
    const prefix = diskName(name ?? 'drone', 'drone', 40)
    const startedMs = Date.now()
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-nostats',
      // A feed that goes silent is given up after 15 s instead of hanging a recording for good.
      '-rw_timeout',
      '15000000',
      ...(this.opts.realtimeInput ? ['-re'] : []),
      '-i',
      this.opts.inputUrl(key),
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c',
      'copy',
      '-f',
      'segment',
      // The segment muxer cuts every 2 s when given nothing, so "no limit" is a time it never reaches.
      '-segment_time',
      String(this.opts.segmentSeconds > 0 ? this.opts.segmentSeconds : NO_CUT_SECONDS),
      '-reset_timestamps',
      '1',
      '-strftime',
      '1',
      // Fragmented, so a clip survives a crash and can be indexed; each is made seekable once finished.
      '-segment_format',
      'mp4',
      '-segment_format_options',
      'movflags=+frag_keyframe+empty_moov+default_base_moof',
      '-segment_list',
      'pipe:1',
      '-segment_list_type',
      'csv',
      path.join(
        folder,
        `${prefix}_${session.sn}${session.mode === 'continuous' ? '_auto' : ''}_%Y%m%d_%H%M%SZ.mp4`,
      ),
    ]

    return new Promise((resolve) => {
      let produced = 0
      let buffer = ''
      let errors = ''
      let child: ChildProcess
      try {
        // TZ=UTC: the clip names carry the opening time in UTC whatever the host's zone is.
        child = spawn(this.opts.ffmpegPath, args, {
          env: { ...process.env, TZ: 'UTC' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        console.error('[rec] ffmpeg could not start', (error as Error).message)
        resolve({ produced, ms: Date.now() - startedMs })
        return
      }
      session.child = child

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk
        for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          // A finished clip: `<name>,<start>,<end>`, the times in seconds.
          const m = /^(.+\.mp4),([\d.]+),([\d.]+)$/.exec(line)
          if (!m) continue
          produced++
          const abs = path.join(folder, path.basename(m[1]!))
          const seconds = Number(m[3]) - Number(m[2])
          this.queue = this.queue
            .then(async () => {
              const ok = await this.archive({
                sn: session.sn,
                abs,
                csvSeconds: seconds,
                sessionId: session.id,
                mode: session.mode,
                email: session.email,
              })
              if (ok) session.clips++
            })
            .catch((error) => console.error('[rec] finishing a clip failed', error))
        }
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => (errors = (errors + chunk).slice(-600)))
      child.on('error', (error) => {
        console.error('[rec] ffmpeg could not start', error.message)
        session.child = undefined
        resolve({ produced, ms: Date.now() - startedMs })
      })
      child.on('close', (code) => {
        session.child = undefined
        if (code !== 0 && !session.stopRequested && errors.trim())
          console.warn(`[rec] ${session.sn}: ffmpeg ended (${code}): ${errors.trim().slice(-200)}`)
        resolve({ produced, ms: Date.now() - startedMs })
      })
    })
  }

  /**
   * Makes a finished clip seekable (a copy of the same video, no re-encode), measures it and
   * enters it in the archive. A clip too small to hold video is deleted.
   */
  private async archive(clip: {
    sn: string
    abs: string
    csvSeconds: number | null
    sessionId: string
    mode: RecordingMode
    email: string | null
  }): Promise<boolean> {
    const name = path.basename(clip.abs)
    const startedAt = clipStart(name)
    if (!startedAt) return false

    const part = clip.abs.replace(/\.mp4$/, '.part.mp4')
    const remux = await exec(this.opts.ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      clip.abs,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      part,
    ])
    // If the copy fails the fragmented original still plays, just without an exact seek bar.
    if (remux.code === 0) await rename(part, clip.abs).catch(() => rm(part, { force: true }))
    else await rm(part, { force: true })

    const info = await stat(clip.abs).catch(() => null)
    if (!info?.isFile() || info.size < MIN_CLIP_BYTES) {
      await rm(clip.abs, { force: true })
      return false
    }
    const probed = await exec(this.opts.ffprobePath, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      clip.abs,
    ])
    const measured = Number(probed.out.trim())
    const seconds = Number.isFinite(measured) && measured > 0 ? measured : (clip.csvSeconds ?? 0)

    // The grid card's picture, made now (one a clip, spread over time) so opening the grid on a month
    // of footage does not start hundreds of ffmpeg processes at once.
    await makeStill(this.opts.ffmpegPath, clip.abs, seconds).catch(() => null)
    await this.store.recordings.insert({
      id: randomUUID(),
      sessionId: clip.sessionId,
      deviceSn: clip.sn,
      mode: clip.mode,
      file: `${clip.sn}/${name}`,
      startedAt,
      endedAt: new Date(startedAt.getTime() + Math.round(seconds * 1000)),
      durationS: Math.max(1, Math.round(seconds)),
      sizeBytes: info.size,
      operatorEmail: clip.email,
    })
    return true
  }
}
