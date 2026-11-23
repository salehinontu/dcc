import { create } from 'zustand'
import { brand } from './branding'
import { acquireFeed, releaseFeed, type Feed } from './feeds'
import { unwatch, watch } from './socket'
import { useFleet } from './store'
import { streamForDevice } from './streamSelect'

/**
 * Records live feeds on this computer. The browser re-encodes the WebRTC picture it is
 * already receiving with MediaRecorder and writes it straight into a folder the operator
 * picked, one second at a time, so nothing is uploaded and the server does no extra work.
 * The recording keeps its own share of the page's connection (`feeds.ts`) and its own
 * watch on the aircraft, so it survives tile → focus, a layout change or another screen.
 */

/**
 * Where a browser has to buffer the whole file in memory (no folder to write into), a long
 * recording is split so that memory stays bounded and a closed tab loses at most this much.
 * Writing into a folder has no such limit: the file just keeps growing.
 */
const SEGMENT_MS = 30 * 60_000
/** The picture may be away this long (a dropped link, a reconnect) before the file is closed. */
const GAP_MS = 5 * 60_000
const VIDEO_BITS_PER_SECOND = 5_000_000
const CHUNK_MS = 1_000
const RESTART_DELAY_MS = 1_000
// Picture only: H.264 in MP4 plays almost everywhere; WebM is the fallback.
const TYPES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

export interface RecordingSession {
  label: string
  startedAt: number
  /** True while the feed is not playing; the next file starts when it returns. */
  waiting: boolean
  files: number
}

export interface RecordingNotice {
  id: number
  sn: string
  kind: 'saved' | 'error'
  text: string
}

interface RecordingState {
  sessions: Record<string, RecordingSession>
  /** Name of the chosen folder, when the browser can write to one. */
  folder: string | null
  notice: RecordingNotice | null
}

export const useRecordings = create<RecordingState>(() => ({
  sessions: {},
  folder: null,
  notice: null,
}))

export const recordingSupported =
  typeof window !== 'undefined' && typeof window.MediaRecorder === 'function'

/** Chrome and Edge can write into a folder; other browsers download each file instead. */
export const folderSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window

type PermissionOptions = { mode: 'readwrite' }
type DirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (options: PermissionOptions) => Promise<PermissionState>
  requestPermission?: (options: PermissionOptions) => Promise<PermissionState>
}
type DirectoryPicker = (options?: {
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?: string
}) => Promise<DirectoryHandle>

interface Sink {
  write(chunk: Blob): Promise<void>
  /** Finishes the file and says where it went. */
  close(): Promise<string>
  /** Drops a file that never received any video. */
  discard(): Promise<void>
}

let noticeId = 0

function notify(sn: string, kind: RecordingNotice['kind'], text: string): void {
  noticeId += 1
  useRecordings.setState({ notice: { id: noticeId, sn, kind, text } })
}

function patchSession(sn: string, patch: Partial<RecordingSession>): void {
  useRecordings.setState((state) => {
    const current = state.sessions[sn]
    if (!current) return state
    const next = { ...current, ...patch }
    if (next.waiting === current.waiting && next.files === current.files) return state
    return { sessions: { ...state.sessions, [sn]: next } }
  })
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'the file could not be written'
}

// --- Folder -------------------------------------------------------------------------------

const DB_NAME = 'drone-fleet'
const DB_STORE = 'handles'
const FOLDER_KEY = 'recordings-folder'

let folder: DirectoryHandle | null = null
let folderLoad: Promise<DirectoryHandle | null> | null = null

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(DB_STORE)
    open.onerror = () => reject(open.error ?? new Error('storage unavailable'))
    open.onsuccess = () => {
      const db = open.result
      const request = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE))
      request.onsuccess = () => {
        resolve(request.result)
        db.close()
      }
      request.onerror = () => {
        reject(request.error ?? new Error('storage unavailable'))
        db.close()
      }
    }
  })
}

