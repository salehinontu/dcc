import type { ServerMessage, TelemetrySample } from '@dji/protocol'
import { withBase } from './base'
import { useFleetData } from './fleetData'
import { useFleet } from './store'

/**
 * One WebSocket for the whole page. Aircraft are *watched*, never started: the server ties
 * a watch to this connection, so closing the tab releases it. Refcounts are batched in a
 * microtask so a render that unwatches and rewatches the same aircraft sends nothing.
 */
const refs = new Map<string, number>()
const sent = new Set<string>()

let socket: WebSocket | null = null
let closed = true
let retryCount = 0
let retryTimer: number | undefined
let syncScheduled = false
let onOpen: (() => void) | undefined

/**
 * Set while this page is itself replacing its session. A self-service password change
 * revokes every token for the account — including the one this socket is authenticated
 * with — and hands the browser a new cookie, so the imminent 4001 means "reconnect", not
 * "you were signed out". Installed before the request because the server closes the socket
 * as soon as it revokes, which can beat the response back to the browser.
 */
let rotatingUntil = 0

export function beginSessionRotation(): void {
  rotatingUntil = Date.now() + 15_000
}

const pendingTelemetry = new Map<string, TelemetrySample>()
let telemetryTimer: number | undefined

function syncWatches(): void {
  if (syncScheduled) return
  syncScheduled = true
  queueMicrotask(() => {
    syncScheduled = false
    const current = socket
    if (!current || current.readyState !== WebSocket.OPEN) return

    const toWatch: string[] = []
    for (const [sn, count] of refs) {
      if (count > 0 && !sent.has(sn)) toWatch.push(sn)
    }
    const toUnwatch: string[] = []
    for (const sn of sent) {
      if ((refs.get(sn) ?? 0) <= 0) toUnwatch.push(sn)
    }

    if (toWatch.length > 0) {
      current.send(JSON.stringify({ type: 'watch', sns: toWatch }))
      for (const sn of toWatch) sent.add(sn)
    }
    if (toUnwatch.length > 0) {
      current.send(JSON.stringify({ type: 'unwatch', sns: toUnwatch }))
      for (const sn of toUnwatch) sent.delete(sn)
    }
  })
}

export function watch(sn: string): void {
  const count = refs.get(sn) ?? 0
  refs.set(sn, count + 1)
  if (count === 0) syncWatches()
}

export function unwatch(sn: string): void {
  const count = refs.get(sn) ?? 0
  if (count <= 1) {
    refs.delete(sn)
    if (count === 1) syncWatches()
    return
  }
  refs.set(sn, count - 1)
}

export function retry(sn: string): void {
  if (socket?.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'retry', sn }))
}

function queueTelemetry(sample: TelemetrySample): void {
  pendingTelemetry.set(sample.sn, sample)
  if (telemetryTimer !== undefined) return
  telemetryTimer = window.setTimeout(() => {
    telemetryTimer = undefined
    const batch = [...pendingTelemetry.values()]
    pendingTelemetry.clear()
    const apply = useFleet.getState().applyTelemetry
    for (const entry of batch) apply(entry)
  }, 250)
}

function handleMessage(raw: string): void {
  let message: ServerMessage
  try {
    message = JSON.parse(raw) as ServerMessage
  } catch {
    return
  }

  const store = useFleet.getState()
  switch (message.type) {
    case 'device.removed':
      pendingTelemetry.delete(message.data.sn)
      store.removeDevice(message.data.sn)
      return
    case 'telemetry':
      queueTelemetry(message.data)
      return
    case 'device.status':
      store.applyStatus(message.data)
      return
    case 'stream.state':
      store.applyStream(message.data)
      return
    case 'streams.snapshot':
      store.replaceStreams(message.data)
      return
    case 'device.cameras':
      store.setCameras(message.data.sn, message.data.cameras)
      return
    case 'device.profile':
      store.applyProfile(message.data)
      return
    case 'alert':
      useFleetData.getState().applyAlert(message.data)
      return
    case 'zones.changed':
      void useFleetData.getState().loadZones()
      return
    default:
      return
  }
}

function open(): void {
  if (closed) return
  // A retry timer can fire while a newer connection is already live (a StrictMode
  // disconnect/reconnect, or logout then login). Leave that one alone.
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const current = new WebSocket(`${protocol}//${location.host}${withBase('/ws')}`)
  socket = current

  current.onopen = () => {
    if (socket !== current) return
    retryCount = 0
    useFleet.getState().setConnected(true)
    current.send(JSON.stringify({ type: 'subscribe', channels: ['devices'] }))

    // A new connection has no watches: send every refcounted aircraft again.
    sent.clear()
    const watched = [...refs].filter(([, count]) => count > 0).map(([sn]) => sn)
    if (watched.length > 0) {
      current.send(JSON.stringify({ type: 'watch', sns: watched }))
      for (const sn of watched) sent.add(sn)
    }
    onOpen?.()
  }

  current.onmessage = (event) => {
    if (socket !== current) return
    handleMessage(String(event.data))
  }

  current.onclose = (event) => {
    // A replaced socket closing is not a lost connection: the live one owns the state.
    // Treating it as one used to flip the rail to "Reconnecting" and open a third socket.
    if (socket !== current) return

    if (event.code === 4001 || event.code === 4003) {
      // 4001 during our own password change is the old token dying, not a sign-out.
      if (event.code === 4001 && Date.now() < rotatingUntil) {
        retryCount = 0
        sent.clear()
        socket = null
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined
          if (!closed) open()
        }, 100)
        return
      }
      closed = true
      pendingTelemetry.clear()
      useFleet.getState().setDevices([])
      useFleet.getState().replaceStreams([])
      window.dispatchEvent(new Event('session-expired'))
    }
    socket = null
    sent.clear()
    useFleet.getState().setConnected(false)
    if (closed) return

    const delay = Math.min(1000 * 2 ** retryCount, 15_000)
    retryCount += 1
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined
      open()
    }, delay)
  }
}

export function connectFleetSocket(handlers: { onOpen?: () => void } = {}): void {
  closed = false
  onOpen = handlers.onOpen
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  )
    return
  open()
}

export function disconnectFleetSocket(): void {
  closed = true
  onOpen = undefined
  if (retryTimer !== undefined) {
    window.clearTimeout(retryTimer)
    retryTimer = undefined
  }
  if (telemetryTimer !== undefined) {
    window.clearTimeout(telemetryTimer)
    telemetryTimer = undefined
  }
  pendingTelemetry.clear()
  sent.clear()

  const current = socket
  socket = null
  current?.close()
  useFleet.getState().setConnected(false)
}
