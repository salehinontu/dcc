import { randomBytes, randomUUID } from 'node:crypto'
import {
  channels,
  LiveMethod,
  UrlType,
  videoId as makeVideoId,
  type CameraSummary,
  type VideoType,
} from '@dji/protocol'
import { config, rtmpUrl } from '../config'
import type { Hub } from '../hub'
import type { MqttBridge } from '../mqtt'
import type { Store, StreamRow } from '../store'
import { AdaptiveQuality, type NetworkReport } from './adaptive'
import { kickPublisher } from './media'
import { KeyedMutex } from './mutex'
import { publishStream } from './state'
import type { WhepSessions } from './whep'

const DEFAULT_QUALITY = 2
const MAX_WATCHED_AIRCRAFT = 64
const STOP_REPLY_TIMEOUT_MS = 10_000
const RETRY_DELAYS_MS = [5_000, 20_000] as const

interface RetryState {
  count: number
  timer?: NodeJS.Timeout
}

interface VideoChoice {
  cameraIndex: string
  videoIndex: string
}

function pickVideo(cameras: CameraSummary[] | null): VideoChoice | null {
  const camera = cameras?.[0]
  if (!camera) return null
  const video =
    camera.videos.find((entry) => entry.videoIndex.startsWith('normal')) ?? camera.videos[0]
  if (!video) return null
  return { cameraIndex: camera.cameraIndex, videoIndex: video.videoIndex }
}

function resultFrom(message: string): string {
  const match = message.match(/result (\d+)/)
  return match?.[1] ?? 'error'
}

function msSince(row: StreamRow): number {
  const started = new Date(row.started_at).getTime()
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0
}

export class StreamManager {
  private readonly adaptive = new AdaptiveQuality()
  private readonly mutex = new KeyedMutex()
  private readonly viewers = new Map<string, Set<string>>()
  private readonly byConn = new Map<string, Set<string>>()
  private readonly lingers = new Map<string, NodeJS.Timeout>()
  private readonly holds = new Set<string>()
  private readonly retries = new Map<string, RetryState>()
  private recovered = false

  constructor(
    private readonly deps: {
      store: Store
      bridge: MqttBridge
      hub: Hub
      whep: WhepSessions
    },
  ) {}

  private get store(): Store {
    return this.deps.store
  }

  private get bridge(): MqttBridge {
    return this.deps.bridge
  }

  private get hub(): Hub {
    return this.deps.hub
  }

  private get whep(): WhepSessions {
    return this.deps.whep
  }

  // ---------- viewer tracking ----------

  watch(connId: string, sns: string[]): void {
    let owned = this.byConn.get(connId)
    if (!owned) {
      owned = new Set()
      this.byConn.set(connId, owned)
    }

    for (const sn of sns) {
      if (owned.size >= MAX_WATCHED_AIRCRAFT && !owned.has(sn)) continue
      if (owned.has(sn)) continue
      owned.add(sn)

      let set = this.viewers.get(sn)
      if (!set) {
        set = new Set()
        this.viewers.set(sn, set)
      }
      set.add(connId)
      this.cancelLinger(sn)
      void this.ensure(sn).catch((error) => console.error('[stream] ensure failed', error))
    }
  }

  unwatch(connId: string, sns: string[]): void {
    const owned = this.byConn.get(connId)
    for (const sn of sns) {
      if (!owned?.delete(sn)) continue
      const set = this.viewers.get(sn)
      if (!set?.delete(connId)) continue
      if (set.size > 0) continue

      this.viewers.delete(sn)
      // An admin hold only lasts until every viewer has left.
      this.holds.delete(sn)
      this.scheduleLinger(sn)
    }
    if (owned?.size === 0) this.byConn.delete(connId)
  }

  dropConnection(connId: string): void {
    const owned = this.byConn.get(connId)
    if (!owned) return
    this.unwatch(connId, [...owned])
  }

  retry(connId: string, sn: string): void {
    if (!this.byConn.get(connId)?.has(sn)) return
    this.clearRetry(sn)
    void this.ensure(sn).catch((error) => console.error('[stream] ensure failed', error))
  }

  private hasViewers(sn: string): boolean {
    return (this.viewers.get(sn)?.size ?? 0) > 0
  }