/** The folder chosen earlier, remembered by the browser across visits. */
export function loadRecordingFolder(): Promise<DirectoryHandle | null> {
  if (!folderSupported) return Promise.resolve(null)
  folderLoad ??= withStore<DirectoryHandle | undefined>('readonly', (store) =>
    store.get(FOLDER_KEY),
  )
    .then((stored) => {
      folder ??= stored ?? null
      useRecordings.setState({ folder: folder?.name ?? null })
      return folder
    })
    .catch(() => folder)
  return folderLoad
}

/** Asks for the recordings folder. Call it from a click. False when cancelled. */
export async function chooseRecordingFolder(): Promise<boolean> {
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker })
    .showDirectoryPicker
  if (!picker) return false
  try {
    const handle = await picker({
      id: 'drone-fleet-recordings',
      mode: 'readwrite',
      startIn: 'videos',
    })
    folder = handle
    useRecordings.setState({ folder: handle.name })
    await withStore('readwrite', (store) => store.put(handle, FOLDER_KEY)).catch(() => undefined)
    return true
  } catch {
    return false
  }
}

/** The folder to write into, asking for access (or for a folder) when needed. */
async function writableFolder(): Promise<DirectoryHandle | null> {
  const current = await loadRecordingFolder()
  if (current) {
    const options: PermissionOptions = { mode: 'readwrite' }
    try {
      let state = (await current.queryPermission?.(options)) ?? 'granted'
      if (state === 'prompt') state = (await current.requestPermission?.(options)) ?? 'denied'
      if (state === 'granted') return current
    } catch {
      // Access could not be asked for (the click is too old); pick the folder again.
    }
  }
  return (await chooseRecordingFolder()) ? folder : null
}

