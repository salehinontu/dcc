import { z } from 'zod'

/**
 * `sys/product/{gateway_sn}/status`, method `update_topo`.
 *
 * A topology message with an empty `sub_devices` list means the gateway is offline; a
 * non-empty list means it is online and names its aircraft and payloads.
 */
// Pilot 2 on the RC Plus 2 sends some of these as numeric strings (`"domain": "2"`), the
// archived demo as numbers. Accept both and normalise to a number.
const intLike = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^-?\d+$/)
    .transform(Number),
])

// DJI documents the control index as a letter ("A", "B"); keep it as 0, 1, … to match the
// integer column. Unrecognised values are dropped rather than failing the whole message.
const controlIndex = z.union([intLike, z.string()]).transform((value): number | undefined => {
  if (typeof value === 'number') return value
  return /^[A-Za-z]$/.test(value) ? value.toUpperCase().charCodeAt(0) - 65 : undefined
})

export const topoSubDeviceSchema = z
  .object({
    sn: z.string().min(1),
    domain: intLike.optional(),
    type: intLike.optional(),
    sub_type: intLike.optional(),
    index: controlIndex.optional(),
    device_secret: z.string().optional(),
    nonce: z.string().optional(),
    version: z.string().optional(),
  })
  .catchall(z.unknown())

export type TopoSubDevice = z.infer<typeof topoSubDeviceSchema>

export const topoSchema = z
  .object({
    domain: intLike.optional(),
    type: intLike.optional(),
    sub_type: intLike.optional(),
    device_secret: z.string().optional(),
    nonce: z.string().optional(),
    version: z.string().optional(),
    sub_devices: z.array(topoSubDeviceSchema).optional(),
  })
  .catchall(z.unknown())

export type Topo = z.infer<typeof topoSchema>

export function isOnlineTopo(data: Topo | undefined | null): boolean {
  return !!data?.sub_devices?.length
}

/** Device domain values used by DJI's thing model. */
export const DeviceDomain = {
  aircraft: 0,
  payload: 1,
  remoteController: 2,
  dock: 3,
} as const