  private scheduleLinger(sn: string): void {
    this.cancelLinger(sn)
    if (this.holds.has(sn)) return

    const timer = setTimeout(() => {
      this.lingers.delete(sn)
      if (this.hasViewers(sn)) return
      void this.store
        .isVideoSource(sn)
        // A video-only drone's push belongs to its pilot; nobody watching does not end it.
        .then((source) => (source ? undefined : this.stopDevice(sn, 'no viewers', true)))
        .catch((error) => console.error('[stream] linger stop failed', error))
    }, config.stream.lingerSeconds * 1000)
    timer.unref()
    this.lingers.set(sn, timer)
  }

  private cancelLinger(sn: string): void {
    const timer = this.lingers.get(sn)
    if (!timer) return
    clearTimeout(timer)
    this.lingers.delete(sn)
  }

  // ---------- start / stop ----------

  async ensure(sn: string): Promise<void> {
    const device = await this.store.deviceForStream(sn)
    const gatewaySn = device?.gateway_sn
    if (!gatewaySn) return
    await this.mutex.run(gatewaySn, () => this.ensureLocked(sn, gatewaySn))
  }

  private async ensureLocked(sn: string, gatewaySn: string): Promise<void> {
    if (!this.hasViewers(sn) || this.holds.has(sn)) return

    // Everything is re-checked inside the lock: the device may have gone offline, the
    // aircraft may have been stopped, or another caller may have created the row.
    const device = await this.store.deviceForStream(sn)
    if (!device?.online || device.gateway_sn !== gatewaySn) return

    const choice = pickVideo(device.cameras)
    if (!choice) return

    const video = makeVideoId(sn, choice.cameraIndex, choice.videoIndex)
    if (await this.store.activeStreamFor(sn, video)) return

    const id = randomUUID()
    const streamKey = randomBytes(16).toString('base64url')
    const row = await this.store.createStream({
      id,
      deviceSn: sn,
      videoId: video,
      streamKey,
      quality: DEFAULT_QUALITY,
      requestedBy: null,
    })
    if (!row) return

    console.log(`[stream] create id=${id} sn=${sn} video=${video}`)
    publishStream(this.hub, row)

    const payload = {
      url_type: UrlType.rtmp,
      url: rtmpUrl(streamKey),
      video_id: video,
      video_quality: DEFAULT_QUALITY,
    }
    const sentAt = Date.now()

    try {
      await this.bridge.callService(
        gatewaySn,
        LiveMethod.start,
        payload,
        config.stream.replyTimeoutMs,
      )
      console.log(`[stream] reply id=${id} ms=${Date.now() - sentAt} result=0`)
      return
    } catch (error) {
      let message = error instanceof Error ? error.message : 'start failed'
      console.log(`[stream] reply id=${id} ms=${Date.now() - sentAt} result=${resultFrom(message)}`)

      // A reply timeout is not a failure: the RC may still be connecting. The sweeper's
      // start deadline is the authority on that.
      if (/timed out/i.test(message)) return

      if (/rejected with result/.test(message)) {
        // Usually means the RC is still pushing a stream the API forgot about. Clear it,
        // then try once more inside the same lock.
        await this.bridge
          .callService(gatewaySn, LiveMethod.stop, { video_id: video }, STOP_REPLY_TIMEOUT_MS)
          .catch(() => undefined)
        try {
          await this.bridge.callService(
            gatewaySn,
            LiveMethod.start,
            payload,
            config.stream.replyTimeoutMs,
          )
          console.log(`[stream] reply id=${id} ms=${Date.now() - sentAt} result=0`)
          return
        } catch (retryError) {
          message = retryError instanceof Error ? retryError.message : 'start failed'
          if (/timed out/i.test(message)) return
        }
      }

      const failed = await this.store.failStream(id, message)
      if (!failed) return
      console.log(`[stream] error id=${id} reason=${message}`)
      publishStream(this.hub, failed)
      this.scheduleRetry(sn)
    }
  }