// --- Files --------------------------------------------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** `<file prefix>_<aircraft name>_<YYYY-MM-DD>_<HH-MM-SS>`, in this computer's time zone. */
export function recordingBaseName(label: string, sn: string, at: Date): string {
  const name =
    [...label.normalize('NFC')]
      .filter((char) => char.charCodeAt(0) >= 32 && !'\\/:*?"<>|'.includes(char))
      .join('')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 60) || sn
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const time = `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  return `${brand.filePrefix}_${name}_${date}_${time}`
}

async function freeName(dir: DirectoryHandle, base: string, ext: string): Promise<string> {
  for (let n = 1; n < 100; n += 1) {
    const name = `${base}${n === 1 ? '' : `_${n}`}.${ext}`
    try {
      await dir.getFileHandle(name)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return name
    }
  }
  throw new Error('too many recordings with the same name')
}

async function folderSink(dir: DirectoryHandle, base: string, ext: string): Promise<Sink> {
  const name = await freeName(dir, base, ext)
  const file = await dir.getFileHandle(name, { create: true })
  const writable = await file.createWritable()
  return {
    write: (chunk) => writable.write(chunk),
    close: async () => {
      await writable.close()
      return `${dir.name}/${name}`
    },
    discard: async () => {
      await writable.abort().catch(() => undefined)
      await dir.removeEntry(name).catch(() => undefined)
    },
  }
}

function downloadSink(base: string, ext: string, type: string): Sink {
  const parts: Blob[] = []
  return {
    write: async (chunk) => {
      parts.push(chunk)
    },
    close: async () => {
      const name = `${base}.${ext}`
      const url = URL.createObjectURL(new Blob(parts, { type }))
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      return name
    },
    discard: async () => {
      parts.length = 0
    },
  }
}

// --- A picture that outlives its connection -------------------------------------------------

/**
 * A MediaRecorder stops for good when the track it records ends, so a recording made straight
 * from a WebRTC connection ends at every reconnect. This is one steady video track that the
 * recorder keeps, fed with the frames of whichever connection is playing now: while the link
 * is away it simply gets no frames, and the same file carries on when the picture returns.
 * Chrome and Edge have it; elsewhere `createStableVideo` is null and a reconnect ends the file.
 */
interface StableVideo {
  readonly stream: MediaStream
  /** Feeds this picture's frames in; null while there is none. Replaces the previous one. */
  attach(track: MediaStreamTrack | null): void
  close(): void
}

type FrameProcessor = new (init: { track: MediaStreamTrack }) => {
  readable: ReadableStream<VideoFrame>
}
type FrameGenerator = new (init: { kind: 'video' }) => MediaStreamTrack & {
  writable: WritableStream<VideoFrame>
}

function createStableVideo(): StableVideo | null {
  const scope = window as unknown as {
    MediaStreamTrackProcessor?: FrameProcessor
    MediaStreamTrackGenerator?: FrameGenerator
    VideoFrame?: typeof VideoFrame
  }
  const Processor = scope.MediaStreamTrackProcessor
  const Generator = scope.MediaStreamTrackGenerator
  if (!Processor || !Generator || !scope.VideoFrame) return null

  const generator = new Generator({ kind: 'video' })
  const writer = generator.writable.getWriter()
  const t0 = performance.now()
  let run = 0
  let reader: ReadableStreamDefaultReader<VideoFrame> | null = null

  const pump = async (source: ReadableStreamDefaultReader<VideoFrame>, mine: number) => {
    try {
      for (;;) {
        const { value: frame, done } = await source.read()
        if (done) break
        if (mine !== run) {
          frame.close()
          break
        }
        // Each connection counts time from its own start; this clock is one for the whole file.
        const stamped = new VideoFrame(frame, {
          timestamp: Math.round((performance.now() - t0) * 1000),
        })
        frame.close()
        await writer.write(stamped)
      }
    } catch {
      // The connection's track ended or the recorder is gone: nothing more to feed.
    }
  }

  return {
    stream: new MediaStream([generator]),
    attach(track) {
      run += 1
      void reader?.cancel().catch(() => undefined)
      reader = null
      if (!track) return
      const next = new Processor({ track }).readable.getReader()
      reader = next
      void pump(next, run)
    },
    close() {
      run += 1
      void reader?.cancel().catch(() => undefined)
      reader = null
      void writer.close().catch(() => undefined)
      generator.stop()
    },
  }
}

// --- Recording ----------------------------------------------------------------------------

/**
 * One file: a MediaRecorder on the feed's picture, written as it records. With a steady
 * picture (`stable`) the file lives through reconnects; otherwise it ends with its connection.
 */
class Segment {
  private readonly recorder: MediaRecorder
  private readonly stable: StableVideo | null
  private writing: Promise<Sink>
  private bytes = 0
  private finishing = false
  private failure: string | null = null
  private readonly rollover: number | undefined
  /** The connection whose frames are being recorded now; null while the picture is away. */
  source: MediaStream | null

  constructor(
    source: MediaStream,
    openSink: (ext: string, type: string) => Promise<Sink>,
    private readonly writesToFolder: boolean,
    onRollover: () => void,
    private readonly onEnd: (
      segment: Segment,
      outcome: { where?: string; error?: string },
      unexpected: boolean,
    ) => void,
  ) {
    this.source = source
    this.stable = createStableVideo()
    const mimeType = TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
    this.recorder = new MediaRecorder(
      this.stable?.stream ?? new MediaStream(source.getVideoTracks()),
      {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      },
    )
    this.stable?.attach(source.getVideoTracks()[0] ?? null)
    const type = this.recorder.mimeType || mimeType || 'video/webm'
    this.writing = openSink(type.startsWith('video/mp4') ? 'mp4' : 'webm', type)
    // A file that cannot be written stops the encoder instead of encoding for nothing.
    this.writing.catch(() => this.halt())

    this.recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return
      this.bytes += event.data.size
      const chunk = event.data
      this.writing = this.writing.then(async (sink) => {
        await sink.write(chunk)
        return sink
      })
      this.writing.catch(() => this.halt())
    }
    this.recorder.onerror = (event) => {
      const error = (event as Event & { error?: DOMException }).error
      this.failure = error?.message || 'the browser stopped recording'
    }
    this.recorder.onstop = () => {
      window.clearTimeout(this.rollover)
      this.stable?.close()
      void this.close()
    }
    this.recorder.start(CHUNK_MS)
    // A file written into a folder grows until it is stopped; only a buffered one is split.
    if (!(this.stable && this.writesToFolder))
      this.rollover = window.setTimeout(onRollover, SEGMENT_MS)
  }

  /** True when a reconnect can be bridged: the same file carries on with the next picture. */
  get bridges(): boolean {
    return this.stable !== null
  }

  /** Records this connection from now on (null while the picture is away). Needs `bridges`. */
  switchTo(source: MediaStream | null): void {
    this.source = source
    this.stable?.attach(source?.getVideoTracks()[0] ?? null)
  }

  /** Ends the file on purpose: stop, rollover or a new source. */
  finish(): void {
    this.finishing = true
    this.halt()
  }

  /** Ends the file because something failed; the session sees it as unexpected. */
  private halt(): void {
    window.clearTimeout(this.rollover)
    if (this.recorder.state !== 'inactive') this.recorder.stop()
  }

  private async close(): Promise<void> {
    const unexpected = !this.finishing
    try {
      const sink = await this.writing
      if (this.bytes === 0) {
        await sink.discard()
        this.onEnd(this, this.failure ? { error: this.failure } : {}, unexpected)
        return
      }
      const where = await sink.close()
      this.onEnd(this, this.failure ? { where, error: this.failure } : { where }, unexpected)
    } catch (error) {
      this.onEnd(this, { error: errorText(error) }, unexpected)
    }
  }
}

/**
 * Records one aircraft until stopped. In Chrome and Edge it is one file that carries on through
 * reconnects (see `createStableVideo`); elsewhere one file per stretch of live video.
 */
class Session {
  private feed: Feed | null = null
  private unsubscribeFeed: (() => void) | null = null
  private readonly unsubscribeFleet: () => void
  private segment: Segment | null = null
  private failedSource: MediaStream | null = null
  private restartTimer: number | undefined
  /** Closes the file when the picture has been away longer than `GAP_MS`. */
  private gapTimer: number | undefined
  private stopped = false

  constructor(
    private readonly sn: string,
    private readonly label: string,
    private readonly dir: DirectoryHandle | null,
  ) {
    // A recording is a viewer: it keeps the stream running while nothing shows it.
    watch(sn)
    this.unsubscribeFleet = useFleet.subscribe(() => this.follow())
    this.follow()
  }

  /** Follows the aircraft's live stream; a new stream id is a new connection. */
  private follow(): void {
    if (this.stopped) return
    const stream = streamForDevice(useFleet.getState().streams, this.sn)
    const id = stream?.phase === 'live' ? stream.id : null
    if (id === (this.feed?.streamId ?? null)) return
    // A new connection: a steady file waits for its picture, any other ends here.
    if (this.segment?.bridges) this.segment.switchTo(null)
    else this.endSegment()
    this.dropFeed()
    if (id) {
      const feed = acquireFeed(id)
      this.feed = feed
      this.unsubscribeFeed = feed.subscribe(() => this.sync())
    }
    this.sync()
  }

  /**
   * Records while the connection plays. Where the browser allows it, a reconnect only pauses the
   * file and the same one carries on; elsewhere a reconnect closes it and the next one opens.
   */
  private sync(): void {
    if (this.stopped) return
    const playing = this.feed?.status === 'playing' ? this.feed.stream : null
    const source = playing?.getVideoTracks().some((track) => track.readyState === 'live')
      ? playing
      : null
    if (this.segment && this.segment.source !== source) {
      if (this.segment.bridges) this.segment.switchTo(source)
      else this.endSegment()
    }
    this.watchGap()
    if (
      source &&
      !this.segment &&
      this.restartTimer === undefined &&
      source !== this.failedSource
    ) {
      try {
        this.segment = this.startSegment(source)
      } catch (error) {
        this.failedSource = source
        notify(this.sn, 'error', `Recording ${this.label} failed: ${errorText(error)}`)
      }
    }
    patchSession(this.sn, { waiting: this.segment === null || this.segment.source === null })
  }

  /** A picture that stays away too long ends the file, so one does not hold an hour of nothing. */
  private watchGap(): void {
    const away = this.segment !== null && this.segment.source === null
    if (!away) {
      window.clearTimeout(this.gapTimer)
      this.gapTimer = undefined
      return
    }
    this.gapTimer ??= window.setTimeout(() => {
      this.gapTimer = undefined
      this.endSegment()
      this.sync()
    }, GAP_MS)
  }

  private startSegment(source: MediaStream): Segment {
    const base = recordingBaseName(this.label, this.sn, new Date())
    const dir = this.dir
    return new Segment(
      source,
      async (ext, type) => (dir ? folderSink(dir, base, ext) : downloadSink(base, ext, type)),
      dir !== null,
      () => {
        this.endSegment()
        this.sync()
      },
      (segment, outcome, unexpected) => this.segmentEnded(segment, outcome, unexpected),
    )
  }

  private segmentEnded(
    segment: Segment,
    outcome: { where?: string; error?: string },
    unexpected: boolean,
  ): void {
    if (outcome.where) {
      const files = (useRecordings.getState().sessions[this.sn]?.files ?? 0) + 1
      patchSession(this.sn, { files })
      notify(this.sn, 'saved', `Recording saved: ${outcome.where}`)
    }
    if (outcome.error) {
      notify(this.sn, 'error', `Recording ${this.label} stopped: ${outcome.error}`)
    }
    if (!unexpected || this.stopped || this.segment !== segment) return
    // The browser ended the file on its own (the feed dropped, or the encoder failed).
    this.segment = null
    if (outcome.error) this.failedSource = segment.source
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = undefined
      this.sync()
    }, RESTART_DELAY_MS)
    patchSession(this.sn, { waiting: true })
  }

  private endSegment(): void {
    const segment = this.segment
    this.segment = null
    segment?.finish()
  }

  private dropFeed(): void {
    this.unsubscribeFeed?.()
    this.unsubscribeFeed = null
    if (this.feed) releaseFeed(this.feed)
    this.feed = null
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    window.clearTimeout(this.restartTimer)
    window.clearTimeout(this.gapTimer)
    this.unsubscribeFleet()
    this.endSegment()
    this.dropFeed()
    unwatch(this.sn)
  }
}

const sessions = new Map<string, Session>()
const starting = new Set<string>()

function warnBeforeLeaving(event: BeforeUnloadEvent): void {
  event.preventDefault()
  event.returnValue = ''
}

function syncLeaveWarning(): void {
  if (sessions.size > 0) window.addEventListener('beforeunload', warnBeforeLeaving)
  else window.removeEventListener('beforeunload', warnBeforeLeaving)
}

/**
 * Starts recording an aircraft's live feed on this computer. Call it from a click: the
 * first recording asks for a folder, and a later visit may ask to allow access again.
 */
export async function startRecording(sn: string, label: string): Promise<void> {
  if (!recordingSupported || sessions.has(sn) || starting.has(sn)) return
  starting.add(sn)
  try {
    const dir = folderSupported ? await writableFolder() : null
    if (folderSupported && !dir) return
    if (sessions.has(sn)) return
    // The entry exists first, so a feed that is already playing marks it recording at once.
    useRecordings.setState((state) => ({
      sessions: {
        ...state.sessions,
        [sn]: { label, startedAt: Date.now(), waiting: true, files: 0 },
      },
    }))
    sessions.set(sn, new Session(sn, label, dir))
    syncLeaveWarning()
  } finally {
    starting.delete(sn)
  }
}

/** Stops a recording; the open file is finished and saved. */
export function stopRecording(sn: string): void {
  const session = sessions.get(sn)
  if (!session) return
  sessions.delete(sn)
  useRecordings.setState((state) => {
    const rest = { ...state.sessions }
    delete rest[sn]
    return { sessions: rest }
  })
  session.stop()
  syncLeaveWarning()
}

export function stopAllRecordings(): void {
  for (const sn of [...sessions.keys()]) stopRecording(sn)
}
