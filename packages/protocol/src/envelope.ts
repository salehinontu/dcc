import { z } from 'zod'

/**
 * Every DJI Cloud API MQTT message has this envelope. `data` is left open because the
 * payload shape depends on the topic and the aircraft model.
 */
export const envelopeSchema = z
  .object({
    tid: z.string().min(1),
    bid: z.string().optional(),
    timestamp: z.number().int().nonnegative(),
    method: z.string().optional(),
    data: z.unknown().optional(),
    gateway: z.string().optional(),
  })
  .catchall(z.unknown())

export type Envelope = z.infer<typeof envelopeSchema>
