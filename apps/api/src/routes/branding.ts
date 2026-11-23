import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Branding } from '@dji/protocol'
import { config } from '../config'

const LOGO_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}
const MAX_LOGO_BYTES = 2 * 1024 * 1024

interface Logo {
  bytes: Buffer
  type: string
  version: number
}

let cached: Promise<Logo | null> | null = null

/** The configured logo, read once. A missing or unusable file falls back to the built-in mark. */
function logo(): Promise<Logo | null> {
  cached ??= (async () => {
    const path = config.brand.logoPath
    if (!path) return null
    const type = LOGO_TYPES[extname(path).toLowerCase()]
    if (!type) {
      console.warn(`[branding] BRAND_LOGO_PATH must be a .png, .jpg, .webp or .svg file: ${path}`)
      return null
    }
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_LOGO_BYTES) {
        console.warn(`[branding] BRAND_LOGO_PATH is not a file of at most 2 MB: ${path}`)
        return null
      }
      return { bytes: await readFile(path), type, version: Math.floor(info.mtimeMs) }
    } catch {
      console.warn(`[branding] cannot read BRAND_LOGO_PATH: ${path}`)
      return null
    }
  })()
  return cached
}

/**
 * Public on purpose: the sign-in screen and the Pilot page are drawn before anyone signs in.
 * Nothing here is secret: it is what the installation shows on screen anyway.
 */
export function registerBrandingRoutes(app: FastifyInstance): void {
  app.get('/api/branding', async (): Promise<Branding> => {
    const custom = await logo()
    const { name, subtitle, company, tagline, filePrefix, primaryColor, accentColor } = config.brand
    return {
      name,
      subtitle,
      company,
      tagline,
      filePrefix,
      primaryColor,
      accentColor,
      logoUrl: custom ? `/api/branding/logo?v=${custom.version}` : null,
    }
  })

  app.get('/api/branding/logo', async (_req, reply) => {
    const custom = await logo()
    if (!custom) return reply.code(404).send({ error: 'no custom logo' })
    reply
      .header('content-type', custom.type)
      .header('cache-control', 'public, max-age=86400')
      .header('x-content-type-options', 'nosniff')
    // An SVG opened on its own must not run anything it carries.
    if (custom.type === 'image/svg+xml')
      reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
    return reply.send(custom.bytes)
  })
}
