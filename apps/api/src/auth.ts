import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { decodeJwt, jwtVerify, SignJWT } from 'jose'
import { randomUUID } from 'node:crypto'
import { knownPermissions, type Access, type Role } from '@dji/protocol'
import type { Store, UserRow } from './store'
import { config } from './config'
import { mfaRequiredFor } from './mfa'

const secret = new TextEncoder().encode(config.jwtSecret)

export type { Role }

export interface SessionUser {
  sessionVersion?: number
  permissions?: Access['permissions']
  allDrones?: boolean
  dronePermissions?: Access['dronePermissions']
  mustChangePassword?: boolean
  id: string
  email: string
  role: Role
  /** Present on tokens issued to a Pilot 2 controller after registration. */
  gatewaySn?: string
  /**
   * `preauth` marks a short-lived token issued from the operator's credentials before the
   * DJI licence has been verified. It may read the pilot config but cannot reach the MQTT
   * credentials.
   */
  stage?: 'preauth'
  /** `sessions` key. A token without one is rejected: nothing could revoke it. */
  jti?: string
  /** Token expiry, seconds since epoch. The WebSocket closes once it passes. */
  exp?: number
}

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password)
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(passwordHash, password)
  } catch {
    return false
  }
}

/**
 * Sign a token *and* record the session it belongs to. This is the only signing path: a
 * token without a `sessions` row would be unrevocable, so no caller gets to mint one
 * directly. Returns the token; its `jti` is inside it.
 */
export async function issueSession(
  user: SessionUser,
  store: Store,
  expiresIn = '12h',
): Promise<string> {
  const jti = randomUUID()
  const token = await new SignJWT({
    sv: user.sessionVersion ?? 0,
    role: user.role,
    email: user.email,
    ...(user.gatewaySn ? { gatewaySn: user.gatewaySn } : {}),
    ...(user.stage ? { stage: user.stage } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret)
  // Read the expiry back instead of parsing "12h": the row must not outlive the token.
  const { exp } = decodeJwt(token)
  await store.createSession(jti, user.id, user.role, new Date((exp ?? 0) * 1000))
  return token
}

/**
 * The short-lived proof that a password was right, handed out when the account has two-step sign-in on. It is NOT a
 * session: it has no `sessions` row and no role, so `verifyToken` refuses it everywhere; the only thing it can do is be
 * sent back, with a code, to `POST /api/auth/mfa`, which then issues the real session. `sv` ties it to the password and
 * role it was issued for: a password change or an administrator's edit between the two steps voids it.
 */
export async function issueMfaChallenge(
  user: { id: string; session_version: number },
  expiresIn = '5m',
): Promise<string> {
  return new SignJWT({ purpose: 'mfa', sv: user.session_version })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret)
}

export async function verifyMfaChallenge(
  token: string,
): Promise<{ id: string; sessionVersion: number } | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] })
    if (payload.purpose !== 'mfa' || !payload.sub || typeof payload.sv !== 'number') return null
    return { id: payload.sub, sessionVersion: payload.sv }
  } catch {
    return null
  }
}

export async function verifyToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] })
    // A two-step challenge (`issueMfaChallenge`) is never a session, whatever else it carries.
    if (payload.purpose !== undefined) return null
    if (
      !payload.sub ||
      typeof payload.role !== 'string' ||
      typeof payload.email !== 'string' ||
      typeof payload.jti !== 'string'
    ) {
      return null
    }
    return {
      id: payload.sub,
      sessionVersion: typeof payload.sv === 'number' ? payload.sv : 0,
      email: payload.email,
      role: payload.role as Role,
      jti: payload.jti,
      ...(typeof payload.gatewaySn === 'string' ? { gatewaySn: payload.gatewaySn } : {}),
      ...(payload.stage === 'preauth' ? { stage: 'preauth' as const } : {}),
      ...(typeof payload.exp === 'number' ? { exp: payload.exp } : {}),
    }
  } catch {
    return null
  }
}

export function publicUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    role: row.role as Role,
    permissions: knownPermissions(row.permissions),
    allDrones: row.all_drones,
    dronePermissions: Object.fromEntries(
      Object.entries(row.drone_permissions).map(([sn, grants]) => [sn, knownPermissions(grants)]),
    ),
    mustChangePassword: row.must_change_password,
    /** Two-step sign-in is on for this account. */
    mfaEnabled: row.totp_enabled_at != null,
    /** This role must have it on (`MFA_REQUIRED_ROLES`). */
    mfaRequired: mfaRequiredFor(row.role),
    /** It must, and has not yet: the account may only set it up until it has. */
    mfaEnrolRequired: mfaRequiredFor(row.role) && row.totp_enabled_at == null,
    disabled: row.disabled,
    sessionVersion: row.session_version,
    adminId: row.admin_id ?? null,
    createdBy: row.created_by ?? null,
    createdByEmail: row.created_by_email ?? null,
  }
}

/**
 * Never trust role/grants in a JWT: re-read current account on every use, and require the
 * session row to still be live. A database failure returns null — failing closed is the
 * right trade for a command centre, where a stale credential outliving its revocation is
 * the thing this exists to prevent.
 */
export async function resolveUser(token: string, store: Store) {
  const claims = await verifyToken(token)
  if (!claims) return null
  try {
    const [row, live] = await Promise.all([
      store.findUserById(claims.id),
      store.sessionLive(claims.jti!),
    ])
    if (!live || !row || row.disabled || row.session_version !== claims.sessionVersion) return null
    return {
      ...publicUser(row),
      gatewaySn: claims.gatewaySn,
      jti: claims.jti,
      exp: claims.exp,
      ...(claims.stage ? { stage: claims.stage } : {}),
    }
  } catch {
    return null
  }
}
/** Set when the request came with an API token instead of a sign-in (see `api-tokens.ts`). */
export interface ApiTokenInfo {
  id: string
  name: string
  /** The drones the token was limited to; null is every drone its owner may read. */
  deviceSns: string[] | null
  expiresAt: string | null
}

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof resolveUser>>> & {
  apiToken?: ApiTokenInfo
}
