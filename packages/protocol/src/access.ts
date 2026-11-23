/**
 * Roles. A Developer is the vendor: created from the server CLI, holds everything and is the
 * only one who creates Admins. An Admin runs one customer's installation and creates
 * Sub-admins with any subset of their own access. A Pilot only signs a controller in from
 * the RC. Apart from the Developer, a role is a label: permissions decide access.
 */
export const ROLES = ['developer', 'admin', 'subadmin', 'pilot'] as const
export type Role = (typeof ROLES)[number]

/** Roles an account can be given from the console; a Developer only comes from the CLI. */
export const ASSIGNABLE_ROLES = ['admin', 'subadmin', 'pilot'] as const satisfies readonly Role[]

/**
 * Shortest password any account may have: the dashboard, the CLI and the Pilot sign-in all
 * read this one value, so they cannot drift apart.
 */
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

/** Explicit grants. */
export const PERMISSIONS = [
  'users.manage',
  'inventory.manage',
  'map.view',
  'wall.view',
  'shots.view',
  'recs.view',
  'history.view',
  'fleet.view',
  'drones.view',
  'drones.rename',
  'drones.delete',
  'drones.bind',
  'telemetry.view',
  'streams.view',
  'streams.control',
  'screenshots.view',
  'screenshots.capture',
  'screenshots.delete',
  'recordings.view',
  'recordings.record',
  'recordings.delete',
  'recordings.upload',
  'zones.view',
  'zones.manage',
  'alerts.view',
  'flights.view',
  'system.debug',
  'audit.view',
  'api.manage',
] as const
export type Permission = (typeof PERMISSIONS)[number]

/**
 * Grants that belong to the account, not to a drone: which screens it opens and whether it may
 * administer. They are never scoped per drone; which drones the screens then show is decided by
 * the drone grants, so a Developer can open a screen for an Admin and still choose the drones.
 */
export const ACCOUNT_PERMISSIONS: readonly Permission[] = [
  'users.manage',
  'inventory.manage',
  'map.view',
  'wall.view',
  'shots.view',
  'recs.view',
  'history.view',
  'fleet.view',
  'zones.view',
  'zones.manage',
  'alerts.view',
  'recordings.upload',
  'system.debug',
  'audit.view',
  'api.manage',
]
export interface Access {
  role: string
  permissions: Permission[]
  allDrones: boolean
  dronePermissions: Record<string, Permission[]>
}
export function can(user: Access, permission: Permission, sn?: string): boolean {
  if (user.role === 'developer') return true
  if (ACCOUNT_PERMISSIONS.includes(permission)) return user.permissions.includes(permission)
  if (sn !== undefined) {
    const grants = user.allDrones
      ? user.permissions
      : Object.hasOwn(user.dronePermissions, sn)
        ? (user.dronePermissions[sn] ?? [])
        : []
    return grants.includes('drones.view') && grants.includes(permission)
  }
  return (
    user.permissions.includes(permission) ||
    Object.values(user.dronePermissions).some((grants) => grants.includes(permission))
  )
}
/**
 * A Pilot account's whole access, fixed: see every aircraft and bind it to the controller the
 * account signs in. The controller checks both per aircraft, so it is never scoped.
 */
export const PILOT_PERMISSIONS: readonly Permission[] = ['drones.view', 'drones.bind']

export function defaultPermissions(role: string): Permission[] {
  if (role === 'developer' || role === 'admin') return [...PERMISSIONS]
  if (role === 'pilot') return [...PILOT_PERMISSIONS]
  return [
    'map.view',
    'wall.view',
    'shots.view',
    'recs.view',
    'history.view',
    'fleet.view',
    'drones.view',
    'telemetry.view',
    'streams.view',
    'screenshots.view',
    'screenshots.capture',
    // Watching what the server recorded; starting a recording uses server disk, so a Sub-admin
    // only gets `recordings.record` and `recordings.delete` when an Admin grants them.
    'recordings.view',
    'zones.view',
    'alerts.view',
    'flights.view',
  ]
}

/** Keeps known grants only: a stored account may still carry one that has been retired. */
export function knownPermissions(list: readonly string[]): Permission[] {
  return PERMISSIONS.filter((permission) => list.includes(permission))
}