  async adminStop(sn: string, by: string): Promise<void> {
    this.holds.add(sn)
    this.clearRetry(sn)
    this.cancelLinger(sn)
    console.log(`[stream] hold sn=${sn} by=${by}`)

    const device = await this.store.deviceForStream(sn)
    const gatewaySn = device?.gateway_sn
    const reason = 'stopped by an administrator'
    // The lock keeps this stop ordered with other gateway commands, but the HTTP response
    // does not wait for the controller to acknowledge it.
    const running = gatewaySn
      ? this.mutex.run(gatewaySn, () => this.stopLocked(sn, reason, true, gatewaySn))
      : this.stopLocked(sn, reason, true, null)
    void running.catch((error) => console.error('[stream] admin stop failed', error))
  }

  async adminResume(sn: string): Promise<void> {
    this.holds.delete(sn)
    this.clearRetry(sn)
    void this.ensure(sn).catch((error) => console.error('[stream] resume failed', error))
  }

  /**
   * Stops every active row for a device, broadcasts first, then asks the RC to stop. The UI
   * never waits on the controller.
   */
  async stopDevice(sn: string, reason: string, sendCommand: boolean): Promise<void> {
    const device = await this.store.deviceForStream(sn)
    const gatewaySn = device?.gateway_sn ?? (await this.store.deviceGatewaySn(sn))

    if (gatewaySn) {
      await this.mutex.run(gatewaySn, () => this.stopLocked(sn, reason, sendCommand, gatewaySn))
      return
    }
    await this.stopLocked(sn, reason, sendCommand, null)
  }

  private async stopLocked(
    sn: string,
    reason: string,
    sendCommand: boolean,
    gatewaySn: string | null,
  ): Promise<void> {
    const rows = await this.store.activeStreamsForDevice(sn)
    for (const row of rows) {
      const stopped = await this.store.stopStream(row.id, reason)
      if (!stopped) continue
      console.log(`[stream] stop id=${stopped.id} reason=${reason}`)
      publishStream(this.hub, stopped)
      this.adaptive.remove(stopped.id)
      this.whep.closeForStream(stopped.id)
    }

    if (!sendCommand || !gatewaySn) return
    for (const row of rows) {
      await this.bridge
        .callService(gatewaySn, LiveMethod.stop, { video_id: row.video_id }, STOP_REPLY_TIMEOUT_MS)
        .catch(() => undefined)
    }
  }

  // ---------- media server callbacks ----------

  /** True when the publisher's key belongs to a stream the API is expecting. */
  async canPublish(key: string): Promise<boolean> {
    // A video-only drone's key is its own, fixed address: it may push whenever it is in service.
    const source = await this.store.videoSourceByKey(key)
    if (source) return !source.unavailable
    const row = await this.store.getStreamByKey(key)
    if (!row || (await this.store.deviceUnavailable(row.device_sn))) return false
    if (row.state === 'starting' || row.state === 'live') return true
    if (row.state !== 'error') return false
    return !(await this.store.activeStreamFor(row.device_sn, row.video_id))
  }

  async onPublish(key: string): Promise<boolean> {
    const source = await this.store.videoSourceByKey(key)
    if (source) return source.unavailable ? false : this.sourceLive(source.sn, key)
    const row = await this.store.getStreamByKey(key)
    if (!row || (await this.store.deviceUnavailable(row.device_sn))) return false

    // A stopped row must never come back to life, even if its old key leaks.
    if (row.state !== 'starting' && row.state !== 'live' && row.state !== 'error') return false
    if (row.state === 'error' && (await this.store.activeStreamFor(row.device_sn, row.video_id))) {
      return false
    }

    if (row.state === 'live') return true

    const live = await this.store.markLive(row.id)
    if (!live) return false

    console.log(`[stream] live id=${live.id} ms_since_create=${msSince(live)}`)
    // The controller just (re)started its push: the first seconds say nothing about viewers.
    this.adaptive.settle(live.id, live.quality)
    this.clearRetry(live.device_sn)
    publishStream(this.hub, live)
    return true
  }

  async onUnpublish(key: string): Promise<void> {
    const source = await this.store.videoSourceByKey(key)
    if (source) return this.sourceOff(source.sn, 'publisher stopped')
    const row = await this.store.getStreamByKey(key)
    if (!row) return

    // The media session is gone either way, so release every WHEP session for this stream.
    this.whep.closeForStream(row.id)
    if (row.state !== 'live') return

    const device = await this.store.deviceForStream(row.device_sn)
    if (this.hasViewers(row.device_sn) && device?.online) {
      // Pilot usually re-pushes to the same URL. Keep the viewers registered and let the
      // start deadline apply if the publisher does not come back.
      const reconnecting = await this.store.markReconnecting(row.id)
      if (reconnecting) {
        console.log(`[stream] reconnecting id=${reconnecting.id}`)
        publishStream(this.hub, reconnecting)
      }
      return
    }

    await this.stopDevice(row.device_sn, 'publisher stopped', false)
  }

