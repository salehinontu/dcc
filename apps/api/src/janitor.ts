import { mkdir, statfs } from 'node:fs/promises'
import type { RecordingStorage } from '@dji/protocol'
import { config } from './config'
import type { VideoLibrary } from './recordings/library'
import type { RecordingPlace } from './recordings/place'
import type { RecordingManager } from './recordings/recorder'
import type { AutoClipRow } from './recordings/store'
import type { Store } from './store'

const DAY_MS = 24 * 3600_000
const HOUR_MS = 3600_000

export interface JanitorOptions {
  /** RECORDING_DIR: the disk whose free space is watched. */
  dir: string
  /** Automatic clips older than this many days are deleted; 0 keeps them until room is needed. */
  retentionDays: number
  /** The most the recordings may use; 0 means no limit but the free-space floor. */
  maxBytes: number
  /** The floor: the oldest automatic clips go, then recording pauses, before the disk goes below this. */
  minFreeBytes: number
  intervalSeconds: number
  autoDefault: boolean
  /** Telemetry readings older than this are deleted; 0 keeps them. */
  telemetryRetentionDays: number
  /** Raw MQTT log lines older than this are deleted; 0 keeps them (the default). */
  mqttLogRetentionDays: number
  /** Free and total bytes of the disk; a test replaces this. */
  freeSpace?: () => Promise<{ free: number; total: number } | null>
}

export function janitorOptionsFromConfig(place?: RecordingPlace): JanitorOptions {
  return {
    // Read every minute, so the disk watched is always the one the videos are being saved on.
    get dir() {
      return place?.dir ?? config.recordings.dir
    },
    retentionDays: config.recordings.retentionDays,
    maxBytes: config.recordings.maxBytes,
    minFreeBytes: config.recordings.minFreeBytes,
    intervalSeconds: config.recordings.cleanupSeconds,
    autoDefault: config.recordings.autoDefault,
    telemetryRetentionDays: config.telemetry.retentionDays,
    mqttLogRetentionDays: config.telemetry.mqttLogRetentionDays,
  }
}

async function diskSpace(dir: string): Promise<{ free: number; total: number } | null> {
  try {
    // The folder does not exist until the first clip is written; make it, so the free space of the disk
    // it will be on is known from the start and the guard is never blind.
    await mkdir(dir, { recursive: true })
    const fs = await statfs(dir)
    return { free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize }
  } catch {
    return null
  }
}

/**
 * What keeps a server that records for weeks from breaking. Every minute it
 *  - deletes AUTOMATIC clips older than the retention (a manual recording or an upload is never
 *    deleted by it),
 *  - deletes the oldest automatic clips while the recordings are over their size limit or the disk
 *    has less free than the floor,
 *  - and when that is not enough (nothing automatic left to delete) pauses recording, which carries
 *    on by itself once there is room again, so the disk never fills and takes the database with it.
 * Once an hour it also trims the tables that would otherwise grow for good, but only when a retention
 * is set for them: the raw MQTT log and telemetry are kept by default.
 */
export class Janitor {
  private timer: NodeJS.Timeout | undefined
  private running = false
  private lastTables = 0
  private lastCleanup: RecordingStorage['lastCleanup'] = null

  constructor(
    private readonly deps: { store: Store; recorder: RecordingManager; library: VideoLibrary },
    private readonly opts: JanitorOptions,
  ) {}

