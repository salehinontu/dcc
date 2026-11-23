import type { DeviceSummary } from '@dji/protocol'

/** The aircraft's name, or its model: what lists sort by, so a nickname never reorders them. */
export function deviceName(device: DeviceSummary): string {
  return device.displayName?.trim() || device.model || 'Drone'
}

/** The name, then the nickname when there is one: `Alpha · Fire-1`. */
export function deviceLabel(device: DeviceSummary): string {
  const label = device.label?.trim()
  return label ? `${deviceName(device)} · ${label}` : deviceName(device)
}

export function matchesSearch(device: DeviceSummary, search: string): boolean {
  const query = search.trim().toLowerCase()
  if (!query) return true

  return [device.displayName, device.label, device.sn, device.model]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(query))
}
