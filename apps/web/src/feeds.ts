import { api } from './api'
import { withBase } from './base'

export type FeedStatus = 'connecting' | 'playing' | 'reconnecting' | 'failed'

type ConnectionHint = { saveData?: boolean; effectiveType?: string }

const BACKOFF_SECONDS = [1, 2, 4, 8, 10] as const
const FIRST_FRAME_TIMEOUT_MS = 15_000
const FIRST_FRAME_POLL_MS = 250
const STALL_CHECK_MS = 2_000
const STALL_CHECKS = 3
const DISCONNECTED_GRACE_MS = 4_000
const RESET_BACKOFF_AFTER_MS = 10_000
const OFFER_TIMEOUT_MS = 15_000
// A player that unmounts while another mounts in the same render (tile → focus) hands the
// connection over instead of renegotiating it.
const RELEASE_GRACE_MS = 1_500

/** What players and recorders see of a connection. */
export interface Feed {
  readonly streamId: string
  readonly status: FeedStatus
  /** The received media. A reconnect replaces it with a new MediaStream. */
  readonly stream: MediaStream | null
  subscribe(listener: () => void): () => void
}

interface FeedEntry extends Feed {
  status: FeedStatus
  stream: MediaStream | null
  refs: number
  listeners: Set<() => void>
  releaseTimer: number | undefined
  close: () => void
}

const feeds = new Map<string, FeedEntry>()

/**
 * Shares one WHEP connection per stream across everything on the page that shows or
 * records it, so a page never holds two media sessions for the same stream. Release it
 * with `releaseFeed`.
 */
