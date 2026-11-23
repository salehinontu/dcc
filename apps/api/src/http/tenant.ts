import type { CurrentUser } from '../auth'
import type { Store } from '../store'

/**
 * Whose work an account shares. A Developer is not limited (undefined). Everyone else works with
 * their own account and the accounts of the same Admin, and that is all of the installation's
 * shared data (zones, controllers) that is theirs. Drones are separate: they follow the drone
 * grants, see `readableSns`.
 */
export interface Tenant {
  ids: Set<string>
  emails: Set<string>
}

export async function tenantOf(store: Store, actor: CurrentUser): Promise<Tenant | undefined> {
  if (actor.role === 'developer') return undefined
  const members = await store.tenantUsers(actor.id, actor.adminId)
  return {
    ids: new Set(members.map((member) => member.id)),
    emails: new Set(members.map((member) => member.email.toLowerCase())),
  }
}
