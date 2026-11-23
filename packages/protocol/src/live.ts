import { z } from 'zod'

/**
 * Pilot live-streaming service methods. Values verified against DJI's Pilot live stream
 * API page and the archived Cloud API demo SDK.
 */
export const LiveMethod = {
  start: 'live_start_push',
  stop: 'live_stop_push',
  setQuality: 'live_set_quality',
  lensChange: 'live_lens_change',
} as const

export const UrlType = {
  agora: 0,
  rtmp: 1,
  rtsp: 2,
  gb28181: 3,
  whip: 4,
} as const

export const VideoQuality = {
  auto: 0,
  smooth: 1,
  sd: 2,
  hd: 3,
  uhd: 4,
} as const

export type VideoQualityValue = (typeof VideoQuality)[keyof typeof VideoQuality]

/** DJI's published bitrate ladder, kbps. Used for bandwidth sizing. */
export const QUALITY_BITRATE_KBPS: Record<number, number> = {
  1: 512,
  2: 1000,
  3: 1500,
  4: 3000,
}

export const VIDEO_TYPE = ['normal', 'thermal', 'wide', 'zoom'] as const
export type VideoType = (typeof VIDEO_TYPE)[number]

export const liveStartPushSchema = z.object({
  url_type: z.number().int(),
  url: z.string().min(1),
  video_id: z.string().min(1),
  video_quality: z.number().int().min(0).max(4),
})

export const liveStopPushSchema = z.object({
  video_id: z.string().min(1),
})

export const liveSetQualitySchema = z.object({
  video_id: z.string().min(1),
  video_quality: z.number().int().min(0).max(4),
})

export const liveLensChangeSchema = z.object({
  video_id: z.string().min(1),
  video_type: z.enum(VIDEO_TYPE),
})

export type LiveStartPush = z.infer<typeof liveStartPushSchema>

/** `{sn}/{camera_index}/{video_index}` */
export function videoId(sn: string, cameraIndex: string, videoIndex: string): string {
  return `${sn}/${cameraIndex}/${videoIndex}`
}

export function parseVideoId(
  id: string,
): { sn: string; cameraIndex: string; videoIndex: string } | null {
  const parts = id.split('/')
  if (parts.length !== 3) return null
  const [sn, cameraIndex, videoIndex] = parts
  if (!sn || !cameraIndex || !videoIndex) return null
  return { sn, cameraIndex, videoIndex }
}
