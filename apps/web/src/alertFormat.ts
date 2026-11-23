import { isZoneAlert, type AlertKind, type AlertRecord } from '@dji/protocol'
import type { IconName } from './components/Icon'

export const alertKindLabel: Record<AlertKind, string> = {
  no_fly_warning: 'Approaching no-fly zone',
  no_fly_breach: 'Inside no-fly zone',
  geofence_exit: 'Left geofence',
  link_lost: 'Contact lost',
  battery_low: 'Low battery',
  battery_critical: 'Critical battery',
}

/** The icon that tells the kinds apart at a glance (toast, lists). */
export function alertIcon(kind: AlertKind): IconName {
  if (kind === 'link_lost') return 'signalOff'
  if (kind === 'battery_low' || kind === 'battery_critical') return 'battery'
  return 'zone'
}

/** How far from the zone edge, for a zone alert. An alert about the aircraft itself has no distance. */
export function distanceLabel(alert: AlertRecord): string | null {
  if (alert.distanceM === null) return null
  const meters = Math.abs(alert.distanceM)
  const text = meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`
  if (alert.kind === 'no_fly_breach') return `${text} inside`
  if (alert.kind === 'geofence_exit') return `${text} outside`
  return `${text} from edge`
}

/** What the alert is about: the zone's name, or for link lost and battery the sentence the server wrote. */
export function alertSubject(alert: AlertRecord): string {
  return isZoneAlert(alert.kind) && alert.zoneName ? alert.zoneName : alert.message
}

export function alertStatus(alert: AlertRecord): 'active' | 'cleared' {
  return alert.clearedAt === null ? 'active' : 'cleared'
}
