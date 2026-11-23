import { config } from '../config'

/**
 * Cuts a publisher off the media server. Disabling, removing or re-keying a video-only drone
 * must end a push that is already running: the publish hook only runs when a push starts.
 *
 * Best effort and SRS only: SRS's HTTP API lives at the origin of the WHEP address
 * (`http://srs:1985`). The development media server has no such API, so there the call does
 * nothing, and a push that is already running simply is not watchable once its stream row stops.
 */
export async function kickPublisher(key: string): Promise<boolean> {
  try {
    const origin = new URL(config.media.whepInternalTemplate.replace('{key}', 'x')).origin
    const timeout = { signal: AbortSignal.timeout(3_000) }
    const listed = await fetch(`${origin}/api/v1/streams`, timeout)
    if (!listed.ok) return false
    const body = (await listed.json()) as {
      streams?: { name?: string; publish?: { active?: boolean; cid?: string } }[]
    }
    const cid = body.streams?.find((entry) => entry.name === key && entry.publish?.active)?.publish
      ?.cid
    if (!cid) return false
    const kicked = await fetch(`${origin}/api/v1/clients/${encodeURIComponent(cid)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3_000),
    })
    return kicked.ok
  } catch {
    return false
  }
}