  // ---------- video-only drones ----------

  private broadcastSourceStatus(sn: string, online: boolean): void {
    this.hub.publish([channels.devices, channels.device(sn)], {
      type: 'device.status',
      data: { sn, gatewaySn: null, online, lastSeenAt: online ? new Date().toISOString() : null },
    })
  }

  /** The pilot's push arrived: the drone is online and its one stream row is live. */
  private async sourceLive(sn: string, key: string): Promise<boolean> {
    const row = await this.store.goLiveSource(sn, key, randomUUID())
    if (!row) return false
    console.log(`[stream] video-only drone live sn=${sn} id=${row.id}`)
    this.broadcastSourceStatus(sn, true)
    publishStream(this.hub, row)
    return true
  }

  /** The push ended (or the drone was taken out of service): stop the row, mark it offline. */
  async sourceOff(sn: string, reason: string): Promise<void> {
    for (const row of await this.store.activeStreamsForDevice(sn)) {
      const stopped = await this.store.stopStream(row.id, reason)
      if (!stopped) continue
      console.log(`[stream] video-only drone off sn=${sn} reason=${reason}`)
      this.whep.closeForStream(stopped.id)
      publishStream(this.hub, stopped)
    }
    await this.store.setDeviceOffline(sn)
    this.broadcastSourceStatus(sn, false)
  }

  /** Ends a running push, for a drone that was disabled, removed or given a new key. */
  async disconnectSource(sn: string, key?: string | null): Promise<void> {
    const pushKey = key ?? (await this.store.videoSourceKey(sn))
    await this.sourceOff(sn, 'drone disabled')
    if (pushKey) await kickPublisher(pushKey)
  }

  // ---------- topology / capacity ----------

  deviceOnline(sn: string, online: boolean): void {
    if (online) {
      this.clearRetry(sn)
      if (this.hasViewers(sn) && !this.holds.has(sn)) {
        void this.ensure(sn).catch((error) => console.error('[stream] ensure failed', error))
      }
      return
    }

    void this.stopDevice(sn, 'drone offline', false).catch((error) =>
      console.error('[stream] offline stop failed', error),
    )
  }

  /**
   * Asks again for a drone's stream, for a viewer that is always there (an automatic recording).
   * An ordinary viewer asks again each time it looks; one that waits for weeks needs this, because
   * the manager only retries a few times and then waits for the drone to announce itself. It does
   * nothing while a retry is already pending or an admin is holding the drone, so a drone that
   * refuses the stream is not asked in a loop.
   */
  kick(sn: string): void {
    if (!this.hasViewers(sn) || this.holds.has(sn) || this.retries.get(sn)?.timer) return
    void this.ensure(sn).catch((error) => console.error('[stream] ensure failed', error))
  }

  capacityChanged(sn: string): void {
    if (!this.hasViewers(sn) || this.holds.has(sn)) return
    void this.ensure(sn).catch((error) => console.error('[stream] ensure failed', error))
  }

  // ---------- admin commands ----------

  async reportNetwork(id: string, viewer: string, report: NetworkReport): Promise<void> {
    const row = await this.store.getStream(id)
    if (!row || row.state !== 'live' || (await this.store.deviceUnavailable(row.device_sn))) return
    const quality = this.adaptive.report(id, viewer, row.quality, report)
    if (quality === null) return
    console.log(
      `[adaptive] id=${id} quality ${row.quality} -> ${quality} (last report: loss=${report.loss.toFixed(3)} stalled=${report.stalled}${report.downlinkMbps === undefined ? '' : ` downlink=${report.downlinkMbps}`})`,
    )
    await this.setQuality(id, quality, true, row.rev)
  }

