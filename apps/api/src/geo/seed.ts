import type { Store } from '../store'
import { BUILTIN_ZONES } from './builtin-zones'

/** Add the built-in no-fly zones that are missing. Safe to run on every start. */
export async function seedBuiltinZones(store: Store): Promise<number> {
  return store.fleet.seedBuiltinZones(BUILTIN_ZONES)
}
