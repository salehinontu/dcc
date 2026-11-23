import { create } from 'zustand'
import type { AlertRecord, Zone } from '@dji/protocol'
import { api } from './api'

const MAX_ALERTS = 200

interface FleetData {
  zones: Zone[]
  zonesLoaded: boolean
  /** Newest first. Open alerts have `clearedAt === null`. */
  alerts: AlertRecord[]
  /** Alerts the operator has not looked at yet; drives the toast and the bell count. */
  fresh: Record<string, true>
  /** An aircraft the map should centre on when it next shows (set by "show on map"). */
  focus: string | null
  setFocus: (sn: string | null) => void
  loadZones: () => Promise<void>
  loadAlerts: () => Promise<void>
  applyAlert: (alert: AlertRecord) => void
  markSeen: (id?: string) => void
  reset: () => void
}

export const useFleetData = create<FleetData>((set, get) => ({
  zones: [],
  zonesLoaded: false,
  alerts: [],
  fresh: {},
  focus: null,
  setFocus: (focus) => set({ focus }),

  loadZones: async () => {
    try {
      const { zones } = await api.zones()
      set({ zones, zonesLoaded: true })
    } catch {
      // the next change notice or reload retries
    }
  },

  loadAlerts: async () => {
    try {
      const { alerts } = await api.alerts({ limit: 100 })
      set({ alerts })
    } catch {
      // keep what is shown
    }
  },

  /** A raised alert, or a later state of one already known (cleared, acknowledged). */
  applyAlert: (alert) => {
    const { alerts, fresh } = get()
    const known = alerts.some((existing) => existing.id === alert.id)
    const next = known
      ? alerts.map((existing) => (existing.id === alert.id ? alert : existing))
      : [alert, ...alerts].slice(0, MAX_ALERTS)
    set({
      alerts: next,
      // Only a newly raised alert needs attention; later states of it do not.
      fresh:
        known || alert.clearedAt || alert.acknowledgedAt ? fresh : { ...fresh, [alert.id]: true },
    })
  },

  markSeen: (id) => {
    if (id === undefined) set({ fresh: {} })
    else {
      const { fresh } = get()
      if (!fresh[id]) return
      const next = { ...fresh }
      delete next[id]
      set({ fresh: next })
    }
  },

  reset: () =>
    set({
      zones: [],
      zonesLoaded: false,
      alerts: [],
      fresh: {},
      focus: null,
    }),
}))

/** Alerts that still apply: not cleared and not acknowledged. */
export function openAlerts(alerts: AlertRecord[]): AlertRecord[] {
  return alerts.filter((alert) => alert.clearedAt === null)
}
