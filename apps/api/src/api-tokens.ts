import { createHash, randomBytes } from 'node:crypto'
import {
  API_READ_ACCOUNT_PERMISSIONS,
  API_READ_DRONE_PERMISSIONS,
  API_TOKEN_PREFIX,
  type Access,
  type Permission,
} from '@dji/protocol'
import { publicUser, resolveUser, type CurrentUser } from './auth'
import type { Store } from './store'

/**
 * API access. A token lets a program of the customer's own read the dashboard's data without a person's sign-in
 * (no password, no two-step code, no 12-hour session). It is **read-only** and **never more than the account that made
 * it**: every request recomputes what that account may read right now, keeps only the looking rights, and keeps only
 * the drones the token was limited to. `http/access.ts` then lets it call GET routes from a short list and nothing
 * else.
 *
 * The secret is 256 random bits: only its SHA-256 is stored, so a copy of the database yields no working token, and
 * a fast hash is enough because there is nothing to guess.
 */

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newApiToken(): { token: string; hash: string; prefix: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  return { token, hash: hashApiToken(token), prefix: token.slice(0, API_TOKEN_PREFIX.length + 6) }
}

export const looksLikeApiToken = (value: string): boolean => value.startsWith(API_TOKEN_PREFIX)

/**
 * What a token may do, from what its owner may do. Looking rights only; with a drone list, only those drones (and
 * only if the owner may still see them); an owner scoped to selected drones stays scoped.
 */
export function narrowAccess(
  owner: Pick<Access, 'permissions' | 'allDrones' | 'dronePermissions'>,
  deviceSns: string[] | null,
): Pick<Access, 'permissions' | 'allDrones' | 'dronePermissions'> {
  const keep = (grants: readonly Permission[], allowed: readonly Permission[]) =>
    grants.filter((grant) => allowed.includes(grant))
  const screens = keep(owner.permissions, API_READ_ACCOUNT_PERMISSIONS)

  if (owner.allDrones && deviceSns === null)
    return {
      permissions: [...screens, ...keep(owner.permissions, API_READ_DRONE_PERMISSIONS)],
      allDrones: true,
      dronePermissions: {},
    }

  const dronePermissions: Record<string, Permission[]> = {}
  for (const sn of deviceSns ?? Object.keys(owner.dronePermissions)) {
    const grants = owner.allDrones ? owner.permissions : (owner.dronePermissions[sn] ?? [])
    if (!grants.includes('drones.view')) continue
    dronePermissions[sn] = keep(grants, API_READ_DRONE_PERMISSIONS)
  }
  return { permissions: screens, allDrones: false, dronePermissions }
}

/** The account behind an API token, narrowed. Null for an unknown, revoked or expired token, or an owner who is gone. */
export async function resolveApiToken(
  token: string,
  store: Store,
  ip?: string,
): Promise<CurrentUser | null> {
  try {
    const row = await store.tokens.findLive(hashApiToken(token))
    if (!row) return null
    const owner = await store.findUserById(row.user_id)
    // A Developer is the vendor and never owns one (a customer's Admin does); a drone operator has no dashboard.
    if (!owner || owner.disabled || owner.role === 'developer' || owner.role === 'pilot')
      return null
    const base = publicUser(owner)
    const expiresAt = row.expires_at ? new Date(row.expires_at) : null
    void store.tokens.touch(row.id, ip ?? null).catch(() => undefined)
    return {
      ...base,
      ...narrowAccess(base, Array.isArray(row.device_sns) ? row.device_sns : null),
      // The token is its own credential: the owner's password and two-step state do not apply to it.
      mustChangePassword: false,
      mfaEnrolRequired: false,
      gatewaySn: undefined,
      jti: undefined,
      exp: expiresAt ? Math.floor(expiresAt.getTime() / 1000) : undefined,
      apiToken: {
        id: row.id,
        name: row.name,
        deviceSns: Array.isArray(row.device_sns) ? row.device_sns : null,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      },
    }
  } catch {
    return null
  }
}

/** A session token or an API token, whichever this is. Fails closed. */
export async function resolveCredential(
  token: string,
  store: Store,
  ip?: string,
): Promise<CurrentUser | null> {
  return looksLikeApiToken(token) ? resolveApiToken(token, store, ip) : resolveUser(token, store)
}
