import { channels, type StreamPhase, type StreamState } from '@dji/protocol'
import type { Hub } from '../hub'
import { iso, type StreamRow } from '../store'

export function streamState(row: StreamRow): StreamState {
  return {
    id: row.id,
    deviceSn: row.device_sn,
    videoId: row.video_id,
    phase: row.state as StreamPhase,
    quality: row.quality,
    error: row.error,
    startedAt: iso(row.started_at) ?? '',
    updatedAt: iso(row.updated_at) ?? '',
    rev: row.rev,
  }
}

/** The dashboard subscribes to `devices`; keep it in every stream broadcast. */
export function publishStream(hub: Hub, row: StreamRow): void {
  hub.publish([channels.devices, channels.stream(row.id), channels.device(row.device_sn)], {
    type: 'stream.state',
    data: streamState(row),
  })
}
