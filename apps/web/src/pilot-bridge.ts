export interface BridgeResult {
  ok: boolean
  data: unknown
  message?: string
}

type BridgeApi = Record<string, (...args: unknown[]) => unknown>

export function hasBridge(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { djiBridge?: BridgeApi }).djiBridge)
  )
}

export function call(name: string, ...args: unknown[]): unknown {
  const api = (window as unknown as { djiBridge?: BridgeApi }).djiBridge
  if (!api || typeof api[name] !== 'function') return undefined
  return api[name](...args)
}

/** The bridge returns a JSON string shaped like `{ code, message, data }`. */
export function parse(response: unknown): BridgeResult {
  if (typeof response !== 'string') {
    return { ok: false, data: null, message: 'no response from Pilot' }
  }
  try {
    const value = JSON.parse(response) as { code?: number; data?: unknown; message?: string }
    return { ok: value.code === 0, data: value.data, message: value.message }
  } catch {
    return { ok: false, data: null, message: 'unreadable response from Pilot' }
  }
}

export function stringData(result: BridgeResult): string {
  return typeof result.data === 'string' ? result.data : ''
}