  /** Runs now and then every `intervalSeconds`. */
  start(): void {
    if (this.timer) return
    const tick = (): void =>
      void this.run().catch((error) => console.error('[cleanup] failed', error))
    tick()
    this.timer = setInterval(tick, this.opts.intervalSeconds * 1000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private free(): Promise<{ free: number; total: number } | null> {
    return this.opts.freeSpace ? this.opts.freeSpace() : diskSpace(this.opts.dir)
  }

  private async remove(row: AutoClipRow): Promise<boolean> {
    // The row first: a clip nobody can list is better than a listed one whose file is gone.
    const gone = await this.deps.store.recordings.remove(row.id)
    if (!gone) return false
    await this.deps.library.deleteFiles(gone).catch(() => undefined)
    return true
  }

  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const { store, recorder } = this.deps
      let clips = 0
      let bytes = 0
      const reasons: string[] = []
      const drop = async (rows: AutoClipRow[]): Promise<void> => {
        for (const row of rows)
          if (await this.remove(row)) {
            clips++
            bytes += row.size_bytes
          }
      }

      // 1. Older than the retention.
      if (this.opts.retentionDays > 0) {
        const cutoff = new Date(Date.now() - this.opts.retentionDays * DAY_MS)
        const before = clips
        for (;;) {
          const rows = await store.recordings.expiredAuto(cutoff, 200)
          if (rows.length === 0) break
          await drop(rows)
          if (rows.length < 200) break
        }
        if (clips > before) reasons.push(`older than ${this.opts.retentionDays} days`)
      }

      // 2. Over the size limit: the oldest go first, down to 97 % so it is not at the edge again at once.
      let used = (await store.recordings.usage()).usedBytes
      if (this.opts.maxBytes > 0 && used > this.opts.maxBytes) {
        const before = clips
        const target = this.opts.maxBytes * 0.97
        while (used > target) {
          const rows = await store.recordings.oldestAuto(25)
          if (rows.length === 0) break
          for (const row of rows) {
            if (used <= target) break
            if (await this.remove(row)) {
              clips++
              bytes += row.size_bytes
              used -= row.size_bytes
            }
          }
        }
        if (clips > before) reasons.push('over the size limit')
      }

      // 3. Under the free-space floor: clear to 25 % above it.
      let space = await this.free()
      if (space && space.free < this.opts.minFreeBytes) {
        const before = clips
        const target = this.opts.minFreeBytes * 1.25
        while (space && space.free < target) {
          const rows = await store.recordings.oldestAuto(25)
          if (rows.length === 0) break
          // One at a time, looking at the disk after each: a clip can be gigabytes, and only as many
          // as are needed should go.
          for (const row of rows) {
            if (await this.remove(row)) {
              clips++
              bytes += row.size_bytes
            }
            space = await this.free()
            if (!space || space.free >= target) break
          }
        }
        if (clips > before) reasons.push('the disk was nearly full')
      }

      // 4. If that was not enough, recording pauses rather than fills the disk; it resumes by itself.
      used = (await store.recordings.usage()).usedBytes
      const low = space != null && space.free < this.opts.minFreeBytes
      const over = this.opts.maxBytes > 0 && used > this.opts.maxBytes
      recorder.setPaused(
        low
          ? 'The disk is almost full and no automatic recording is left to clear. Delete recordings or add disk space.'
          : over
            ? 'The recordings reached their size limit and no automatic recording is left to clear. Delete recordings or raise the limit.'
            : null,
      )

      if (clips > 0) {
        const why = reasons.join(', ')
        this.lastCleanup = { at: new Date().toISOString(), clips, bytes, reason: why }
        console.log(
          `[cleanup] deleted ${clips} automatic clip(s), ${(bytes / 1024 ** 3).toFixed(2)} GB: ${why}`,
        )
        await store
          .logDeviceEvent(null, 'recording.cleaned', { clips, bytes, reason: why })
          .catch(() => undefined)
      }

      // 5. Tables that would grow for good.
      if (Date.now() - this.lastTables >= HOUR_MS) {
        this.lastTables = Date.now()
        const logs =
          this.opts.mqttLogRetentionDays > 0
            ? await store.pruneMqttLog(this.opts.mqttLogRetentionDays)
            : 0
        const readings =
          this.opts.telemetryRetentionDays > 0
            ? await store.pruneTelemetry(this.opts.telemetryRetentionDays)
            : 0
        if (logs + readings > 0)
          console.log(
            `[cleanup] removed ${logs} MQTT log line(s) and ${readings} telemetry reading(s)`,
          )
      }
    } finally {
      this.running = false
    }
  }

  /** The figures behind the storage panel. */
  async status(): Promise<RecordingStorage> {
    const usage = await this.deps.store.recordings.usage()
    const space = await this.free()
    const iso = (value: Date | string | null): string | null =>
      value ? new Date(value).toISOString() : null
    const freeBytes = space?.free ?? null
    // How long the room lasts at the last 24 hours' pace, before the floor; after that the oldest
    // automatic footage goes.
    const daysLeft =
      freeBytes != null && usage.bytesLast24h > 0
        ? Math.max(0, (freeBytes - this.opts.minFreeBytes) / usage.bytesLast24h)
        : null
    return {
      usedBytes: usage.usedBytes,
      autoBytes: usage.autoBytes,
      clips: usage.clips,
      oldestAutoAt: iso(usage.oldestAutoAt),
      newestAt: iso(usage.newestAt),
      bytesLast24h: usage.bytesLast24h,
      freeBytes,
      diskBytes: space?.total ?? null,
      retentionDays: this.opts.retentionDays,
      maxBytes: this.opts.maxBytes,
      minFreeBytes: this.opts.minFreeBytes,
      autoDefault: this.opts.autoDefault,
      paused: this.deps.recorder.isPaused,
      pausedReason: this.deps.recorder.pausedReason,
      daysLeft,
      lastCleanup: this.lastCleanup,
    }
  }
}