  async setQuality(
    id: string,
    quality: number,
    automatic = false,
    expectedRev?: number,
  ): Promise<StreamRow | null> {
    const row = await this.store.getStream(id)
    if (!row || (row.state !== 'starting' && row.state !== 'live')) return null

    const device = await this.store.deviceForStream(row.device_sn)
    const gatewaySn = device?.gateway_sn
    if (!gatewaySn) return null

    return this.mutex.run(gatewaySn, async () => {
      const current = await this.store.getStream(id)
      if (
        !current ||
        !['starting', 'live'].includes(current.state) ||
        (await this.store.deviceUnavailable(current.device_sn))
      )
        return null
      if (automatic && current.rev !== expectedRev) return null
      await this.bridge.callService(gatewaySn, LiveMethod.setQuality, {
        video_id: row.video_id,
        video_quality: quality,
      })
      // Persist and broadcast only after the RC accepted the change.
      if (!automatic) this.adaptive.reset(id, quality)
      const updated = await this.store.setStreamQuality(id, quality)
      if (updated) publishStream(this.hub, updated)
      return updated
    })
  }

  async setLens(id: string, videoType: VideoType): Promise<boolean> {
    const row = await this.store.getStream(id)
    if (!row || (row.state !== 'starting' && row.state !== 'live')) return false

    const device = await this.store.deviceForStream(row.device_sn)
    const gatewaySn = device?.gateway_sn
    if (!gatewaySn) return false

    await this.mutex.run(gatewaySn, () =>
      this.bridge.callService(gatewaySn, LiveMethod.lensChange, {
        video_id: row.video_id,
        video_type: videoType,
      }),
    )
    return true
  }

  // ---------- reconciliation ----------

  async sweep(): Promise<void> {
    const deadline = config.stream.startDeadlineSeconds
    for (const row of await this.store.staleStarting(deadline)) {
      const device = await this.store.deviceForStream(row.device_sn)
      const gatewaySn = device?.gateway_sn
      console.log(`[stream] deadline id=${row.id}`)

      const work = async (): Promise<void> => {
        const failed = await this.store.failStream(row.id, `no video within ${deadline} s`)
        if (!failed) return
        publishStream(this.hub, failed)
        if (gatewaySn) {
          await this.bridge
            .callService(
              gatewaySn,
              LiveMethod.stop,
              { video_id: row.video_id },
              STOP_REPLY_TIMEOUT_MS,
            )
            .catch(() => undefined)
        }
        this.scheduleRetry(row.device_sn)
      }

      if (gatewaySn) await this.mutex.run(gatewaySn, work)
      else await work()
    }

    // Rows left active without a viewer or a pending linger (a missed unpublish, for
    // example) are stopped here.
    const orphans = new Set<string>()
    for (const row of await this.store.activeStreams()) {
      if (this.hasViewers(row.device_sn) || this.lingers.has(row.device_sn)) continue
      orphans.add(row.device_sn)
    }
    for (const sn of orphans) {
      if (await this.store.isVideoSource(sn)) continue
      await this.stopDevice(sn, 'no viewers', true)
    }
  }

  async recoverAfterBoot(since: Date): Promise<void> {
    if (this.recovered) return
    this.recovered = true

    for (const row of await this.store.streamsResetAtBoot(since)) {
      const device = await this.store.deviceForStream(row.device_sn)
      const gatewaySn = device?.gateway_sn
      if (!gatewaySn) continue
      await this.bridge
        .callService(gatewaySn, LiveMethod.stop, { video_id: row.video_id }, STOP_REPLY_TIMEOUT_MS)
        .catch(() => undefined)
    }
  }

  dispose(): void {
    for (const timer of this.lingers.values()) clearTimeout(timer)
    this.lingers.clear()
    for (const state of this.retries.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    this.retries.clear()
  }

  private scheduleRetry(sn: string): void {
    if (!this.hasViewers(sn) || this.holds.has(sn)) return

    const state = this.retries.get(sn) ?? { count: 0 }
    this.retries.set(sn, state)
    if (state.count >= RETRY_DELAYS_MS.length) return

    if (state.timer) clearTimeout(state.timer)
    const delay = RETRY_DELAYS_MS[state.count] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
    state.count += 1
    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.ensure(sn).catch((error) => console.error('[stream] retry failed', error))
    }, delay)
    state.timer.unref()
  }

  private clearRetry(sn: string): void {
    const state = this.retries.get(sn)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    this.retries.delete(sn)
  }
}
