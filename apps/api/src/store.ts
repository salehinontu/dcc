import type { CameraSummary } from '@dji/protocol'
import type { TelemetrySample } from '@dji/protocol'
import type { Permission } from '@dji/protocol'
import type { PeopleDetection, PeopleMark } from '@dji/protocol'
import { ACCOUNT_PERMISSIONS, can, defaultPermissions, PERMISSIONS } from '@dji/protocol'
import type { Db } from './db'
import { RecordingStore } from './recordings/store'
import { DEVICE_NAME_SQL, FleetStore } from './store-fleet'
import { TokenStore } from './store-tokens'

export interface UserRow {
  id: string
  email: string
  password_hash: string
  role: string
  permissions: Permission[]
  all_drones: boolean
  drone_permissions: Record<string, Permission[]>
  must_change_password: boolean
  disabled: boolean
  session_version: number
  /** The Admin this account belongs to: itself for an Admin, null for a Developer. */
  admin_id: string | null
  created_by: string | null
  /** The sealed shared secret of the account's authenticator app (see `mfa.ts`), or null. Never sent to a browser. */
  totp_secret: string | null
  totp_pending_secret: string | null
  /** Null until the account proved it holds the app: that is when two-step sign-in is on. */
  totp_enabled_at: Date | string | null
  totp_last_step: number | string
  totp_failures: number
  totp_locked_until: Date | string | null
  /** Wrong passwords in a row; at `LOGIN_MAX_FAILURES` the sign-in is locked until `login_locked_until`. */
  login_failures: number
  login_locked_until: Date | string | null
  /** Only on rows from `listUsers`. */
  created_by_email?: string | null
}

export interface GatewayCredentialRow {
  gateway_sn: string
  username: string
  password_hash: string
  expires_at: Date | string | null
  revoked: boolean
  user_id?: string | null
  session_version?: number | null
}

export interface EnrollmentRow {
  controller_sn: string
  workspace_id: string | null
  user_id: string | null
  status: 'pending' | 'approved' | 'rejected'
  note: string | null
  approved_by: string | null
  approved_at: Date | string | null
  created_at: Date | string
  last_seen_at: Date | string | null
}

export interface EnrollmentSummary extends EnrollmentRow {
  aircraft_sns: string[]
}

export interface SessionRow {
  jti: string
  user_id: string
  role: string
  expires_at: Date | string
  revoked_at: Date | string | null
}

export interface DeviceListRow {
  sn: string
  gateway_sn: string | null
  model: string | null
  display_name: string | null
  label: string | null
  video_only: boolean
  online: boolean
  last_seen_at: Date | string | null
  cameras: CameraSummary[] | null
  color: string | null
  sample_ts: Date | string | null
  lat: number | null
  lon: number | null
  alt_rel: number | null
  alt_abs: number | null
  heading: number | null
  speed_h: number | null
  speed_v: number | null
  battery_pct: number | null
  mode: number | null
  gnss: number | null
  rtk: number | null
  remain_flight_s: number | null
}

export interface TelemetryRow {
  ts: Date | string
  lat: number | null
  lon: number | null
  alt_rel: number | null
  alt_abs: number | null
  heading: number | null
  speed_h: number | null
  speed_v: number | null
  battery_pct: number | null
  mode: number | null
  gnss: number | null
  rtk: number | null
}

export interface StreamRow {
  id: string
  device_sn: string
  video_id: string
  stream_key: string
  state: string
  quality: number
  error: string | null
  requested_by: string | null
  started_at: Date | string
  stopped_at: Date | string | null
  rev: number
  updated_at: Date | string
}

export interface StreamDeviceRow {
  sn: string
  gateway_sn: string | null
  online: boolean
  cameras: CameraSummary[] | null
}

/** Postgres unique_violation. PGlite and node-postgres expose it as `code`. */
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  if (code === '23505') return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /duplicate key|unique constraint/i.test(message)
}

export interface ScreenshotRow {
  id: string
  device_sn: string
  device_label: string | null
  mission_id: string | null
  filename: string
  storage_key: string
  content_type: string
  size_bytes: number
  width: number | null
  height: number | null
  captured_at: Date | string
  operator_id: string | null
  operator_email: string | null
  lat: number | null
  lon: number | null
  alt_rel: number | null
  people_ai_count: number | null
  people_verified_count: number | null
}

export interface PeopleRow {
  screenshot_id: string
  stage: string
  model: string
  ai_count: number
  detections: unknown
  duration_ms: number | null
  analyzed_at: Date | string
  analyzed_by_email: string | null
  marks: unknown
  verified_count: number | null
  verified_at: Date | string | null
  verified_by_email: string | null
}

export interface ScreenshotFilter {
  deviceSn?: string
  missionId?: string
  fromIso?: string
  toIso?: string
  beforeIso?: string
  limit: number
  allowedSns?: string[]
}

