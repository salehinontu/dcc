/**
 * What an installation calls itself and how it looks. One build serves every customer: the
 * API reads these from its environment (`BRAND_*`) and serves them, unauthenticated, from
 * `GET /api/branding`, because the sign-in page and the Pilot page need them too.
 */
export interface Branding {
  /** Product name, e.g. "Drone Fleet". */
  name: string
  /** Line under the name in the lockup. */
  subtitle: string
  /** Company shown in the sign-in footer. */
  company: string
  /** Headline on the sign-in screen. */
  tagline: string
  /** Start of screenshot and recording file names, e.g. "DRONE-FLEET". */
  filePrefix: string
  /** Main colour (buttons, links, selection), `#rrggbb`. */
  primaryColor: string
  /** Accent colour (active menu bar, selected aircraft), `#rrggbb`. Never a status colour. */
  accentColor: string
  /** A custom logo on the same origin, or null for the built-in mark. */
  logoUrl: string | null
}

export const DEFAULT_BRANDING: Branding = {
  name: 'Drone Fleet',
  subtitle: 'Drone Command Center',
  company: 'Your Company',
  tagline: 'Live video and telemetry for your fleet',
  filePrefix: 'DRONE-FLEET',
  primaryColor: '#0a58b8',
  accentColor: '#f2b300',
  logoUrl: null,
}

/** A file-name-safe prefix from a product name: "Drone Fleet" → "DRONE-FLEET". */
export function filePrefixFor(name: string): string {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'DRONE'
  )
}
