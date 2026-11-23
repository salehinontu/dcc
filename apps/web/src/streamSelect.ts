import type { StreamState } from '@dji/protocol'

/**
 * The one stream to show for an aircraft: newest live, else newest starting, else the
 * newest row of any phase so "stopped by an administrator" and errors remain visible.
 */
export function streamForDevice(
  streams: Record<string, StreamState>,
  sn: string,
): StreamState | undefined {
  let live: StreamState | undefined
  let starting: StreamState | undefined
  let newest: StreamState | undefined

  for (const stream of Object.values(streams)) {
    if (stream.deviceSn !== sn) continue
    if (!newest || stream.updatedAt > newest.updatedAt) newest = stream
    if (stream.phase === 'live' && (!live || stream.updatedAt > live.updatedAt)) live = stream
    if (stream.phase === 'starting' && (!starting || stream.updatedAt > starting.updatedAt)) {
      starting = stream
    }
  }

  return live ?? starting ?? newest
}
