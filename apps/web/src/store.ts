import { create } from 'zustand'
import type { CameraSummary, DeviceSummary, StreamState, TelemetrySample } from '@dji/protocol'

export interface DeviceStatusMessage {
  sn: string
  gatewaySn: string | null
  online: boolean
  lastSeenAt: string | null
}

interface FleetState {
  devices: Record<string, DeviceSummary>
  streams: Record<string, StreamState>
  selected: string | null
  connected: boolean
  search: string
  setDevices: (devices: DeviceSummary[]) => void
  setConnected: (connected: boolean) => void
  setSearch: (search: string) => void
  select: (sn: string | null) => void
  setDisplayName: (sn: string, displayName: string | null) => void
  applyProfile: (profile: {
    sn: string
    displayName: string | null
    label: string | null
    color: string
  }) => void
  applyStatus: (status: DeviceStatusMessage) => void
  applyTelemetry: (sample: TelemetrySample) => void
  applyStream: (stream: StreamState) => void
  replaceStreams: (streams: StreamState[]) => void
  setCameras: (sn: string, cameras: CameraSummary[]) => void
  removeDevice: (sn: string) => void
  removeStream: (id: string) => void
}

export const useFleet = create<FleetState>((set) => ({
  devices: {},
  streams: {},
  selected: null,
  connected: false,
  search: '',

  setDevices: (devices) =>
    set((state) => ({
      devices: Object.fromEntries(devices.map((device) => [device.sn, device])),
      selected: devices.some((d) => d.sn === state.selected)
        ? state.selected
        : (devices[0]?.sn ?? null),
    })),

  setConnected: (connected) => set({ connected }),

  setSearch: (search) => set({ search }),

  select: (sn) => set({ selected: sn }),

  setDisplayName: (sn, displayName) =>
    set((state) => {
      const device = state.devices[sn]
      if (!device) return state
      return { devices: { ...state.devices, [sn]: { ...device, displayName } } }
    }),

  applyProfile: (profile) =>
    set((state) => {
      const device = state.devices[profile.sn]
      if (!device) return state
      return {
        devices: {
          ...state.devices,
          [profile.sn]: {
            ...device,
            displayName: profile.displayName,
            label: profile.label,
            color: profile.color,
          },
        },
      }
    }),

  applyStatus: (status) =>
    set((state) => {
      const device = state.devices[status.sn]
      if (!device) return state
      return {
        devices: {
          ...state.devices,
          [status.sn]: {
            ...device,
            online: status.online,
            lastSeenAt: status.lastSeenAt ?? device.lastSeenAt,
          },
        },
      }
    }),

  applyTelemetry: (sample) =>
    set((state) => {
      const device = state.devices[sample.sn]
      if (!device) return state
      return {
        devices: {
          ...state.devices,
          [sample.sn]: {
            ...device,
            online: true,
            telemetry: sample,
            lastSeenAt: new Date(sample.ts).toISOString(),
          },
        },
      }
    }),

  applyStream: (stream) =>
    set((state) => {
      const existing = state.streams[stream.id]
      // Broadcasts can arrive out of order; `rev` is the authority.
      if (existing && existing.rev > stream.rev) return state

      const next = { ...state.streams, [stream.id]: stream }
      const stamp = Date.parse(stream.updatedAt)
      for (const [id, other] of Object.entries(next)) {
        if (id === stream.id || other.deviceSn !== stream.deviceSn) continue
        if (other.phase === 'starting' || other.phase === 'live') continue
        const otherStamp = Date.parse(other.updatedAt)
        if (!Number.isFinite(stamp) || !Number.isFinite(otherStamp) || otherStamp < stamp) {
          delete next[id]
        }
      }
      return { streams: next }
    }),

  replaceStreams: (streams) =>
    set({ streams: Object.fromEntries(streams.map((stream) => [stream.id, stream])) }),

  setCameras: (sn, cameras) =>
    set((state) => {
      const device = state.devices[sn]
      if (!device) return state
      return { devices: { ...state.devices, [sn]: { ...device, cameras } } }
    }),

  removeDevice: (sn) =>
    set((state) => {
      const devices = { ...state.devices }
      delete devices[sn]
      return {
        devices,
        selected: state.selected === sn ? (Object.keys(devices)[0] ?? null) : state.selected,
        streams: Object.fromEntries(
          Object.entries(state.streams).filter(([, stream]) => stream.deviceSn !== sn),
        ),
      }
    }),

  removeStream: (id) =>
    set((state) => {
      const next = { ...state.streams }
      delete next[id]
      return { streams: next }
    }),
}))
