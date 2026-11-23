import { DEFAULT_BRANDING, type Branding } from '@dji/protocol'
import defaultMark from './assets/brand-mark.png'
import { withBase } from './base'

const LOAD_TIMEOUT_MS = 2500

/**
 * This installation's name, colours and logo. Filled by `loadBranding()` before the first
 * render, so components read it as a plain value; it does not change while a page is open.
 */
export const brand: Branding & { logo: string } = { ...DEFAULT_BRANDING, logo: defaultMark }

/** `Screen — Name`, or `Name — Subtitle` for the home screen. */
export function pageTitle(screen?: string): string {
  return screen ? `${screen} — ${brand.name}` : `${brand.name} — ${brand.subtitle}`
}

type Rgb = [number, number, number]

const toRgb = (hex: string): Rgb => {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

const toHex = (rgb: Rgb): string =>
  `#${rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

/** `amount` of the way from `hex` to `target` (0 keeps it, 1 is the target). */
const mix = (hex: string, target: Rgb, amount: number): string => {
  const from = toRgb(hex)
  return toHex(from.map((c, i) => c + (target[i]! - c) * amount) as Rgb)
}

/** `hex` at `alpha` opacity, for glows, rings and shadows. */
const alpha = (hex: string, a: number): string => `rgba(${toRgb(hex).join(', ')}, ${a})`

const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]

const luminance = (hex: string): number => {
  const [r, g, b] = toRgb(hex).map((c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Re-derives the brand token families (`--pine*`, `--gold*`) from two colours. Utilities
 * read these variables, so the whole interface follows without a rebuild. The defaults are
 * left alone: the hand-tuned values in tokens.css stay exact for the default brand.
 */
function applyColors(primary: string, accent: string): void {
  const root = document.documentElement.style
  if (primary !== DEFAULT_BRANDING.primaryColor) {
    root.setProperty('--pine', primary)
    root.setProperty('--pine-strong', mix(primary, BLACK, 0.3))
    root.setProperty('--pine-hover', mix(primary, BLACK, 0.15))
    root.setProperty('--pine-hover-strong', mix(primary, BLACK, 0.4))
    root.setProperty('--pine-soft', mix(primary, WHITE, 0.86))
    root.setProperty('--pine-wash', mix(primary, WHITE, 0.93))
    root.setProperty('--pine-tint', mix(primary, WHITE, 0.95))
    // The sign-in panel and every glow, ring and shadow that carried the default blue.
    root.setProperty('--login-panel-start', mix(primary, BLACK, 0.05))
    root.setProperty('--login-panel-mid', mix(primary, BLACK, 0.35))
    root.setProperty('--login-panel-end', mix(primary, BLACK, 0.62))
    root.setProperty('--login-visual-glow', alpha(primary, 0.14))
    root.setProperty('--login-focus-ring', alpha(primary, 0.2))
    root.setProperty('--login-banner-edge', alpha(primary, 0.28))
    root.setProperty('--map-marker-ring', alpha(primary, 0.18))
    root.setProperty('--input-focus-ring', alpha(primary, 0.14))
    root.setProperty('--search-focus-ring', alpha(primary, 0.12))
    root.setProperty('--body-glow', alpha(primary, 0.1))
    root.setProperty(
      '--shadow-primary',
      `0 6px 16px ${alpha(primary, 0.32)}, inset 0 1px 0 rgba(255, 255, 255, 0.22)`,
    )
    root.setProperty(
      '--shadow-primary-hover',
      `0 8px 20px ${alpha(mix(primary, BLACK, 0.3), 0.38)}, inset 0 1px 0 rgba(255, 255, 255, 0.18)`,
    )
    root.setProperty('--shadow-layout-active', `0 4px 12px ${alpha(primary, 0.35)}`)
  }
  if (accent !== DEFAULT_BRANDING.accentColor) {
    root.setProperty('--gold', accent)
    root.setProperty('--gold-strong', mix(accent, BLACK, 0.14))
    root.setProperty('--gold-soft', mix(accent, WHITE, 0.78))
    root.setProperty('--gold-wash', mix(accent, WHITE, 0.89))
    root.setProperty(
      '--on-gold',
      luminance(accent) > 0.179 ? 'var(--drone-label-dark)' : 'var(--drone-label-light)',
    )
    // The accent on dark surfaces (focus view, live wall chrome) is a lighter shade of it.
    root.setProperty('--dark-pine', mix(accent, WHITE, 0.2))
    root.setProperty('--login-visual-glow-soft', alpha(accent, 0.13))
    root.setProperty('--shadow-login-submit', `0 8px 18px ${alpha(mix(accent, BLACK, 0.12), 0.34)}`)
  }
}

function applyFavicon(href: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.append(link)
  }
  link.href = href
}

/**
 * Reads the installation's branding and applies it. Never fails: without an answer (an old
 * API, a slow network) the built-in brand stays, so the page always renders.
 */
export async function loadBranding(): Promise<void> {
  // AbortSignal.timeout is Chrome 103+; the RC Plus 2 WebView is Chrome 95.
  const abort = new AbortController()
  const timer = window.setTimeout(() => abort.abort(), LOAD_TIMEOUT_MS)
  try {
    const response = await fetch(withBase('/api/branding'), {
      credentials: 'same-origin',
      signal: abort.signal,
    })
    if (response.ok) {
      const loaded = (await response.json()) as Partial<Branding>
      Object.assign(brand, DEFAULT_BRANDING, loaded)
      brand.logo = loaded.logoUrl ? withBase(loaded.logoUrl) : defaultMark
    }
  } catch {
    // Keep the built-in brand.
  } finally {
    window.clearTimeout(timer)
  }
  applyColors(brand.primaryColor, brand.accentColor)
  applyFavicon(brand.logo)
  document.title = pageTitle()
}
