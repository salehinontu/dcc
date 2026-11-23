import { useEffect } from 'react'
import { create } from 'zustand'
import type { ActiveRecording } from '@dji/protocol'
import { api } from './api'

interface ServerRecordings {
  /** The recordings the server is making now, by drone serial. */
  bySn: Record<string, ActiveRecording>
  refresh: () => Promise<void>
}

/**
 * What the server is recording, shared by every button that starts or stops a server recording, so a wall
 * of sixteen tiles asks once, not sixteen times.
 */
export const useServerRecordings = create<ServerRecordings>((set) => ({
  bySn: {},
  refresh: async () => {
    try {
      const result = await api.activeRecordings()
      set({ bySn: Object.fromEntries(result.recordings.map((rec) => [rec.deviceSn, rec])) })
    } catch {
      // The buttons keep what they last knew; the next look tries again.
    }
  },
}))

/** Keeps the list fresh while a screen that shows server record buttons is open. */
export function useServerRecordingsWatch(enabled: boolean): void {
  const refresh = useServerRecordings((state) => state.refresh)
  useEffect(() => {
    if (!enabled) return undefined
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [enabled, refresh])
}
