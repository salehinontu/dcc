import { z } from 'zod'
import type { AlertRecord } from './fleet'
import type { TelemetrySample } from './osd'

export const wsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    channels: z.array(z.string().min(1).max(128)).max(200),
  }),
  z.object({
    type: z.literal('unsubscribe'),
    channels: z.array(z.string().min(1).max(128)).max(200),
  }),
  z.object({
    type: z.literal('watch'),
    sns: z.array(z.string().min(1).max(64)).min(1).max(64),
  }),
  z.object({
    type: z.literal('unwatch'),
    sns: z.array(z.string().min(1).max(64)).min(1).max(64),
  }),
  z.object({ type: z.literal('retry'), sn: z.string().min(1).max(64) }),
  z.object({ type: z.literal('ping') }),
])

export type WsClientMessage = z.infer<typeof wsClientMessageSchema>

export interface CameraSummary {
  cameraIndex: string
  videos: { videoIndex: string; videoType?: string }[]
}

export interface DeviceSummary {
  sn: string
  gatewaySn: string | null
  model: string | null
  displayName: string | null
  /** An optional nickname shown beside the name. */
  label: string | null
  /**
   * A drone with a video feed and nothing else (a DJI Mini streaming RTMP from DJI Fly): no
   * controller, telemetry, position or remote control. The pilot starts and stops the push.
   */
  videoOnly: boolean
  /** The aircraft's colour on the map, as `#rrggbb`. */
  color: string
  online: boolean
  lastSeenAt: string | null
  telemetry: TelemetrySample | null
  cameras: CameraSummary[]
}

export type StreamPhase = 'starting' | 'live' | 'stopped' | 'error'

export interface StreamState {
  id: string
  deviceSn: string
  videoId: string
  phase: StreamPhase
  quality: number
  error: string | null
  startedAt: string
  updatedAt: string
  /** Increments on every row change; clients drop updates with a lower rev. */
  rev: number
}

export type ServerMessage =
  | {
      type: 'device.status'
      data: { sn: string; gatewaySn: string | null; online: boolean; lastSeenAt: string | null }
    }
  | { type: 'device.removed'; data: { sn: string } }
  | { type: 'telemetry'; data: TelemetrySample }
  | { type: 'stream.state'; data: StreamState }
  | { type: 'streams.snapshot'; data: StreamState[] }
  | { type: 'device.cameras'; data: { sn: string; cameras: CameraSummary[] } }
  /** A zone alert was raised, or cleared or acknowledged (same id, newer state). */
  | { type: 'alert'; data: AlertRecord }
  /** Name or colour of an aircraft changed. */
  | {
      type: 'device.profile'
      data: { sn: string; displayName: string | null; label: string | null; color: string }
    }
  /** Zones were added, edited or deleted: fetch them again. */
  | { type: 'zones.changed'; data: { rev: number } }
  | { type: 'ready' }
  | { type: 'pong' }

export const channels = {
  devices: 'devices',
  device: (sn: string) => `device:${sn}`,
  stream: (id: string) => `stream:${id}`,
}
