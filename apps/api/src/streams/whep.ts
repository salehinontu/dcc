import { randomUUID } from 'node:crypto'
import { can } from '@dji/protocol'
import { publicUser } from '../auth'
import { config } from '../config'
import type { Store, StreamRow } from '../store'

interface WhepSession {
  id: string
  /** Resolved upstream session URL, used for the media server's DELETE. */
  upstream: string
  userId: string
  streamId: string
  createdAt: number
  sessionVersion: number
  expiresAt: number
}

export type WhepOpenResult =
  { ok: true; sessionId: string; answer: string } | { ok: false; error: 'unavailable' }

const MAX_SESSIONS_PER_USER = 16
const OPEN_TIMEOUT_MS = 10_000
const CLOSE_TIMEOUT_MS = 5_000

function closeUpstream(url: string, timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
  return fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(timeoutMs) })
    .then(() => undefined)
    .catch(() => undefined)
}

/**
 * WHEP sessions created through the API. The browser only ever sees the API's URL; the
 * stream key and the media server's address stay on the server.
 */
export class WhepSessions {
  private readonly sessions = new Map<string, WhepSession>()

  async open(
    row: StreamRow,
    offer: string,
    userId: string,
    sessionVersion = 0,
    expiresAt = Date.now() + 12 * 60 * 60 * 1000,
  ): Promise<WhepOpenResult> {
    // Only config values and the row's key reach the URL, so a client cannot redirect it.
    const upstream = config.media.whepInternalTemplate.replace(
      '{key}',
      encodeURIComponent(row.stream_key),
    )

    const started = Date.now()
    let response: Response
    try {
      response = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/sdp' },
        body: offer,
        // Never forward the browser's cookies, authorization or other headers.
        signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
      })
    } catch {
      console.log(`[whep] answer stream=${row.id} ms=${Date.now() - started} status=error`)
      return { ok: false, error: 'unavailable' }
    }

    console.log(
      `[whep] answer stream=${row.id} ms=${Date.now() - started} status=${response.status}`,
    )

    if (response.status !== 200 && response.status !== 201) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: false, error: 'unavailable' }
    }

    const answer = await response.text()
    if (!answer.startsWith('v=')) return { ok: false, error: 'unavailable' }

    const location = response.headers.get('location')
    // A revocable upstream resource is required before disclosing an SDP answer.
    if (!location) return { ok: false, error: 'unavailable' }
    let resolved: URL
    try {
      resolved = new URL(location, upstream)
      if (resolved.origin !== new URL(upstream).origin) return { ok: false, error: 'unavailable' }
    } catch {
      return { ok: false, error: 'unavailable' }
    }
    const sessionId = randomUUID()
    this.enforceCap(userId)
    this.sessions.set(sessionId, {
      id: sessionId,
      upstream: resolved.toString(),
      userId,
      streamId: row.id,
      createdAt: Date.now(),
      sessionVersion,
      expiresAt,
    })

    return { ok: true, sessionId, answer }
  }

  /** Returns false when the session does not exist or belongs to someone else. */
  async close(streamId: string, sessionId: string, userId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || session.streamId !== streamId || session.userId !== userId) return false
    this.sessions.delete(sessionId)
    await closeUpstream(session.upstream)
    return true
  }

  closeAll(): void {
    for (const session of [...this.sessions.values()])
      void this.close(session.streamId, session.id, session.userId)
  }

  closeForStream(streamId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.streamId !== streamId) continue
      this.sessions.delete(id)
      void closeUpstream(session.upstream)
    }
  }

  /** Media can outlive its signalling WebSocket; enforce access independently. */
  async revalidate(store: Store): Promise<void> {
    const closing: Promise<unknown>[] = []
    for (const session of [...this.sessions.values()]) {
      const owner = await store.findUserById(session.userId)
      const stream = await store.getStream(session.streamId)
      if (
        !owner ||
        owner.disabled ||
        owner.must_change_password ||
        owner.session_version !== session.sessionVersion ||
        Date.now() >= session.expiresAt ||
        !stream ||
        stream.state !== 'live' ||
        !can(publicUser(owner), 'streams.view', stream.device_sn) ||
        (await store.deviceUnavailable(stream.device_sn))
      ) {
        closing.push(this.close(session.streamId, session.id, session.userId))
      }
    }
    await Promise.allSettled(closing)
  }

  owns(streamId: string, sessionId: string, userId: string): boolean {
    const session = this.sessions.get(sessionId)
    return session?.streamId === streamId && session.userId === userId
  }

  closeForUser(userId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.userId !== userId) continue
      this.sessions.delete(id)
      void closeUpstream(session.upstream)
    }
  }

  count(): number {
    return this.sessions.size
  }

  private enforceCap(userId: string): void {
    const mine = [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt)
    while (mine.length >= MAX_SESSIONS_PER_USER) {
      const oldest = mine.shift()
      if (!oldest) break
      this.sessions.delete(oldest.id)
      void closeUpstream(oldest.upstream)
    }
  }
}