export function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export class Store {
  readonly fleet: FleetStore
  readonly recordings: RecordingStore
  readonly tokens: TokenStore

  constructor(private readonly db: Db) {
    this.fleet = new FleetStore(db)
    this.recordings = new RecordingStore(db)
    this.tokens = new TokenStore(db)
  }

  async seedWorkspace(id: string, name: string, platformName: string): Promise<void> {
    await this.db.query(
      `INSERT INTO workspaces (id, name, platform_name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, platform_name = EXCLUDED.platform_name`,
      [id, name, platformName],
    )
  }

  async findUserByEmail(email: string): Promise<UserRow | null> {
    // Case-insensitive: controller keyboards often capitalise the first letter.
    const rows = await this.db.query<UserRow>(
      `SELECT * FROM users WHERE lower(email) = lower($1) ORDER BY (email = $1) DESC LIMIT 1`,
      [email.trim()],
    )
    return rows[0] ?? null
  }

  async findUserById(id: string): Promise<UserRow | null> {
    return (await this.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]))[0] ?? null
  }

  async createUser(
    id: string,
    email: string,
    passwordHash: string,
    role: string,
    access?: {
      permissions: Permission[]
      allDrones: boolean
      dronePermissions: Record<string, Permission[]>
      mustChangePassword?: boolean
      /** The Admin it works for (ignored for an Admin, who belongs to itself). */
      adminId?: string | null
      createdBy?: string | null
    },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO users (id,email,password_hash,role,permissions,all_drones,drone_permissions,must_change_password,admin_id,created_by)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10)`,
      [
        id,
        email.trim().toLowerCase(),
        passwordHash,
        role,
        JSON.stringify(access?.permissions ?? defaultPermissions(role)),
        access?.allDrones ?? true,
        JSON.stringify(access?.dronePermissions ?? {}),
        access?.mustChangePassword ?? false,
        role === 'admin' ? id : (access?.adminId ?? null),
        access?.createdBy ?? null,
      ],
    )
  }

  async updateUser(id: string, passwordHash: string, role: string): Promise<void> {
    // A new password also lifts a lock-out: that is how an administrator lets a locked person back in.
    await this.db.query(
      `UPDATE users SET password_hash=$2, role=$3, must_change_password=FALSE,
      session_version=session_version+1, login_failures=0, login_locked_until=NULL WHERE id=$1`,
      [id, passwordHash, role],
    )
  }

  /**
   * Removes an account for good. Its controller credentials go with it, so a remote controller
   * it signed in can no longer connect (a credential row without an owner would otherwise read
   * as "no account to check"), and its sessions are deleted. Everything else that mentions the
   * account (screenshots analysed, flights) keeps a plain email or a nulled reference.
   * False when there was no such account.
   */
  async deleteUser(id: string): Promise<boolean> {
    await this.db.query(`DELETE FROM gateway_credentials WHERE user_id = $1`, [id])
    await this.db.query(`DELETE FROM sessions WHERE user_id = $1`, [id])
    const rows = await this.db.query(`DELETE FROM users WHERE id = $1 RETURNING id`, [id])
    return rows.length > 0
  }

  async changePassword(id: string, oldHash: string, passwordHash: string): Promise<boolean> {
    return (
      (
        await this.db.query(
          `UPDATE users SET password_hash=$3,must_change_password=FALSE,
      session_version=session_version+1, login_failures=0, login_locked_until=NULL
      WHERE id=$1 AND password_hash=$2 RETURNING id`,
          [id, oldHash, passwordHash],
        )
      ).length > 0
    )
  }

  /**
   * Changes the sign-in email. `session_version` is deliberately left alone: it ties a remote
   * controller's MQTT credentials to its account, so bumping it would cut a pilot off in flight
   * for a change that touches no credential. False when the address is already someone else's.
   */
  async changeEmail(id: string, email: string): Promise<boolean> {
    try {
      const rows = await this.db.query(`UPDATE users SET email = $2 WHERE id = $1 RETURNING id`, [
        id,
        email.trim().toLowerCase(),
      ])
      return rows.length > 0
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return false
      throw error
    }
  }

  async setUserAccess(
    id: string,
    input: {
      role: string
      permissions: Permission[]
      allDrones: boolean
      dronePermissions: Record<string, Permission[]>
      disabled: boolean
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE users SET role=$2,permissions=$3::jsonb,all_drones=$4,
      drone_permissions=$5::jsonb,disabled=$6,session_version=session_version+1,
      admin_id = CASE WHEN $2 = 'admin' THEN id WHEN admin_id = id THEN NULL ELSE admin_id END
      WHERE id=$1`,
      [
        id,
        input.role,
        JSON.stringify(input.permissions),
        input.allDrones,
        JSON.stringify(input.dronePermissions),
        input.disabled,
      ],
    )
  }

  /**
   * The accounts that work together with `userId`: itself and, when it belongs to an Admin, every
   * account of that Admin. A Developer has no Admin, so it is only itself here; callers treat a
   * Developer as "everyone" before asking.
   */
  async tenantUsers(
    userId: string,
    adminId: string | null,
  ): Promise<{ id: string; email: string }[]> {
    return this.db.query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE id = $1 OR ($2::text IS NOT NULL AND admin_id = $2)`,
      [userId, adminId],
    )
  }

  /** Which of these serials the installation already knows, whoever owns them. */
  async existingDeviceSns(sns: string[]): Promise<string[]> {
    if (sns.length === 0) return []
    const rows = await this.db.query<{ sn: string }>(
      `SELECT sn FROM devices WHERE sn = ANY($1::text[])`,
      [sns],
    )
    return rows.map((row) => row.sn)
  }

  /**
   * Adds a drone, with these rights, to an account that is limited to selected drones. Nothing
   * happens for an account that already sees every drone, and an entry that is already there is
   * a decision (a drone taken away on purpose) and stays.
   */
  async giveDrone(accountId: string, sn: string, grants: Permission[]): Promise<void> {
    await this.db.query(
      `UPDATE users SET drone_permissions = drone_permissions || jsonb_build_object($2::text, $3::jsonb)
       WHERE id = $1 AND role <> 'developer' AND NOT all_drones AND NOT (drone_permissions ? $2::text)`,
      [accountId, sn, JSON.stringify(grants)],
    )
  }

  /**
   * Gives a drone to an Admin with the same rights as on its other drones (the full set when it
   * has none yet), because everything its team brings in is the customer's.
   */
  async giveDroneToAdmin(adminId: string, sn: string): Promise<void> {
    const admin = (
      await this.db.query<{ all_drones: boolean; drone_permissions: Record<string, Permission[]> }>(
        `SELECT all_drones, drone_permissions FROM users WHERE id = $1 AND role = 'admin'`,
        [adminId],
      )
    )[0]
    if (!admin || admin.all_drones || Object.hasOwn(admin.drone_permissions, sn)) return
    const held = new Set<Permission>()
    for (const grants of Object.values(admin.drone_permissions))
      for (const grant of grants) held.add(grant)
    const grants = PERMISSIONS.filter((permission) =>
      held.size > 0 ? held.has(permission) : !ACCOUNT_PERMISSIONS.includes(permission),
    )
    if (!grants.includes('drones.view')) grants.unshift('drones.view')
    await this.giveDrone(adminId, sn, grants)
  }

  /**
   * A drone seen for the first time through a controller belongs to the customer whose Pilot
   * signed that controller in, so that customer's Admin is given it. Without this an Admin limited
   * to "selected drones" would never see its own drones until a Developer ticked each one. It runs
   * once per drone (on first sight), so taking a drone away later sticks, and a drone of the
   * Developer's own controllers (a Pilot with no Admin) is given to nobody.
   */
  private async grantNewDroneToOwner(sn: string, gatewaySn: string): Promise<void> {
    try {
      const owners = await this.db.query<{ id: string }>(
        `SELECT a.id
         FROM controller_enrollments e
         JOIN users p ON p.id = e.user_id
         JOIN users a ON a.id = p.admin_id AND a.role = 'admin'
         WHERE e.controller_sn = $1`,
        [gatewaySn],
      )
      if (owners[0]) await this.giveDroneToAdmin(owners[0].id, sn)
    } catch (error) {
      console.error('[store] could not give a new drone to its Admin', sn, error)
    }
  }

  async listUsers(): Promise<UserRow[]> {
    return this.db.query<UserRow>(
      `SELECT u.*, c.email AS created_by_email
       FROM users u LEFT JOIN users c ON c.id = u.created_by
       ORDER BY u.email`,
    )
  }

  /** How many Sub-admins and Pilots belong to this Admin. */
  async countAdminAccounts(adminId: string): Promise<number> {
    const rows = await this.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM users WHERE admin_id = $1 AND id <> $1`,
      [adminId],
    )
    return Number(rows[0]?.n ?? 0)
  }

  /**
   * Sessions are the server-side half of a JWT. Signing a token without a row here would
   * issue a credential no revocation could ever reach, so `issueSession` in auth.ts is the
   * only thing that signs.
   */
  async createSession(jti: string, userId: string, role: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO sessions (jti, user_id, role, expires_at) VALUES ($1, $2, $3, $4)`,
      [jti, userId, role, expiresAt],
    )
  }

  /** A session is live only if it exists, was not revoked, and has not expired. */
  async sessionLive(jti: string): Promise<boolean> {
    const rows = await this.db.query<{ live: boolean }>(
      `SELECT (revoked_at IS NULL AND expires_at > now()) AS live FROM sessions WHERE jti = $1`,
      [jti],
    )
    return rows[0]?.live ?? false
  }

  async revokeSession(jti: string): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET revoked_at = now() WHERE jti = $1 AND revoked_at IS NULL`,
      [jti],
    )
  }

  /**
   * Every session for an account, optionally keeping the caller's own. Used by a password
   * change, a role change and an admin reset; `exceptJti` is what lets the device that made
   * the change stay signed in on the token it is about to be handed.
   */
  async revokeUserSessions(userId: string, exceptJti?: string): Promise<void> {
    if (exceptJti)
      await this.db.query(
        `UPDATE sessions SET revoked_at = now()
         WHERE user_id = $1 AND jti <> $2 AND revoked_at IS NULL`,
        [userId, exceptJti],
      )
    else
      await this.db.query(
        `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      )
  }

  // --- password lock-out (see routes/auth.ts) ---------------------------------------------------------------

  /**
   * A wrong password for an existing account. The `maxFailures`th in a row locks the account's sign-in for `lockSeconds`
   * and starts the count again; returns when the lock ends, if this failure began one.
   */
  async recordLoginFailure(
    id: string,
    maxFailures: number,
    lockSeconds: number,
  ): Promise<Date | null> {
    const rows = await this.db.query<{ login_locked_until: Date | string | null; locked: boolean }>(
      `UPDATE users SET
         login_failures = CASE WHEN login_failures + 1 >= $2 THEN 0 ELSE login_failures + 1 END,
         login_locked_until = CASE WHEN login_failures + 1 >= $2 THEN now() + make_interval(secs => $3) ELSE login_locked_until END
       WHERE id = $1 RETURNING login_locked_until, (login_failures = 0) AS locked`,
      [id, maxFailures, lockSeconds],
    )
    const row = rows[0]
    return row?.locked && row.login_locked_until ? new Date(row.login_locked_until) : null
  }

  /** A right password: forget the earlier wrong ones. */
  async clearLoginFailures(id: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET login_failures = 0, login_locked_until = NULL
        WHERE id = $1 AND (login_failures <> 0 OR login_locked_until IS NOT NULL)`,
      [id],
    )
  }

  // --- two-step sign-in (see mfa.ts) -----------------------------------------------------------------------------

  /** A secret waiting for the account to prove it holds the app; replaced by each new set-up. */
  async setPendingTotp(id: string, sealed: string): Promise<void> {
    await this.db.query(`UPDATE users SET totp_pending_secret = $2 WHERE id = $1`, [id, sealed])
  }

  /**
   * Turns two-step sign-in on: the pending secret becomes the secret, `step` is spent so the code that proved it cannot
   * be used again, and the recovery codes (hashes) replace any earlier ones. False when nothing was pending.
   */
  async enableTotp(id: string, step: number, recoveryHashes: string[]): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled_at = now(),
              totp_last_step = $2, totp_failures = 0, totp_locked_until = NULL
        WHERE id = $1 AND totp_pending_secret IS NOT NULL AND totp_enabled_at IS NULL RETURNING id`,
      [id, step],
    )
    if (rows.length === 0) return false
    await this.replaceRecoveryCodes(id, recoveryHashes)
    return true
  }

  /** Turns it off and forgets everything about it (also what an administrator's reset does). */
  async disableTotp(id: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL,
              totp_last_step = 0, totp_failures = 0, totp_locked_until = NULL WHERE id = $1`,
      [id],
    )
    await this.db.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [id])
  }

  /**
   * Accepts a code's step, once: true only if it is newer than the last one accepted, and in the same statement forgets
   * earlier wrong codes. Two requests with one code race here and exactly one wins.
   */
  async spendTotpStep(id: string, step: number): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE users SET totp_last_step = $2, totp_failures = 0, totp_locked_until = NULL
        WHERE id = $1 AND totp_last_step < $2 RETURNING id`,
      [id, step],
    )
    return rows.length > 0
  }

  /**
   * A wrong code. After `maxFailures` in a row the second step is locked for `lockSeconds`; returns the lock, if one
   * began. (RETURNING reads the row as updated: the counter is back at 0 only when this failure began a lock.)
   */
  async recordTotpFailure(
    id: string,
    maxFailures: number,
    lockSeconds: number,
  ): Promise<Date | null> {
    const rows = await this.db.query<{ totp_locked_until: Date | string | null; locked: boolean }>(
      `UPDATE users SET
         totp_failures = CASE WHEN totp_failures + 1 >= $2 THEN 0 ELSE totp_failures + 1 END,
         totp_locked_until = CASE WHEN totp_failures + 1 >= $2 THEN now() + make_interval(secs => $3) ELSE totp_locked_until END
       WHERE id = $1 RETURNING totp_locked_until, (totp_failures = 0) AS locked`,
      [id, maxFailures, lockSeconds],
    )
    const row = rows[0]
    return row?.locked && row.totp_locked_until ? new Date(row.totp_locked_until) : null
  }

  async replaceRecoveryCodes(id: string, hashes: string[]): Promise<void> {
    await this.db.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [id])
    for (const hash of hashes)
      await this.db.query(
        `INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, hash],
      )
  }

  /** Spends a recovery code: true only the first time. */
  async spendRecoveryCode(id: string, hash: string): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE user_recovery_codes SET used_at = now()
        WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING code_hash`,
      [id, hash],
    )
    if (rows.length > 0)
      await this.db.query(
        `UPDATE users SET totp_failures = 0, totp_locked_until = NULL WHERE id = $1`,
        [id],
      )
    return rows.length > 0
  }

  async recoveryCodesLeft(id: string): Promise<number> {
    const rows = await this.db.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
      [id],
    )
    return Number(rows[0]?.n ?? 0)
  }

  async deleteExpiredSessions(): Promise<number> {
    const rows = await this.db.query<{ jti: string }>(
      `DELETE FROM sessions WHERE expires_at < now() - interval '1 day' RETURNING jti`,
    )
    return rows.length
  }

  async gatewayCanBind(gatewaySn: string, sn?: string): Promise<boolean> {
    const credential = (
      await this.db.query<GatewayCredentialRow>(
        'SELECT * FROM gateway_credentials WHERE gateway_sn=$1',
        [gatewaySn],
      )
    )[0]
    // The local simulator and pre-RBAC credentials have no user owner.
    if (!credential) return true
    if (
      credential.revoked ||
      (credential.expires_at && new Date(credential.expires_at).getTime() <= Date.now())
    )
      return false
    if (!credential.user_id) return true
    const owner = await this.findUserById(credential.user_id)
    return Boolean(
      owner &&
      !owner.disabled &&
      !owner.must_change_password &&
      owner.session_version === credential.session_version &&
      can(
        {
          role: owner.role,
          permissions: owner.permissions,
          allDrones: owner.all_drones,
          dronePermissions: owner.drone_permissions,
        },
        'drones.bind',
        sn,
      ),
    )
  }

  async deviceDeleted(sn: string): Promise<boolean> {
    const rows = await this.db.query<{ deleted: boolean }>(
      'SELECT deleted_at IS NOT NULL AS deleted FROM devices WHERE sn=$1',
      [sn],
    )
    return rows[0]?.deleted ?? false
  }

  /**
   * Neither deleted nor disabled. Both states hide an aircraft and refuse its data, so every
   * ingest path asks this one question; only the way back differs (admin re-enable vs. the
   * original controller rebinding). A missing row is available: an aircraft that has never
   * reported is not blocked.
   */
  async deviceUnavailable(sn: string): Promise<boolean> {
    const rows = await this.db.query<{ blocked: boolean }>(
      'SELECT (deleted_at IS NOT NULL OR disabled_at IS NOT NULL) AS blocked FROM devices WHERE sn=$1',
      [sn],
    )
    return rows[0]?.blocked ?? false
  }

  /**
   * Both answers report whether the aircraft is in the requested state afterwards, so a
   * repeated request is a successful no-op rather than a 404 — a toggle that races a poll
   * must not look like "unknown drone". Only a missing or deleted row is a genuine miss.
   */
  async setDeviceDisabled(sn: string, disabled: boolean, actor: string): Promise<boolean> {
    const rows = await this.db.query(
      `WITH changed AS (
         UPDATE devices SET disabled_at = CASE WHEN $2 THEN now() END, online = FALSE
         WHERE sn=$1 AND deleted_at IS NULL
           AND (disabled_at IS NOT NULL) <> $2
         RETURNING sn)
       INSERT INTO device_events(device_sn,kind,payload)
       SELECT sn, CASE WHEN $2 THEN 'device_disabled' ELSE 'device_enabled' END,
              jsonb_build_object('actor',$3::text)
       FROM changed RETURNING device_sn`,
      [sn, disabled, actor],
    )
    if (rows.length > 0) return true
    // No row changed: either it was already in that state, or it does not exist / is deleted.
    const current = await this.db.query<{ state: boolean }>(
      `SELECT (disabled_at IS NOT NULL) AS state FROM devices
       WHERE sn=$1 AND deleted_at IS NULL`,
      [sn],
    )
    return (current[0]?.state ?? null) === disabled
  }

  /** The admin inventory: every aircraft, including the ones hidden from the fleet view. */
  async listAllDevices(): Promise<
    {
      sn: string
      gateway_sn: string | null
      model: string | null
      display_name: string | null
      label: string | null
      online: boolean
      last_seen_at: Date | string | null
      disabled_at: Date | string | null
      deleted_at: Date | string | null
    }[]
  > {
    return this.db.query(
      `SELECT sn, gateway_sn, model, display_name, label, online, last_seen_at, disabled_at, deleted_at
       FROM devices ORDER BY (deleted_at IS NOT NULL), (disabled_at IS NOT NULL), sn`,
    )
  }

  /** Who deleted what, for the deleted-aircraft list. */
  async deviceDeletionEvents(): Promise<
    { device_sn: string | null; ts: Date | string; payload: unknown }[]
  > {
    return this.db.query(
      `SELECT device_sn, ts, payload FROM device_events
       WHERE kind = 'device_deleted' ORDER BY ts DESC LIMIT 500`,
    )
  }

  async deleteDevice(sn: string, actor: string): Promise<boolean> {
    const rows = await this.db.query(
      `WITH removed AS (
      UPDATE devices SET deleted_at=now(),online=FALSE WHERE sn=$1 AND deleted_at IS NULL RETURNING sn)
      INSERT INTO device_events(device_sn,kind,payload)
      SELECT sn,'device_deleted',jsonb_build_object('actor',$2::text) FROM removed RETURNING device_sn`,
      [sn, actor],
    )
    return rows.length > 0
  }

  async rebindDevice(sn: string, gatewaySn: string, actor: string): Promise<boolean> {
    const rows = await this.db.query(
      `WITH rebound AS (
      UPDATE devices SET deleted_at=NULL,online=FALSE WHERE sn=$1 AND gateway_sn=$2 AND deleted_at IS NOT NULL RETURNING sn)
      INSERT INTO device_events(device_sn,kind,payload)
      SELECT sn,'device_rebound',jsonb_build_object('actor',$3::text) FROM rebound RETURNING device_sn`,
      [sn, gatewaySn, actor],
    )
    return rows.length > 0
  }

  async upsertGatewayCredential(
    gatewaySn: string,
    username: string,
    passwordHash: string,
    expiresAt: Date,
    userId?: string,
    sessionVersion?: number,
  ): Promise<void> {
    // `revoked` is never reset here. `user-info` is controller-driven, so if it cleared the
    // flag a still-approved controller could undo `gateway:revoke` by calling it again. The
    // only paths that un-revoke are an enrolment approval and an explicit admin re-approve
    // (`approveEnrollment`), which are human decisions with an audit row.
    await this.db.query(
      `INSERT INTO gateway_credentials (gateway_sn, username, password_hash, expires_at, revoked, user_id, session_version)
       VALUES ($1, $2, $3, $4, FALSE, $5, $6)
       ON CONFLICT (gateway_sn) DO UPDATE
         SET username = EXCLUDED.username,
             password_hash = EXCLUDED.password_hash,
             expires_at = EXCLUDED.expires_at,
             user_id = EXCLUDED.user_id,
             session_version = EXCLUDED.session_version`,
      [gatewaySn, username, passwordHash, expiresAt, userId ?? null, sessionVersion ?? null],
    )
  }

  async findGatewayCredentialByUsername(username: string): Promise<GatewayCredentialRow | null> {
    const rows = await this.db.query<GatewayCredentialRow>(
      `SELECT gateway_sn, username, password_hash, expires_at, revoked, user_id, session_version
       FROM gateway_credentials WHERE username = $1`,
      [username],
    )
    return rows[0] ?? null
  }

  async revokeGatewayCredential(gatewaySn: string): Promise<void> {
    await this.db.query(`UPDATE gateway_credentials SET revoked = TRUE WHERE gateway_sn = $1`, [
      gatewaySn,
    ])
  }

  async aircraftSnsForGateway(gatewaySn: string): Promise<string[]> {
    const rows = await this.db.query<{ sn: string }>(
      `SELECT sn FROM devices WHERE gateway_sn = $1 AND deleted_at IS NULL`,
      [gatewaySn],
    )
    return rows.map((row) => row.sn)
  }

  async upsertGateway(sn: string, workspaceId: string, model: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO gateways (sn, workspace_id, model, online, last_seen_at)
       VALUES ($1, $2, $3, TRUE, now())
       ON CONFLICT (sn) DO UPDATE
         SET workspace_id = EXCLUDED.workspace_id,
             model = COALESCE(EXCLUDED.model, gateways.model),
             online = TRUE,
             last_seen_at = now()`,
      [sn, workspaceId, model],
    )
  }

  /**
   * Bind an aircraft to the controller that reported it. The first controller to report a
   * serial owns it; another controller is refused rather than allowed to steal the row.
   * When an admin has listed explicit aircraft for the controller, only those may be
   * claimed. A successful first claim records the pairing so it is visible to admins and
   * becomes sticky from then on.
   */
  async claimDevice(input: {
    sn: string
    gatewaySn: string
    workspaceId: string
    model: string | null
    domain: number | null
    type: number | null
    subType: number | null
    controlIndex: number | null
  }): Promise<'claimed' | 'conflict'> {
    if (await this.isVideoSource(input.sn)) return 'conflict'
    const allowed = await this.aircraftSnsForController(input.gatewaySn)
    if (allowed.length > 0 && !allowed.includes(input.sn)) return 'conflict'

    const rows = await this.db.query<{ sn: string; inserted: boolean }>(
      `INSERT INTO devices (sn, gateway_sn, workspace_id, model, domain, type, sub_type, control_index, online, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, now())
       ON CONFLICT (sn) DO UPDATE
         SET gateway_sn = COALESCE(devices.gateway_sn, EXCLUDED.gateway_sn),
             workspace_id = EXCLUDED.workspace_id,
             model = COALESCE(EXCLUDED.model, devices.model),
             online = TRUE,
             last_seen_at = now()
       WHERE devices.deleted_at IS NULL
         AND (devices.gateway_sn IS NULL OR devices.gateway_sn = EXCLUDED.gateway_sn)
       RETURNING sn, (xmax = 0) AS inserted`,
      [
        input.sn,
        input.gatewaySn,
        input.workspaceId,
        input.model,
        input.domain,
        input.type,
        input.subType,
        input.controlIndex,
      ],
    )
    if (rows.length === 0) return 'conflict'
    if (rows[0]?.inserted) await this.grantNewDroneToOwner(input.sn, input.gatewaySn)

    // The pairing row is the audit trail for an approved controller. A controller without an
    // enrolment (the dev simulator before seeding, a unit test) still owns the aircraft
    // through `devices.gateway_sn`; only the pairing record is skipped.
    await this.db.query(
      `INSERT INTO controller_aircraft (controller_sn, aircraft_sn)
       SELECT $1, $2 WHERE EXISTS (
         SELECT 1 FROM controller_enrollments WHERE controller_sn = $1
       )
       ON CONFLICT DO NOTHING`,
      [input.gatewaySn, input.sn],
    )
    return 'claimed'
  }

  async enrollmentFor(controllerSn: string): Promise<EnrollmentRow | null> {
    const rows = await this.db.query<EnrollmentRow>(
      `SELECT * FROM controller_enrollments WHERE controller_sn = $1`,
      [controllerSn],
    )
    return rows[0] ?? null
  }

  /** Only an admin-approved controller may connect, claim aircraft or publish telemetry. */
  async isControllerApproved(controllerSn: string): Promise<boolean> {
    const rows = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM controller_enrollments
         WHERE controller_sn = $1 AND status = 'approved'
       ) AS exists`,
      [controllerSn],
    )
    return rows[0]?.exists ?? false
  }

  /** The controller that owns an aircraft, or undefined when the serial is unknown. */
  async deviceGateway(sn: string): Promise<string | null | undefined> {
    const rows = await this.db.query<{ gateway_sn: string | null }>(
      `SELECT gateway_sn FROM devices WHERE sn = $1`,
      [sn],
    )
    return rows[0] ? rows[0].gateway_sn : undefined
  }

  async aircraftSnsForController(controllerSn: string): Promise<string[]> {
    const rows = await this.db.query<{ aircraft_sn: string }>(
      `SELECT aircraft_sn FROM controller_aircraft WHERE controller_sn = $1 ORDER BY aircraft_sn`,
      [controllerSn],
    )
    return rows.map((row) => row.aircraft_sn)
  }

  async createPendingEnrollment(
    controllerSn: string,
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO controller_enrollments (controller_sn, workspace_id, user_id, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (controller_sn) DO UPDATE SET last_seen_at = now()`,
      [controllerSn, workspaceId, userId],
    )
  }

  async touchEnrollment(controllerSn: string): Promise<void> {
    await this.db.query(
      `UPDATE controller_enrollments SET last_seen_at = now() WHERE controller_sn = $1`,
      [controllerSn],
    )
  }

  async listEnrollments(): Promise<EnrollmentSummary[]> {
    const rows = await this.db.query<EnrollmentRow & { aircraft_sns: string[] | null }>(
      `SELECT e.controller_sn, e.workspace_id, e.user_id, e.status, e.note, e.approved_by,
              e.approved_at, e.created_at, e.last_seen_at,
              COALESCE(json_agg(ca.aircraft_sn ORDER BY ca.aircraft_sn)
                       FILTER (WHERE ca.aircraft_sn IS NOT NULL), '[]'::json) AS aircraft_sns
       FROM controller_enrollments e
       LEFT JOIN controller_aircraft ca ON ca.controller_sn = e.controller_sn
       GROUP BY e.controller_sn
       ORDER BY (e.status = 'pending') DESC, e.created_at DESC`,
    )
    return rows.map((row) => ({ ...row, aircraft_sns: row.aircraft_sns ?? [] }))
  }

  async approveEnrollment(
    controllerSn: string,
    aircraftSns: string[],
    approvedBy: string,
  ): Promise<boolean> {
    // Upsert: an admin or the CLI may pre-approve a controller before it is first powered on,
    // which is how a deployment is staged. A serial that never appears simply stays unused.
    const rows = await this.db.query<{ controller_sn: string }>(
      `INSERT INTO controller_enrollments (controller_sn, status, approved_by, approved_at)
       VALUES ($1, 'approved', $2, now())
       ON CONFLICT (controller_sn) DO UPDATE
         SET status = 'approved', approved_by = $2, approved_at = now(), note = NULL
       RETURNING controller_sn`,
      [controllerSn, approvedBy],
    )
    if (rows.length === 0) return false

    // Approval is the one place that clears a revocation. Without this, a controller that was
    // rejected or revoked once could never come back: `upsertGatewayCredential` no longer
    // re-enables itself.
    await this.db.query(`UPDATE gateway_credentials SET revoked = FALSE WHERE gateway_sn = $1`, [
      controllerSn,
    ])

    for (const aircraftSn of aircraftSns) {
      await this.db.query(
        `INSERT INTO controller_aircraft (controller_sn, aircraft_sn) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [controllerSn, aircraftSn],
      )
      await this.db.query(
        `UPDATE devices SET gateway_sn = $1
         WHERE sn = $2 AND (gateway_sn IS NULL OR gateway_sn = $1)`,
        [controllerSn, aircraftSn],
      )
    }
    return true
  }

  /** Reject or unbind: the controller keeps its row for audit but loses everything else. */
  async revokeEnrollment(controllerSn: string, by: string, note: string): Promise<boolean> {
    const rows = await this.db.query<{ controller_sn: string }>(
      `UPDATE controller_enrollments
       SET status = 'rejected', approved_by = $2, approved_at = NULL, note = $3
       WHERE controller_sn = $1
       RETURNING controller_sn`,
      [controllerSn, by, note],
    )
    if (rows.length === 0) return false

    await this.db.query(`DELETE FROM controller_aircraft WHERE controller_sn = $1`, [controllerSn])
    await this.db.query(
      `UPDATE devices SET gateway_sn = NULL, online = FALSE WHERE gateway_sn = $1`,
      [controllerSn],
    )
    await this.revokeGatewayCredential(controllerSn)
    return true
  }

  async logDeviceEvent(sn: string | null, kind: string, payload: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO device_events (device_sn, kind, payload) VALUES ($1, $2, $3::jsonb)`,
      [sn, kind, JSON.stringify(payload)],
    )
  }

  async markGatewayOffline(sn: string): Promise<void> {
    await this.db.query(`UPDATE gateways SET online = FALSE WHERE sn = $1`, [sn])
    await this.db.query(`UPDATE devices SET online = FALSE WHERE gateway_sn = $1`, [sn])
  }

  async touchGateway(sn: string): Promise<void> {
    await this.db.query(`UPDATE gateways SET online = TRUE, last_seen_at = now() WHERE sn = $1`, [
      sn,
    ])
  }

  async touchDevice(sn: string): Promise<void> {
    await this.db.query(
      `UPDATE devices SET online = TRUE, last_seen_at = now()
       WHERE sn = $1 AND deleted_at IS NULL AND disabled_at IS NULL`,
      [sn],
    )
  }

  async setDeviceOffline(sn: string): Promise<void> {
    await this.db.query(`UPDATE devices SET online = FALSE WHERE sn = $1`, [sn])
  }

  async setDeviceName(sn: string, displayName: string | null): Promise<boolean> {
    const rows = await this.db.query<{ sn: string }>(
      `UPDATE devices SET display_name = $2 WHERE sn = $1 RETURNING sn`,
      [sn, displayName],
    )
    return rows.length > 0
  }

  async setDeviceLabel(sn: string, label: string | null): Promise<boolean> {
    const rows = await this.db.query<{ sn: string }>(
      `UPDATE devices SET label = $2 WHERE sn = $1 RETURNING sn`,
      [sn, label],
    )
    return rows.length > 0
  }

  /** Last-resort liveness check when no topology message arrives. */
  async markStaleOffline(seconds: number): Promise<string[]> {
    const devices = await this.db.query<{ sn: string }>(
      `UPDATE devices SET online = FALSE
       WHERE online = TRUE AND rtmp_key IS NULL AND (last_seen_at IS NULL OR last_seen_at < now() - ($1 || ' seconds')::interval)
       RETURNING sn`,
      [String(seconds)],
    )
    const gateways = await this.db.query<{ sn: string }>(
      `UPDATE gateways SET online = FALSE
       WHERE online = TRUE AND (last_seen_at IS NULL OR last_seen_at < now() - ($1 || ' seconds')::interval)
       RETURNING sn`,
      [String(seconds)],
    )
    return [...devices, ...gateways].map((row) => row.sn)
  }

  async deviceExists(sn: string): Promise<boolean> {
    const rows = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM devices WHERE sn = $1) AS exists`,
      [sn],
    )
    return rows[0]?.exists ?? false
  }

  async gatewayExists(sn: string): Promise<boolean> {
    const rows = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM gateways WHERE sn = $1) AS exists`,
      [sn],
    )
    return rows[0]?.exists ?? false
  }

  async setDeviceCapacity(sn: string, capacity: unknown, cameras: CameraSummary[]): Promise<void> {
    await this.db.query(
      `UPDATE devices SET live_capacity = $2::jsonb, cameras = $3::jsonb WHERE sn = $1`,
      [sn, JSON.stringify(capacity), JSON.stringify(cameras)],
    )
  }

  async insertSample(sample: TelemetrySample): Promise<void> {
    await this.db.query(
      `INSERT INTO telemetry_samples
        (device_sn, ts, lat, lon, alt_rel, alt_abs, heading, speed_h, speed_v, battery_pct, mode, gnss, rtk, raw)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb
       WHERE EXISTS (SELECT 1 FROM devices WHERE sn=$1 AND deleted_at IS NULL AND disabled_at IS NULL)`,
      [
        sample.sn,
        new Date(sample.ts),
        sample.lat,
        sample.lon,
        sample.altRel,
        sample.altAbs,
        sample.heading,
        sample.speedH,
        sample.speedV,
        sample.batteryPct,
        sample.mode,
        sample.gnss,
        sample.rtk,
        JSON.stringify(sample.raw),
      ],
    )
  }

  async listDevices(): Promise<DeviceListRow[]> {
    return this.db.query<DeviceListRow>(
      `SELECT d.sn, d.gateway_sn, d.model, d.display_name, d.label, (d.rtmp_key IS NOT NULL) AS video_only,
              d.online, d.last_seen_at, d.cameras,
              d.color, t.ts AS sample_ts, t.lat, t.lon, t.alt_rel, t.alt_abs, t.heading,
              t.speed_h, t.speed_v, t.battery_pct, t.mode, t.gnss, t.rtk,
              -- DJI's own flight-time-left estimate, read from the stored payload. Nested CASE, not
              -- AND, because Postgres may evaluate AND operands in any order and the cast must
              -- never see a string. 1 s to 24 h only (REMAIN_FLIGHT_MAX_S); 0 means "on the ground".
              CASE WHEN jsonb_typeof(t.raw #> '{battery,remain_flight_time}') = 'number' THEN
                CASE WHEN (t.raw #>> '{battery,remain_flight_time}')::numeric BETWEEN 1 AND 86400
                  THEN round((t.raw #>> '{battery,remain_flight_time}')::numeric)::int END
              END AS remain_flight_s
       FROM devices d
       LEFT JOIN LATERAL (
         SELECT * FROM telemetry_samples s
         WHERE s.device_sn = d.sn
         ORDER BY s.ts DESC
         LIMIT 1
       ) t ON TRUE
       WHERE d.deleted_at IS NULL AND d.disabled_at IS NULL
       ORDER BY d.sn`,
    )
  }

  async telemetry(sn: string, sinceIso: string, limit = 3000): Promise<TelemetryRow[]> {
    return this.db.query<TelemetryRow>(
      `SELECT ts, lat, lon, alt_rel, alt_abs, heading, speed_h, speed_v, battery_pct, mode, gnss, rtk
       FROM telemetry_samples
       WHERE device_sn = $1 AND ts >= $2::timestamptz
       ORDER BY ts ASC
       LIMIT $3`,
      [sn, sinceIso, limit],
    )
  }

  async trail(sn: string, sinceIso: string, limit = 600): Promise<TelemetryRow[]> {
    return this.db.query<TelemetryRow>(
      `SELECT ts, lat, lon, alt_rel, alt_abs, heading, speed_h, speed_v, battery_pct, mode, gnss, rtk
       FROM telemetry_samples
       WHERE device_sn = $1 AND ts >= $2::timestamptz AND lat IS NOT NULL AND lon IS NOT NULL
       ORDER BY ts ASC
       LIMIT $3`,
      [sn, sinceIso, limit],
    )
  }

  /** The most recent fix newer than `sinceIso`, or null when the aircraft has none. */
  async latestPosition(
    sn: string,
    sinceIso: string,
  ): Promise<{ lat: number; lon: number; alt_rel: number | null } | null> {
    const rows = await this.db.query<{ lat: number; lon: number; alt_rel: number | null }>(
      `SELECT lat, lon, alt_rel
       FROM telemetry_samples
       WHERE device_sn = $1 AND ts >= $2::timestamptz
         AND lat IS NOT NULL AND lon IS NOT NULL AND NOT (lat = 0 AND lon = 0)
       ORDER BY ts DESC
       LIMIT 1`,
      [sn, sinceIso],
    )
    return rows[0] ?? null
  }

  async deviceLabel(sn: string): Promise<string | null> {
    const rows = await this.db.query<{ name: string | null }>(
      `SELECT ${DEVICE_NAME_SQL} AS name FROM devices d WHERE d.sn = $1`,
      [sn],
    )
    return rows[0]?.name ?? null
  }

  async insertScreenshot(input: {
    id: string
    deviceSn: string
    deviceLabel: string | null
    missionId: string | null
    filename: string
    storageKey: string
    contentType: string
    sizeBytes: number
    width: number | null
    height: number | null
    capturedAt: string
    operatorId: string | null
    lat: number | null
    lon: number | null
    altRel: number | null
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO screenshots (id, device_sn, device_label, mission_id, filename, storage_key,
         content_type, size_bytes, width, height, captured_at, operator_id, lat, lon, alt_rel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13, $14, $15)`,
      [
        input.id,
        input.deviceSn,
        input.deviceLabel,
        input.missionId,
        input.filename,
        input.storageKey,
        input.contentType,
        input.sizeBytes,
        input.width,
        input.height,
        input.capturedAt,
        input.operatorId,
        input.lat,
        input.lon,
        input.altRel,
      ],
    )
  }

  async getScreenshot(id: string): Promise<ScreenshotRow | null> {
    const rows = await this.db.query<ScreenshotRow>(
      `SELECT s.*, u.email AS operator_email,
         p.ai_count AS people_ai_count, p.verified_count AS people_verified_count
       FROM screenshots s LEFT JOIN users u ON u.id = s.operator_id
         LEFT JOIN screenshot_people p ON p.screenshot_id = s.id
       WHERE s.id = $1`,
      [id],
    )
    return rows[0] ?? null
  }

  /** Removes the rows (their people counts go with them) and says what was removed. */
  async deleteScreenshots(
    ids: string[],
  ): Promise<{ id: string; storage_key: string; filename: string; device_sn: string }[]> {
    if (ids.length === 0) return []
    const marks = ids.map((_, index) => `$${index + 1}`).join(', ')
    return this.db.query(
      `DELETE FROM screenshots WHERE id IN (${marks})
       RETURNING id, storage_key, filename, device_sn`,
      ids,
    )
  }

  async listScreenshots(filter: ScreenshotFilter): Promise<ScreenshotRow[]> {
    const where: string[] = []
    const params: unknown[] = []
    const add = (clause: string, value: unknown) => {
      params.push(value)
      where.push(clause.replace('?', `$${params.length}`))
    }
    if (filter.allowedSns) add('s.device_sn = ANY(?::text[])', filter.allowedSns)
    if (filter.deviceSn) add('s.device_sn = ?', filter.deviceSn)
    if (filter.missionId) add('s.mission_id = ?', filter.missionId)
    if (filter.fromIso) add('s.captured_at >= ?::timestamptz', filter.fromIso)
    if (filter.toIso) add('s.captured_at < ?::timestamptz', filter.toIso)
    if (filter.beforeIso) add('s.captured_at < ?::timestamptz', filter.beforeIso)
    params.push(filter.limit)

    return this.db.query<ScreenshotRow>(
      `SELECT s.*, u.email AS operator_email,
         p.ai_count AS people_ai_count, p.verified_count AS people_verified_count
       FROM screenshots s LEFT JOIN users u ON u.id = s.operator_id
         LEFT JOIN screenshot_people p ON p.screenshot_id = s.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.captured_at DESC, s.id DESC
       LIMIT $${params.length}`,
      params,
    )
  }

  async getPeople(screenshotId: string): Promise<PeopleRow | null> {
    const rows = await this.db.query<PeopleRow>(
      `SELECT p.*, a.email AS analyzed_by_email, v.email AS verified_by_email
       FROM screenshot_people p
         LEFT JOIN users a ON a.id = p.analyzed_by
         LEFT JOIN users v ON v.id = p.verified_by
       WHERE p.screenshot_id = $1`,
      [screenshotId],
    )
    return rows[0] ?? null
  }

  /**
   * Store a model result. It replaces an earlier result, and clears its verification, only when
   * `replaceVerified` is set (an operator asked to count again). A background refinement never
   * overwrites a count someone has verified. Returns whether the result was stored.
   */
  async savePeopleAnalysis(input: {
    screenshotId: string
    stage: 'quick' | 'thorough'
    model: string
    aiCount: number
    detections: PeopleDetection[]
    durationMs: number
    analyzedBy: string | null
    replaceVerified: boolean
  }): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO screenshot_people (screenshot_id, stage, model, ai_count, detections,
         duration_ms, analyzed_by, analyzed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
       ON CONFLICT (screenshot_id) DO UPDATE SET
         stage = EXCLUDED.stage, model = EXCLUDED.model, ai_count = EXCLUDED.ai_count,
         detections = EXCLUDED.detections, duration_ms = EXCLUDED.duration_ms,
         analyzed_by = EXCLUDED.analyzed_by, analyzed_at = now(), marks = NULL,
         verified_count = NULL, verified_by = NULL, verified_at = NULL
       WHERE screenshot_people.verified_count IS NULL OR $8
       RETURNING screenshot_id`,
      [
        input.screenshotId,
        input.stage,
        input.model,
        input.aiCount,
        JSON.stringify(input.detections),
        input.durationMs,
        input.analyzedBy,
        input.replaceVerified,
      ],
    )
    return rows.length > 0
  }

  /** False when the still has no model result yet; a verification always starts from one. */
  async savePeopleVerification(
    screenshotId: string,
    marks: PeopleMark[],
    userId: string | null,
  ): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE screenshot_people
       SET marks = $2::jsonb, verified_count = $3, verified_by = $4, verified_at = now()
       WHERE screenshot_id = $1
       RETURNING screenshot_id`,
      [screenshotId, JSON.stringify(marks), marks.length, userId],
    )
    return rows.length > 0
  }

  /**
   * Every stream write is guarded by the expected state and bumps `rev`, so a stale reply or
   * a racing caller can never overwrite a newer state. `null` means the guard did not match.
   */
  async createStream(input: {
    id: string
    deviceSn: string
    videoId: string
    streamKey: string
    quality: number
    requestedBy: string | null
  }): Promise<StreamRow | null> {
    try {
      const rows = await this.db.query<StreamRow>(
        `INSERT INTO streams (id, device_sn, video_id, stream_key, state, quality, requested_by)
         VALUES ($1, $2, $3, $4, 'starting', $5, $6)
         RETURNING *`,
        [
          input.id,
          input.deviceSn,
          input.videoId,
          input.streamKey,
          input.quality,
          input.requestedBy,
        ],
      )
      return rows[0] ?? null
    } catch (error) {
      // The partial unique index rejected a second active stream for this video.
      if (isUniqueViolation(error)) return null
      throw error
    }
  }

  async getStream(id: string): Promise<StreamRow | null> {
    const rows = await this.db.query<StreamRow>(`SELECT * FROM streams WHERE id = $1`, [id])
    return rows[0] ?? null
  }

  async getStreamByKey(key: string): Promise<StreamRow | null> {
    const rows = await this.db.query<StreamRow>(`SELECT * FROM streams WHERE stream_key = $1`, [
      key,
    ])
    return rows[0] ?? null
  }

  async activeStreamFor(deviceSn: string, videoId: string): Promise<StreamRow | null> {
    const rows = await this.db.query<StreamRow>(
      `SELECT * FROM streams
       WHERE device_sn = $1 AND video_id = $2 AND state IN ('starting', 'live')
       LIMIT 1`,
      [deviceSn, videoId],
    )
    return rows[0] ?? null
  }

  async activeStreamsForDevice(deviceSn: string): Promise<StreamRow[]> {
    return this.db.query<StreamRow>(
      `SELECT * FROM streams
       WHERE device_sn = $1 AND state IN ('starting', 'live')`,
      [deviceSn],
    )
  }

  /**
   * The key of the stream that is live for this drone right now, or null. A video-only drone has
   * one fixed row that goes live and stopped, so this answers for it too.
   */
  async liveStreamKeyFor(sn: string): Promise<string | null> {
    const rows = await this.db.query<{ stream_key: string }>(
      `SELECT stream_key FROM streams
       WHERE device_sn = $1 AND state = 'live'
       ORDER BY updated_at DESC LIMIT 1`,
      [sn],
    )
    return rows[0]?.stream_key ?? null
  }

  async activeStreams(): Promise<StreamRow[]> {
    return this.db.query<StreamRow>(`SELECT * FROM streams WHERE state IN ('starting', 'live')`)
  }

  async markLive(id: string): Promise<StreamRow | null> {
    try {
      const rows = await this.db.query<StreamRow>(
        `UPDATE streams
         SET state = 'live', error = NULL, stopped_at = NULL, rev = rev + 1, updated_at = now()
         WHERE id = $1 AND state IN ('starting', 'error')
         RETURNING *`,
        [id],
      )
      return rows[0] ?? null
    } catch (error) {
      if (isUniqueViolation(error)) return null
      throw error
    }
  }

  async markReconnecting(id: string): Promise<StreamRow | null> {
    const rows = await this.db.query<StreamRow>(
      `UPDATE streams
       SET state = 'starting', error = 'reconnecting', rev = rev + 1, updated_at = now()
       WHERE id = $1 AND state = 'live'
       RETURNING *`,
      [id],
    )
    return rows[0] ?? null
  }

  async failStream(id: string, error: string): Promise<StreamRow | null> {
    const rows = await this.db.query<StreamRow>(
      `UPDATE streams
       SET state = 'error', error = $2, stopped_at = now(), rev = rev + 1, updated_at = now()
       WHERE id = $1 AND state = 'starting'
       RETURNING *`,
      [id, error],
    )
    return rows[0] ?? null
  }

  async stopStream(id: string, reason: string): Promise<StreamRow | null> {
    const rows = await this.db.query<StreamRow>(
      `UPDATE streams
       SET state = 'stopped', error = $2, stopped_at = now(), rev = rev + 1, updated_at = now()
       WHERE id = $1 AND state IN ('starting', 'live', 'error')
       RETURNING *`,
      [id, reason],
    )
    return rows[0] ?? null
  }

  async setStreamQuality(id: string, quality: number): Promise<StreamRow | null> {
    const rows = await this.db.query<StreamRow>(
      `UPDATE streams
       SET quality = $2, rev = rev + 1, updated_at = now()
       WHERE id = $1 AND state IN ('starting', 'live')
       RETURNING *`,
      [id, quality],
    )
    return rows[0] ?? null
  }

  async staleStarting(seconds: number): Promise<StreamRow[]> {
    return this.db.query<StreamRow>(
      `SELECT * FROM streams
       WHERE state = 'starting' AND updated_at < now() - ($1 || ' seconds')::interval`,
      [String(seconds)],
    )
  }

  async streamsResetAtBoot(since: Date): Promise<StreamRow[]> {
    return this.db.query<StreamRow>(
      `SELECT * FROM streams WHERE error = 'api restarted' AND stopped_at >= $1`,
      [since],
    )
  }

  async snapshotStreams(): Promise<StreamRow[]> {
    return this.db.query<StreamRow>(
      `SELECT * FROM streams
       WHERE state IN ('starting', 'live') OR updated_at > now() - interval '2 minutes'
       ORDER BY updated_at DESC
       LIMIT 500`,
    )
  }

  // ---------- video-only drones (a pilot pushes RTMP from DJI Fly; no controller) ----------

  /** One stream row serves a video-only drone for good: it cycles live and stopped. */
  static sourceVideoId(sn: string): string {
    return `${sn}/rtmp/main`
  }

  async isVideoSource(sn: string): Promise<boolean> {
    const rows = await this.db.query<{ yes: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM devices WHERE sn = $1 AND rtmp_key IS NOT NULL) AS yes`,
      [sn],
    )
    return rows[0]?.yes ?? false
  }

  async createVideoSource(input: { sn: string; name: string; key: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO devices (sn, model, display_name, online, cameras, rtmp_key)
       VALUES ($1, 'Video only', $2, FALSE, $3::jsonb, $4)`,
      [
        input.sn,
        input.name,
        // A camera the dashboard can show: it has no lens choice, quality or zoom to offer.
        JSON.stringify([
          { cameraIndex: 'rtmp', videos: [{ videoIndex: 'main', videoType: 'normal' }] },
        ]),
        input.key,
      ],
    )
  }

  /** Who owns a push key, and whether that drone is out of service. Null: not a key of ours. */
  async videoSourceByKey(key: string): Promise<{ sn: string; unavailable: boolean } | null> {
    const rows = await this.db.query<{ sn: string; blocked: boolean }>(
      `SELECT sn, (deleted_at IS NOT NULL OR disabled_at IS NOT NULL) AS blocked
       FROM devices WHERE rtmp_key = $1`,
      [key],
    )
    return rows[0] ? { sn: rows[0].sn, unavailable: rows[0].blocked } : null
  }

  async videoSources(): Promise<{ sn: string; name: string | null; key: string }[]> {
    return this.db.query(
      `SELECT sn, display_name AS name, rtmp_key AS key FROM devices
       WHERE rtmp_key IS NOT NULL AND deleted_at IS NULL ORDER BY sn`,
    )
  }

  async videoSourceKey(sn: string): Promise<string | null> {
    const rows = await this.db.query<{ key: string }>(
      `SELECT rtmp_key AS key FROM devices WHERE sn = $1 AND rtmp_key IS NOT NULL`,
      [sn],
    )
    return rows[0]?.key ?? null
  }

  /** The push began: the one stream row goes live (created on the first push) and the drone is on. */
  async goLiveSource(sn: string, key: string, id: string): Promise<StreamRow | null> {
    const rows = await this.db.query<StreamRow>(
      `INSERT INTO streams (id, device_sn, video_id, stream_key, state, quality)
       VALUES ($1, $2, $3, $4, 'live', 2)
       ON CONFLICT (stream_key) DO UPDATE
         SET state = 'live', error = NULL, stopped_at = NULL, rev = streams.rev + 1,
             updated_at = now(),
             started_at = CASE WHEN streams.state = 'live' THEN streams.started_at ELSE now() END
       RETURNING *`,
      [id, sn, Store.sourceVideoId(sn), key],
    )
    await this.db.query(`UPDATE devices SET online = TRUE, last_seen_at = now() WHERE sn = $1`, [
      sn,
    ])
    return rows[0] ?? null
  }

  /**
   * A new key for a drone whose address leaked. The stream row follows it and stops; the old
   * key stops working at once. Returns the old key, or null for an unknown drone.
   */
  async rotateVideoSourceKey(sn: string, key: string): Promise<string | null> {
    const old = await this.videoSourceKey(sn)
    if (!old) return null
    await this.db.query(`UPDATE devices SET rtmp_key = $2, online = FALSE WHERE sn = $1`, [sn, key])
    await this.db.query(
      `UPDATE streams SET stream_key = $2, state = 'stopped', error = 'key changed',
         stopped_at = now(), rev = rev + 1, updated_at = now()
       WHERE device_sn = $1`,
      [sn, key],
    )
    return old
  }

  /** There is no controller to prove custody, so a video-only drone is removed outright. */
  async deleteVideoSource(sn: string): Promise<string | null> {
    const key = await this.videoSourceKey(sn)
    if (!key) return null
    await this.db.query(`DELETE FROM streams WHERE device_sn = $1`, [sn])
    await this.db.query(`DELETE FROM devices WHERE sn = $1 AND rtmp_key IS NOT NULL`, [sn])
    return key
  }

  async deviceForStream(sn: string): Promise<StreamDeviceRow | null> {
    const rows = await this.db.query<StreamDeviceRow>(
      `SELECT sn, gateway_sn, online, cameras FROM devices
       WHERE sn = $1 AND deleted_at IS NULL AND disabled_at IS NULL`,
      [sn],
    )
    return rows[0] ?? null
  }

  /** A server-wide setting saved from the app, or null when none was ever saved. */
  async getSetting<T>(key: string): Promise<T | null> {
    const rows = await this.db.query<{ value: T }>(
      `SELECT value FROM app_settings WHERE key = $1`,
      [key],
    )
    return rows[0]?.value ?? null
  }

  async setSetting(key: string, value: unknown, by: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now(), updated_by = $3`,
      [key, JSON.stringify(value), by],
    )
  }

  /** Deletes MQTT log lines older than `days`: a debugging aid that would otherwise grow for good. */
  async pruneMqttLog(days: number): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      `WITH gone AS (DELETE FROM mqtt_log WHERE ts < now() - make_interval(days => $1::int) RETURNING 1)
       SELECT count(*)::int AS n FROM gone`,
      [days],
    )
    return rows[0]?.n ?? 0
  }

  /** Deletes telemetry readings older than `days`, in batches so one run never locks the table for long. */
  async pruneTelemetry(days: number, batch = 20_000): Promise<number> {
    let total = 0
    for (;;) {
      const rows = await this.db.query<{ n: number }>(
        `WITH doomed AS (
           SELECT id FROM telemetry_samples
           WHERE ts < now() - make_interval(days => $1::int) ORDER BY id LIMIT $2
         ), gone AS (DELETE FROM telemetry_samples WHERE id IN (SELECT id FROM doomed) RETURNING 1)
         SELECT count(*)::int AS n FROM gone`,
        [days, batch],
      )
      const n = rows[0]?.n ?? 0
      total += n
      if (n < batch) return total
    }
  }

  async logMessage(topic: string, payload: unknown, valid: boolean): Promise<void> {
    await this.db.query(`INSERT INTO mqtt_log (topic, payload, valid) VALUES ($1, $2::jsonb, $3)`, [
      topic,
      JSON.stringify(payload ?? null),
      valid,
    ])
  }

  async recentMessages(
    limit = 200,
  ): Promise<{ id: number; ts: string; topic: string; payload: unknown; valid: boolean }[]> {
    const rows = await this.db.query<{
      id: string
      ts: Date | string
      topic: string
      payload: unknown
      valid: boolean
    }>(`SELECT id, ts, topic, payload, valid FROM mqtt_log ORDER BY id DESC LIMIT $1`, [limit])
    return rows.map((row) => ({ ...row, id: Number(row.id), ts: iso(row.ts) ?? '' }))
  }

  async devicesByGateway(gatewaySn: string): Promise<{ sn: string }[]> {
    return this.db.query<{ sn: string }>(
      `SELECT sn FROM devices WHERE gateway_sn = $1 AND deleted_at IS NULL`,
      [gatewaySn],
    )
  }

  async deviceGatewaySn(sn: string): Promise<string | null> {
    const rows = await this.db.query<{ gateway_sn: string | null }>(
      `SELECT gateway_sn FROM devices WHERE sn = $1`,
      [sn],
    )
    return rows[0]?.gateway_sn ?? null
  }

  async allDeviceSns(): Promise<string[]> {
    const rows = await this.db.query<{ sn: string }>(`SELECT sn FROM devices`)
    return rows.map((row) => row.sn)
  }

  async allGatewaySns(): Promise<string[]> {
    const rows = await this.db.query<{ sn: string }>(`SELECT sn FROM gateways`)
    return rows.map((row) => row.sn)
  }
}
