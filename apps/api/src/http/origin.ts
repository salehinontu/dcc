import type { FastifyRequest } from 'fastify'
import { config } from '../config'

/**
 * Same-origin check shared by the WebSocket upgrade and mutating HTTP requests. Nginx and
 * the Vite dev proxy both preserve the original Host header.
 */
export function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin
  if (!origin) return true

  try {
    if (new URL(origin).host === req.headers.host) return true
  } catch {
    return false
  }
  return config.corsOrigins.includes(origin)
}
