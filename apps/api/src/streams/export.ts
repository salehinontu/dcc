import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { Store } from '../store'
import type { StreamManager } from './manager'

/** The drone is not streaming (yet): ask again in a moment. */
export class NotStreaming extends Error {}
/** The server is already handing out as many live feeds as it is set to. */
export class TooManyLive extends Error {}
/** The picture could not be made. */
export class FrameFailed extends Error {}

export interface ExportOptions {
  ffmpegPath: string
  /** Where ffmpeg reads a live stream from, by its key: the media server on the host or compose network, never the internet. */
  inputUrl: (key: string) => string
  /** How long a request waits for a drone that is not streaming yet. */
  waitMs: number
  /** Live feeds at once, across the server. */
  maxLive: number
  /** A picture taken this recently is handed to the next request too (a program asking every 100 ms must not start ffmpeg 10 times a second). */
  frameCacheMs?: number
  /** How long one picture may take once the feed is there. */
  frameTimeoutMs?: number
  /** ffmpeg `-re`: read a file at playing speed, so a test file behaves like a live feed. */
  realtimeInput?: boolean
}

export interface Frame {
  jpeg: Buffer
  /** When the picture was taken (ms since epoch). */
  at: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * What a customer's own program (an AI analysis tool) can take from a live drone: one JPEG now, or the video as it
 * is. Both read the same live stream the recorder reads (`liveStreamKeyFor`), **copy** it (the video is never
 * re-encoded; a picture decodes one frame) and never reveal the stream key. A request counts as a viewer, so it
 * starts the drone's stream if nobody is watching and lets it linger afterwards, like a person at the wall would.
 */
export class MediaExport {
  private live = 0
  private readonly frames = new Map<string, Frame>()
  private readonly pending = new Map<string, Promise<Frame>>()

  constructor(
    private readonly deps: { store: Store; manager: StreamManager },
    private readonly opts: ExportOptions,
  ) {}

  get liveCount(): number {
    return this.live
  }

  /** The key of the drone's live stream, asking the drone to start it and waiting a while for it. */
  private async liveKey(sn: string, viewer: string): Promise<string> {
    this.deps.manager.watch(viewer, [sn])
    const deadline = Date.now() + this.opts.waitMs
    let kickAt = Date.now() + 4000
    for (;;) {
      const key = await this.deps.store.liveStreamKeyFor(sn)
      if (key) return key
      if (Date.now() >= deadline) throw new NotStreaming(`${sn} is not streaming`)
      if (Date.now() >= kickAt) {
        kickAt = Date.now() + 4000
        this.deps.manager.kick(sn)
      }
      await sleep(400)
    }
  }

  /** One picture from the live feed. Concurrent callers share one grab; a fresh one is reused for a moment. */
  async frame(sn: string): Promise<Frame> {
    const cached = this.frames.get(sn)
    if (cached && Date.now() - cached.at < (this.opts.frameCacheMs ?? 1000)) return cached
    const running = this.pending.get(sn)
    if (running) return running
    const work = this.grab(sn).finally(() => this.pending.delete(sn))
    this.pending.set(sn, work)
    return work
  }

  private async grab(sn: string): Promise<Frame> {
    const viewer = `export:${randomUUID()}`
    try {
      const key = await this.liveKey(sn, viewer)
      const jpeg = await this.decodeOne(key)
      const frame = { jpeg, at: Date.now() }
      this.frames.set(sn, frame)
      if (this.frames.size > 200) this.frames.clear()
      return frame
    } finally {
      // The stream lingers for a while after the last viewer, so a program asking once a second keeps it up.
      this.deps.manager.unwatch(viewer, [sn])
    }
  }

  private decodeOne(key: string): Promise<Buffer> {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostats',
      '-rw_timeout',
      '10000000',
      ...(this.opts.realtimeInput ? ['-re'] : []),
      '-i',
      this.opts.inputUrl(key),
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-an',
      '-q:v',
      '3',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      let errors = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), this.opts.frameTimeoutMs ?? 15_000)
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => (errors = (errors + chunk).slice(-300)))
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new FrameFailed(error.message))
      })
      child.on('close', () => {
        clearTimeout(timer)
        const jpeg = Buffer.concat(chunks)
        if (jpeg.length > 0) resolve(jpeg)
        else reject(new FrameFailed(errors.trim() || 'no picture came out'))
      })
    })
  }

  /**
   * The live video as MPEG-TS, copied from the stream as it is. `close` ends it and lets go of the drone; it is also
   * called when the video ends by itself (the stream stopped or restarted: the program asks again).
   */
  async openLive(sn: string): Promise<{ stream: Readable; close: () => void }> {
    if (this.live >= this.opts.maxLive) throw new TooManyLive('too many live feeds')
    this.live++
    const viewer = `export:${randomUUID()}`
    let child: ReturnType<typeof spawn> | undefined
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.live--
      this.deps.manager.unwatch(viewer, [sn])
      child?.kill('SIGKILL')
    }
    try {
      const key = await this.liveKey(sn, viewer)
      child = spawn(
        this.opts.ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostats',
          '-rw_timeout',
          '15000000',
          ...(this.opts.realtimeInput ? ['-re'] : []),
          '-i',
          this.opts.inputUrl(key),
          '-map',
          '0:v:0',
          '-an',
          '-c:v',
          'copy',
          '-f',
          'mpegts',
          '-flush_packets',
          '1',
          'pipe:1',
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
      child.on('error', release)
      child.on('close', release)
      return { stream: child.stdout!, close: release }
    } catch (error) {
      release()
      throw error
    }
  }
}
