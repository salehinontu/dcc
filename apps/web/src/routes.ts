import { useSyncExternalStore, type MouseEvent } from 'react'
import { can } from '@dji/protocol'
import { basePath, withBase } from './base'

export type Route = 'dashboard' | 'pilot' | 'not-found'

/** Every dashboard screen that has its own address. */
export type AppRoute =
  | { name: 'map' }
  | { name: 'wall' }
  | { name: 'shots' }
  | { name: 'users' }
  | { name: 'user-new' }
  | { name: 'user-edit'; id: string }
  | { name: 'controllers' }
  | { name: 'aircraft' }
  | { name: 'zones' }
  | { name: 'flights' }
  | { name: 'flight'; id: string }
  | { name: 'recordings' }
  | { name: 'drones' }
  | { name: 'alerts' }
  | { name: 'audit' }
  | { name: 'api-access' }

/** The rail menu a route belongs to; nested pages keep their parent menu active. */
export type View =
  | 'map'
  | 'wall'
  | 'shots'
  | 'recordings'
  | 'users'
  | 'inventory'
  | 'zones'
  | 'flights'
  | 'drones'
  | 'alerts'
  | 'audit'
  | 'api-access'

type Parsed = { kind: 'pilot' } | { kind: 'not-found' } | { kind: 'app'; route: AppRoute }

function stripBase(pathname: string): string {
  const withoutBase =
    basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname
  return withoutBase.replace(/\/+$/, '') || '/'
}

/**
 * Resolve a browser path against the deployment base. Vite inlines BASE_URL with a
 * trailing slash, so in a `/drone-fleet/` deployment `/drone-fleet/pilot/` resolves to
 * `/pilot`. Matching is exact: a nested or suffixed path is not a route.
 */
export function parsePath(pathname: string): Parsed {
  const path = stripBase(pathname)
  if (path === '/pilot') return { kind: 'pilot' }

  const fixed: Record<string, AppRoute> = {
    '/': { name: 'map' },
    '/live': { name: 'wall' },
    '/screenshots': { name: 'shots' },
    '/recordings': { name: 'recordings' },
    '/users': { name: 'users' },
    '/users/new': { name: 'user-new' },
    '/inventory/controllers': { name: 'controllers' },
    '/inventory/aircraft': { name: 'aircraft' },
    '/zones': { name: 'zones' },
    '/flights': { name: 'flights' },
    '/drones': { name: 'drones' },
    '/alerts': { name: 'alerts' },
    '/audit': { name: 'audit' },
    '/integrations': { name: 'api-access' },
  }
  const route = fixed[path]
  if (route) return { kind: 'app', route }

  const edit = /^\/users\/([A-Za-z0-9-]{1,64})$/.exec(path)
  if (edit) return { kind: 'app', route: { name: 'user-edit', id: edit[1]! } }
  const flight = /^\/flights\/([A-Za-z0-9-]{1,64})$/.exec(path)
  if (flight) return { kind: 'app', route: { name: 'flight', id: flight[1]! } }
  return { kind: 'not-found' }
}

export function routeFor(pathname: string): Route {
  const parsed = parsePath(pathname)
  return parsed.kind === 'app' ? 'dashboard' : parsed.kind
}

export function pathFor(route: AppRoute): string {
  switch (route.name) {
    case 'map':
      return '/'
    case 'wall':
      return '/live'
    case 'shots':
      return '/screenshots'
    case 'recordings':
      return '/recordings'
    case 'users':
      return '/users'
    case 'user-new':
      return '/users/new'
    case 'user-edit':
      return `/users/${encodeURIComponent(route.id)}`
    case 'controllers':
      return '/inventory/controllers'
    case 'aircraft':
      return '/inventory/aircraft'
    case 'zones':
      return '/zones'
    case 'flights':
      return '/flights'
    case 'flight':
      return `/flights/${encodeURIComponent(route.id)}`
    case 'drones':
      return '/drones'
    case 'alerts':
      return '/alerts'
    case 'audit':
      return '/audit'
    case 'api-access':
      return '/integrations'
  }
}

export function viewOf(route: AppRoute): View {
  switch (route.name) {
    case 'user-new':
    case 'user-edit':
      return 'users'
    case 'controllers':
    case 'aircraft':
      return 'inventory'
    case 'flight':
      return 'flights'
    default:
      return route.name
  }
}

/**
 * Client-side gate for each screen. The API enforces the same permissions on every request;
 * this only keeps a deep link or a refresh from rendering a screen the account cannot use.
 */
export function routeAllowed(user: Parameters<typeof can>[0], route: AppRoute): boolean {
  switch (viewOf(route)) {
    case 'map':
      return can(user, 'map.view')
    case 'wall':
      return can(user, 'wall.view')
    case 'shots':
      return can(user, 'shots.view')
    case 'recordings':
      return can(user, 'recs.view')
    case 'users':
      return can(user, 'users.manage')
    case 'inventory':
      return can(user, 'inventory.manage')
    case 'flights':
      return can(user, 'history.view')
    case 'zones':
      return can(user, 'zones.view')
    case 'alerts':
      return can(user, 'alerts.view')
    case 'drones':
      return can(user, 'fleet.view')
    case 'audit':
      return can(user, 'audit.view')
    case 'api-access':
      return can(user, 'api.manage')
  }
}

/** Where an account lands, in the order of the menu: the first screen it may open. */
const HOME_ORDER: AppRoute[] = [
  { name: 'map' },
  { name: 'wall' },
  { name: 'shots' },
  { name: 'recordings' },
  { name: 'flights' },
  { name: 'zones' },
  { name: 'alerts' },
  { name: 'drones' },
  { name: 'users' },
  { name: 'controllers' },
  { name: 'audit' },
  { name: 'api-access' },
]

/** The first screen the account may open, or null when its Admin has opened none. */
export function homeRoute(user: Parameters<typeof can>[0]): AppRoute | null {
  return HOME_ORDER.find((route) => routeAllowed(user, route)) ?? null
}

const NAVIGATE_EVENT = 'app:navigate'

/** Push (or replace) a dashboard address without reloading the page. */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const target = withBase(path)
  if (target === window.location.pathname) return
  if (options.replace) window.history.replaceState(null, '', target)
  else window.history.pushState(null, '', target)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

/**
 * A plain left click on an in-app link navigates in place; modified clicks (new tab, new
 * window) keep the browser's default so links behave like links.
 */
export function followLink(event: MouseEvent<HTMLAnchorElement>, path: string): boolean {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return false
  event.preventDefault()
  navigate(path)
  return true
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(NAVIGATE_EVENT, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(NAVIGATE_EVENT, onChange)
  }
}

const currentPath = () => window.location.pathname

export function useLocationPath(): string {
  return useSyncExternalStore(subscribe, currentPath)
}

export const route = routeFor(window.location.pathname)
