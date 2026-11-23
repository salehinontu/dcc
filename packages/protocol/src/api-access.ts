import { z } from 'zod'
import type { Permission } from './access'

/**
 * API access: a program of the customer's own (an AI analysis tool, a data warehouse) reads the dashboard's data with a
 * token instead of a person's sign-in. A token is **read-only** and is a narrowed copy of the account that made it: it
 * can never do more than that account, and only what is listed here.
 */

/** Every token starts with this, so a leaked one is recognisable (and a secret scanner can find it). */
export const API_TOKEN_PREFIX = 'ne_'

/** The drone rights a token may carry: looking, never changing. */
export const API_READ_DRONE_PERMISSIONS: readonly Permission[] = [
  'drones.view',
  'telemetry.view',
  'streams.view',
  'screenshots.view',
  'recordings.view',
  'flights.view',
]

/** The screen grants a token may carry: they open the data of the same name. */
export const API_READ_ACCOUNT_PERMISSIONS: readonly Permission[] = [
  'map.view',
  'wall.view',
  'shots.view',
  'recs.view',
  'history.view',
  'fleet.view',
  'zones.view',
  'alerts.view',
]

export const API_TOKEN_NAME_MAX = 60

/** The longest a token may be asked to live, in days (a token with no expiry is allowed: `null`). */
export const API_TOKEN_MAX_DAYS = 3650

export const apiTokenCreateSchema = z.object({
  /** What the token is for ("Acme AI analytics"): shown in the list and the audit trail. */
  name: z.string().trim().min(1).max(API_TOKEN_NAME_MAX),
  /** The drones it may read; null is every drone the account itself may read. */
  deviceSns: z.array(z.string().min(1).max(64)).min(1).max(200).nullable().default(null),
  /** Days until it stops working; null never. */
  expiresInDays: z.number().int().min(1).max(API_TOKEN_MAX_DAYS).nullable().default(null),
})
export type ApiTokenCreate = z.infer<typeof apiTokenCreateSchema>

/** A token as listed: never the secret, only enough to tell it from the others. */
export interface ApiTokenRecord {
  id: string
  name: string
  /** The first characters of the token, to recognise it ("ne_Ab3dEf"). */
  prefix: string
  ownerEmail: string
  /** null: every drone the owner may read. */
  deviceSns: string[] | null
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  lastUsedIp: string | null
  revokedAt: string | null
}

/** The answer to making one: the only time the secret is shown. */
export interface ApiTokenCreated {
  token: string
  record: ApiTokenRecord
}

/** What `GET /api/v1/whoami` says about the credential that asked. */
export interface ApiWhoami {
  /** `token` for an API token, `session` for a person signed in. */
  kind: 'token' | 'session'
  name: string | null
  expiresAt: string | null
  /** Every drone this credential may read. */
  drones: { sn: string; name: string }[]
  permissions: Permission[]
}