export function acquireFeed(streamId: string): Feed {
  let feed = feeds.get(streamId)
  // A connection the server refused stays refused; a fresh viewer gets a fresh attempt.
  if (feed && feed.refs === 0 && feed.status === 'failed') {
    window.clearTimeout(feed.releaseTimer)
    feed.close()
    feeds.delete(streamId)
    feed = undefined
  }
  if (!feed) {
    const listeners = new Set<() => void>()
    const created: FeedEntry = {
      streamId,
      status: 'connecting',
      stream: null,
      refs: 0,
      listeners,
      releaseTimer: undefined,
      close: () => undefined,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    feeds.set(streamId, created)
    created.close = connectFeed(created)
    feed = created
  }
  window.clearTimeout(feed.releaseTimer)
  feed.releaseTimer = undefined
  feed.refs += 1
  return feed
}

export function releaseFeed(handle: Feed): void {
  const feed = feeds.get(handle.streamId)
  if (!feed || feed !== handle || feed.refs === 0) return
  feed.refs -= 1
  if (feed.refs > 0) return
  feed.releaseTimer = window.setTimeout(() => {
    if (feed.refs > 0) return
    feed.close()
    if (feeds.get(feed.streamId) === feed) feeds.delete(feed.streamId)
  }, RELEASE_GRACE_MS)
}

/**
 * Runs one connection: the browser posts its SDP offer to the API, which proxies to the
 * internal media server, so the stream key never reaches this code. Retries with backoff,
 * and reconnects when frames stop arriving. Returns the function that closes it.
 */
function connectFeed(feed: FeedEntry): () => void {
  const streamId = feed.streamId
  let disposed = false
  let previousNetwork: { received: number; lost: number; frames: number } | undefined
  let networkBusy = false
  let generation = 0
  let attempt = 0
  let reconnecting = false
  let peer: RTCPeerConnection | null = null
  let sessionUrl: string | null = null
  let firstFrameTimer: number | undefined
  let firstFramePoll: number | undefined
  let stallTimer: number | undefined
  let reconnectTimer: number | undefined
  let disconnectTimer: number | undefined
  let resetTimer: number | undefined
  let lastFrames = -1
  let stalled = 0

  const update = (status: FeedStatus, stream: MediaStream | null = feed.stream): void => {
    if (feed.status === status && feed.stream === stream) return
    feed.status = status
    feed.stream = stream
    for (const listener of [...feed.listeners]) listener()
  }

  const networkTimer = window.setInterval(() => {
    if (!peer || !sessionUrl || disposed || networkBusy) return
    networkBusy = true
    const current = peer
    const url = sessionUrl
    void current
      .getStats()
      .then(async (stats) => {
        if (disposed || peer !== current || sessionUrl !== url) return
        let inbound: RTCInboundRtpStreamStats | undefined
        stats.forEach((entry) => {
          if (entry.type === 'inbound-rtp' && entry.kind === 'video')
            inbound = entry as RTCInboundRtpStreamStats
        })
        if (!inbound) return
        const received = inbound.packetsReceived ?? 0
        const lost = inbound.packetsLost ?? 0
        const frames = inbound.framesDecoded ?? 0
        const deltaReceived = previousNetwork ? Math.max(0, received - previousNetwork.received) : 0
        const deltaLost = previousNetwork ? Math.max(0, lost - previousNetwork.lost) : 0
        const stalled = previousNetwork !== undefined && frames === previousNetwork.frames
        previousNetwork = { received, lost, frames }
        // Only an explicit low-data signal is sent. The browser's `downlink` estimate comes from
        // HTTP transfers, not this media, and read low enough to hold healthy walls at Smooth.
        const hint = (navigator as Navigator & { connection?: ConnectionHint }).connection
        const downlink =
          hint?.saveData || ['slow-2g', '2g'].includes(hint?.effectiveType ?? '') ? 0.5 : undefined
        await api.reportNetwork(streamId, {
          sessionId: url.split('/').pop()!,
          ...(typeof downlink === 'number' && Number.isFinite(downlink)
            ? { downlinkMbps: downlink }
            : {}),
          concurrentStreams: Math.max(1, feeds.size),
          loss: deltaLost / Math.max(1, deltaReceived + deltaLost),
          stalled,
        })
      })
      .catch(() => undefined)
      .finally(() => {
        networkBusy = false
      })
  }, 10_000)

  const stopFirstFramePoll = (): void => {
    if (firstFramePoll === undefined) return
    window.clearInterval(firstFramePoll)
    firstFramePoll = undefined
  }

  const stopTimers = (): void => {
    for (const timer of [
      firstFrameTimer,
      stallTimer,
      reconnectTimer,
      disconnectTimer,
      resetTimer,
    ]) {
      if (timer !== undefined) window.clearTimeout(timer)
    }
    stopFirstFramePoll()
    firstFrameTimer = undefined
    stallTimer = undefined
    reconnectTimer = undefined
    disconnectTimer = undefined
    resetTimer = undefined
  }

  const deleteSession = (): void => {
    if (!sessionUrl) return
    const url = sessionUrl
    sessionUrl = null
    void fetch(url, {
      method: 'DELETE',
      credentials: 'include',
      keepalive: true,
    }).catch(() => undefined)
  }

  const stopWatchdog = (): void => {
    if (stallTimer === undefined) return
    window.clearInterval(stallTimer)
    stallTimer = undefined
  }

  const closePeer = (): void => {
    if (peer) {
      try {
        peer.close()
      } catch {
        // already closed
      }
      peer = null
    }
    previousNetwork = undefined
    lastFrames = -1
    stalled = 0
    update(feed.status, null)
  }

  const teardown = (): void => {
    // Invalidate any in-flight offer: its answer may still create a media session.
    generation += 1
    stopWatchdog()
    stopFirstFramePoll()
    window.clearTimeout(disconnectTimer)
    disconnectTimer = undefined
    deleteSession()
    closePeer()
  }

  const scheduleReconnect = (): void => {
    if (disposed || reconnecting) return
    reconnecting = true

    teardown()
    window.clearTimeout(firstFrameTimer)
    window.clearTimeout(resetTimer)
    firstFrameTimer = undefined
    resetTimer = undefined
    update('reconnecting')

    const delay = (BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)] ?? 10) * 1000
    attempt += 1
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined
      reconnecting = false
      void connect()
    }, delay)
  }

  const decodedFrames = async (current: RTCPeerConnection): Promise<number> => {
    const stats = await current.getStats()
    let frames = -1
    stats.forEach((value) => {
      const report = value as { type?: string; kind?: string; framesDecoded?: number }
      if (
        report.type === 'inbound-rtp' &&
        report.kind === 'video' &&
        typeof report.framesDecoded === 'number'
      ) {
        frames = report.framesDecoded
      }
    })
    return frames
  }

  const startWatchdog = (gen: number): void => {
    if (stallTimer !== undefined) return
    stallTimer = window.setInterval(() => {
      const current = peer
      if (disposed || gen !== generation || !current) return

      void decodedFrames(current)
        .then((frames) => {
          if (disposed || gen !== generation) return
          if (frames < 0) return

          if (frames > lastFrames) {
            lastFrames = frames
            stalled = 0
            return
          }

          stalled += 1
          if (stalled >= STALL_CHECKS) {
            stopWatchdog()
            if (sessionUrl) {
              void api
                .reportNetwork(streamId, {
                  sessionId: sessionUrl.split('/').pop()!,
                  concurrentStreams: Math.max(1, feeds.size),
                  loss: 0,
                  stalled: true,
                })
                .catch(() => undefined)
                .finally(scheduleReconnect)
            } else scheduleReconnect()
          }
        })
        .catch(() => undefined)
    }, STALL_CHECK_MS)
  }

  const connect = async (): Promise<void> => {
    if (disposed) return

    const gen = ++generation
    update(attempt === 0 ? 'connecting' : 'reconnecting')

    const current = new RTCPeerConnection({ bundlePolicy: 'max-bundle' })
    peer = current
    current.addTransceiver('video', { direction: 'recvonly' })
    current.addTransceiver('audio', { direction: 'recvonly' })

    current.ontrack = (event) => {
      if (disposed || gen !== generation) return
      const received = event.streams[0]
      if (received) update(feed.status, received)
      else if (feed.stream) feed.stream.addTrack(event.track)
      else update(feed.status, new MediaStream([event.track]))
    }

    current.onconnectionstatechange = () => {
      if (disposed || gen !== generation) return
      const state = current.connectionState

      if (state === 'failed') {
        scheduleReconnect()
        return
      }
      if (state === 'disconnected') {
        if (disconnectTimer !== undefined) return
        disconnectTimer = window.setTimeout(() => {
          disconnectTimer = undefined
          if (current.connectionState !== 'connected') scheduleReconnect()
        }, DISCONNECTED_GRACE_MS)
        return
      }
      if (state === 'connected' && disconnectTimer !== undefined) {
        window.clearTimeout(disconnectTimer)
        disconnectTimer = undefined
      }
    }

    // The connection counts as playing once the first frame is decoded. Asking the stats,
    // rather than a <video>, lets a recorder with no element on screen use it too.
    const onFirstFrame = (): void => {
      if (disposed || gen !== generation) return
      stopFirstFramePoll()
      window.clearTimeout(firstFrameTimer)
      firstFrameTimer = undefined
      update('playing')
      window.clearTimeout(resetTimer)
      resetTimer = window.setTimeout(() => {
        if (gen === generation) attempt = 0
      }, RESET_BACKOFF_AFTER_MS)
      startWatchdog(gen)
    }

    stopFirstFramePoll()
    firstFramePoll = window.setInterval(() => {
      if (disposed || gen !== generation) {
        stopFirstFramePoll()
        return
      }
      void decodedFrames(current)
        .then((frames) => {
          if (frames > 0 && firstFramePoll !== undefined) onFirstFrame()
        })
        .catch(() => undefined)
    }, FIRST_FRAME_POLL_MS)

    firstFrameTimer = window.setTimeout(() => {
      if (gen === generation && !disposed) scheduleReconnect()
    }, FIRST_FRAME_TIMEOUT_MS)

    try {
      const offer = await current.createOffer()
      await current.setLocalDescription(offer)
      if (disposed || gen !== generation) return

      const response = await fetch(withBase(`/api/streams/${encodeURIComponent(streamId)}/whep`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/sdp' },
        body: offer.sdp,
        signal: AbortSignal.timeout(OFFER_TIMEOUT_MS),
      })
      if (disposed || gen !== generation) {
        // The attempt was torn down while the answer was in flight. Release the media
        // session it created instead of leaking it on the server.
        if (response.status === 201) {
          const staleLocation = response.headers.get('location')
          if (staleLocation) {
            void fetch(new URL(staleLocation, response.url).toString(), {
              method: 'DELETE',
              credentials: 'include',
              keepalive: true,
            }).catch(() => undefined)
          }
        }
        return
      }

      if (response.status === 201) {
        const location = response.headers.get('location')
        sessionUrl = location ? new URL(location, response.url).toString() : null
        const answer = await response.text()
        if (disposed || gen !== generation) return
        await current.setRemoteDescription({ type: 'answer', sdp: answer })
        return
      }

      // 409 means the stream is not live yet; the server will broadcast it.
      if (response.status === 409) {
        scheduleReconnect()
        return
      }

      // Bad or expired session: retrying cannot fix it.
      if (response.status === 401 || response.status === 403) {
        teardown()
        window.clearTimeout(firstFrameTimer)
        firstFrameTimer = undefined
        update('failed')
        return
      }

      scheduleReconnect()
    } catch {
      if (disposed || gen !== generation) return
      scheduleReconnect()
    }
  }

  void connect()

  return () => {
    disposed = true
    window.clearInterval(networkTimer)
    generation += 1
    stopTimers()
    teardown()
  }
}
