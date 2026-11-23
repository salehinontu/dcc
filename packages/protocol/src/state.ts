import { z } from 'zod'

/**
 * `live_capacity` and `live_status` are pushed in `thing/product/{gateway_sn}/state`.
 * The gateway only sends them when they change, so the backend persists them.
 */
export const liveCapacityVideoSchema = z
  .object({
    video_index: z.string(),
    video_type: z.string().optional(),
  })
  .catchall(z.unknown())

export const liveCapacityCameraSchema = z
  .object({
    camera_index: z.string(),
    available_video_number: z.number().int().optional(),
    coexist_video_number_max: z.number().int().optional(),
    video_list: z.array(liveCapacityVideoSchema).optional(),
  })
  .catchall(z.unknown())

export const liveCapacityDeviceSchema = z
  .object({
    sn: z.string(),
    available_video_number: z.number().int().optional(),
    coexist_video_number_max: z.number().int().optional(),
    camera_list: z.array(liveCapacityCameraSchema).optional(),
  })
  .catchall(z.unknown())

export const liveCapacitySchema = z
  .object({
    available_video_number: z.number().int().optional(),
    coexist_video_number_max: z.number().int().optional(),
    device_list: z.array(liveCapacityDeviceSchema).optional(),
  })
  .catchall(z.unknown())

export type LiveCapacity = z.infer<typeof liveCapacitySchema>
export type LiveCapacityCamera = z.infer<typeof liveCapacityCameraSchema>

export const liveStatusEntrySchema = z
  .object({
    video_id: z.string().optional(),
    video_type: z.string().optional(),
    video_index: z.string().optional(),
    video_quality: z.number().int().optional(),
    status: z.union([z.boolean(), z.number()]).optional(),
  })
  .catchall(z.unknown())

export type LiveStatusEntry = z.infer<typeof liveStatusEntrySchema>

const liveStatusArray = z.array(liveStatusEntrySchema)

/**
 * DJI's Java SDK models the state value as `RcLiveStatus`, which itself has a
 * `live_status` array — i.e. the payload is nested once. Some captures show the array
 * directly. Accept both so a firmware difference cannot break reconciliation.
 */
export const liveStatusSchema = z
  .object({
    live_status: z
      .union([
        liveStatusArray,
        z.object({ live_status: liveStatusArray.optional() }).catchall(z.unknown()),
      ])
      .optional(),
  })
  .catchall(z.unknown())

export type LiveStatus = z.infer<typeof liveStatusSchema>

export function liveStatusEntries(data: Record<string, unknown>): LiveStatusEntry[] {
  const value = data.live_status
  if (Array.isArray(value)) return value as LiveStatusEntry[]
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>).live_status
    if (Array.isArray(inner)) return inner as LiveStatusEntry[]
  }
  return []
}

/** Camera list for a given aircraft serial number. */
export function camerasFor(capacity: LiveCapacity, sn: string): LiveCapacityCamera[] {
  return capacity.device_list?.find((device) => device.sn === sn)?.camera_list ?? []
}
