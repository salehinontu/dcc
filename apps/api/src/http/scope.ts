import { can, type Access, type Permission } from '@dji/protocol'

/**
 * The serials an account may read for `permission`, or undefined when it may read them all.
 * Queries pass this straight to a `device_sn = ANY(...)` filter.
 */
export function readableSns(user: Access, permission: Permission): string[] | undefined {
  if (
    user.role === 'developer' ||
    (user.allDrones &&
      user.permissions.includes(permission) &&
      user.permissions.includes('drones.view'))
  )
    return undefined
  return Object.keys(user.dronePermissions).filter((sn) => can(user, permission, sn))
}
