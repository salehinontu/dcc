import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { can } from '@dji/protocol'
import Alerts from './Alerts'
import ApiAccess from './ApiAccess'
import Audit from './Audit'
import Drones from './Drones'
import FlightDetail from './FlightDetail'
import Flights from './Flights'
import Inventory from './Inventory'
import Recordings from './Recordings'
import Users from './Users'
import Zones from './Zones'
import { api, type User } from '../api'
import { matchesSearch } from '../deviceSearch'
import AlertToasts from '../components/AlertToasts'
import FleetRail from '../components/FleetRail'
import FocusView from '../components/FocusView'
import LiveWall from '../components/LiveWall'
import MapView from '../components/MapView'
import ScreenshotGallery from '../components/ScreenshotGallery'
import StageBar from '../components/StageBar'
import TimeAgo from '../components/TimeAgo'
import { useFleetData } from '../fleetData'
import { stopAllRecordings } from '../recorder'
import { pageTitle } from '../branding'
import { homeRoute, navigate, pathFor, routeAllowed, viewOf, type AppRoute } from '../routes'
import { emptyPanel, screenBody } from '../ui/surface'
import { connectFleetSocket, disconnectFleetSocket } from '../socket'
import { useFleet } from '../store'

const screenTitles: Record<AppRoute['name'], string> = {
  map: 'Operations map',
  wall: 'Live wall',
  shots: 'Screenshots',
  recordings: 'Recordings',
  users: 'Users and permissions',
  'user-new': 'Create user',
  'user-edit': 'Edit user',
  controllers: 'Controllers',
  aircraft: 'Drone inventory',
  zones: 'Zones and geofences',
  flights: 'Flight history',
  flight: 'Flight',
  drones: 'Drones',
  alerts: 'Alerts',
  audit: 'Audit log',
  'api-access': 'API access',
}

export default function Dashboard({
  user,
  route,
  onLogout,
  onChangePassword,
}: {
  user: User
  route: AppRoute
  onLogout: () => void
  onChangePassword: () => void
}) {
  // A deep link or refresh onto a screen this account cannot use falls back to the first screen
  // it may open. An Admin can open none, and then the account sees a note instead.
  const allowed = routeAllowed(user, route)
  const home = homeRoute(user)
  const noScreens = !allowed && !home
  const current: AppRoute = allowed ? route : (home ?? { name: 'map' })
  const view = viewOf(current)
  const path = pathFor(current)

  useEffect(() => {
    if (!allowed && home) navigate(pathFor(home), { replace: true })
  }, [allowed, home])

  useEffect(() => {
    const previous = document.title
    document.title = current.name === 'map' ? pageTitle() : pageTitle(screenTitles[current.name])
    return () => {
      document.title = previous
    }
  }, [current.name])

  const active = useRef(true)
  const devices = useFleet((state) => state.devices)
  const streams = useFleet((state) => state.streams)
  const search = useFleet((state) => state.search)
  const connected = useFleet((state) => state.connected)
  const setDevices = useFleet((state) => state.setDevices)

  // The focus overlay belongs to the screen it was opened from: navigating away (including
  // with the browser's back button) closes it without an effect.
  const [focus, setFocus] = useState<{ sn: string; path: string } | null>(null)
  const focusSn = focus && focus.path === path ? focus.sn : null
  const setFocusSn = (sn: string | null) => setFocus(sn ? { sn, path } : null)
  const [railOpen, setRailOpen] = useState(false)
  const railReturnFocus = useRef<HTMLButtonElement | null>(null)
  const focusReturnFocus = useRef<HTMLElement | null>(null)

  const list = useMemo(() => Object.values(devices), [devices])
  const online = list.filter((device) => device.online).length
  const streamList = useMemo(() => Object.values(streams), [streams])
  const live = streamList.filter((stream) => stream.phase === 'live').length
  const visible = useMemo(
    () => list.filter((device) => matchesSearch(device, search)),
    [list, search],
  )
  const visibleOnline = visible.filter((device) => device.online).length
  const visibleSns = useMemo(() => new Set(visible.map((device) => device.sn)), [visible])
  const visibleLive = streamList.filter(
    (stream) => stream.phase === 'live' && visibleSns.has(stream.deviceSn),
  ).length
  const visibleConnecting = streamList.filter(
    (stream) => stream.phase === 'starting' && visibleSns.has(stream.deviceSn),
  ).length

  const lastUpdate = useMemo(() => {
    let latest = 0
    for (const device of list) {
      if (!device.lastSeenAt) continue
      const timestamp = Date.parse(device.lastSeenAt)
      if (timestamp > latest) latest = timestamp
    }
    return latest > 0 ? new Date(latest).toISOString() : null
  }, [list])

  const mapSummary = `${list.length} drone${list.length === 1 ? '' : 's'} / ${online} online / ${live} streaming`
  const wallSummary = [
    `${visibleLive} live`,
    visibleConnecting > 0 ? `${visibleConnecting} connecting` : null,
    `${visibleOnline} online`,
  ]
    .filter(Boolean)
    .join(' / ')

  // Zones and alerts feed the map, the rail and every aircraft card, so they load with the
  // dashboard rather than with the screens that edit them.
  const loadZones = useFleetData((state) => state.loadZones)
  const loadAlerts = useFleetData((state) => state.loadAlerts)
  const mayReadZones = can(user, 'zones.view')
  const mayReadAlerts = can(user, 'alerts.view')
  useEffect(() => {
    if (mayReadZones) void loadZones()
    if (mayReadAlerts) void loadAlerts()
  }, [loadAlerts, loadZones, mayReadAlerts, mayReadZones])

  const refresh = useCallback(async () => {
    try {
      const result = await api.devices()
      if (active.current) setDevices(result.devices)
    } catch {
      // the next reconnect or poll will retry
    }
  }, [setDevices])

  useEffect(() => {
    active.current = true
    void refresh()
    const poll = window.setInterval(() => void refresh(), 30_000)
    return () => {
      active.current = false
      clearInterval(poll)
    }
  }, [refresh])

  // The socket owns the stream lifecycle. Leaving the page closes it, which releases the
  // watches server-side; no per-tab stop is needed (or wanted).
  useEffect(() => {
    connectFleetSocket({ onOpen: () => void refresh() })
    return () => disconnectFleetSocket()
  }, [refresh])

  // Recordings live as long as the dashboard: signing out finishes and saves their files.
  useEffect(() => () => stopAllRecordings(), [])

  const closeRail = useCallback(
    (restoreFocus = true) => {
      if (!railOpen) return
      setRailOpen(false)
      if (restoreFocus) {
        window.requestAnimationFrame(() => railReturnFocus.current?.focus())
      }
    },
    [railOpen],
  )

  useEffect(() => {
    if (!railOpen) return undefined

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRail(true)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeRail, railOpen])

  function openRail(trigger: HTMLButtonElement) {
    railReturnFocus.current = trigger
    setRailOpen(true)
  }

  /** Called after a rail link has navigated; the drawer closes on narrow screens. */
  function afterNavigate() {
    const wasOpen = railOpen
    setRailOpen(false)

    if (wasOpen && window.matchMedia('(max-width: 900px)').matches) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>('[data-testid="mobile-fleet"]')?.focus()
      })
    }
  }

  function rememberFocus() {
    focusReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }

  function openFromMap(sn: string) {
    if (!can(user, 'streams.view', sn)) return
    rememberFocus()
    setFocusSn(sn)
  }

  function openFromWall(sn: string) {
    rememberFocus()
    setFocusSn(sn)
  }

  const closeFocus = useCallback(() => {
    setFocus(null)
    const target = focusReturnFocus.current
    window.requestAnimationFrame(() => target?.focus())
  }, [])

  async function logout() {
    await api.logout().catch(() => undefined)
    setDevices([])
    useFleet.getState().replaceStreams([])
    useFleetData.getState().reset()
    onLogout()
  }

  return (
    <>
      <div
        className="relative grid h-full min-h-0 grid-cols-[var(--rail-w)_minmax(0,1fr)] bg-transparent until-drawer:grid-cols-1"
        data-parity="app"
        data-testid="app"
        aria-hidden={focusSn ? true : undefined}
      >
        <FleetRail
          user={user}
          connected={connected}
          onlineCount={online}
          view={view}
          lastUpdate={lastUpdate}
          open={railOpen}
          canRename={can(user, 'drones.rename')}
          onNavigate={afterNavigate}
          onLogout={() => void logout()}
          onChangePassword={onChangePassword}
          onClose={() => closeRail(true)}
          onDeviceSelected={() => closeRail(true)}
        />

        <div
          className={`hidden until-drawer:absolute until-drawer:inset-0 until-drawer:z-[25] until-drawer:block until-drawer:bg-scrim until-drawer:transition-opacity until-drawer:duration-200 ${
            railOpen
              ? 'until-drawer:pointer-events-auto until-drawer:opacity-100'
              : 'until-drawer:pointer-events-none until-drawer:opacity-0'
          }`}
          data-parity="rail-scrim"
          aria-hidden="true"
          onClick={() => closeRail(true)}
        />

        <div className="flex min-h-0 min-w-0 flex-col" data-parity="stage">
          {noScreens ? (
            <>
              <StageBar bar="none" title="No screens" railOpen={railOpen} onOpenRail={openRail} />
              <div className={screenBody} data-testid="no-screens">
                <div className={emptyPanel}>
                  <p className="m-0 max-w-[420px] text-[13px] leading-[1.6] text-ink-2">
                    This account has no screens turned on yet. Ask whoever gave you this account to
                    open the ones you need.
                  </p>
                </div>
              </div>
            </>
          ) : current.name === 'users' ||
            current.name === 'user-new' ||
            current.name === 'user-edit' ? (
            <Users
              user={user}
              route={current}
              railOpen={railOpen}
              onOpenRail={openRail}
              onChangePassword={onChangePassword}
            />
          ) : current.name === 'controllers' || current.name === 'aircraft' ? (
            <Inventory user={user} route={current} railOpen={railOpen} onOpenRail={openRail} />
          ) : current.name === 'zones' ? (
            <Zones user={user} railOpen={railOpen} onOpenRail={openRail} />
          ) : current.name === 'recordings' ? (
            <Recordings user={user} railOpen={railOpen} onOpenRail={openRail} />
          ) : current.name === 'flights' ? (
            <Flights railOpen={railOpen} onOpenRail={openRail} />
          ) : current.name === 'flight' ? (
            <FlightDetail
              key={current.id}
              id={current.id}
              user={user}
              railOpen={railOpen}
              onOpenRail={openRail}
            />
          ) : current.name === 'drones' ? (
            <Drones user={user} railOpen={railOpen} onOpenRail={openRail} />
          ) : current.name === 'alerts' ? (
            <Alerts railOpen={railOpen} onOpenRail={openRail} />
          ) : current.name === 'audit' ? (
            <Audit user={user} railOpen={railOpen} onOpenRail={openRail} />
          ) : current.name === 'api-access' ? (
            <ApiAccess railOpen={railOpen} onOpenRail={openRail} />
          ) : view === 'map' ? (
            <>
              <StageBar
                bar="map"
                title="Operations"
                summary={mapSummary}
                actions={
                  <span
                    className="whitespace-nowrap font-mono text-[9px] tracking-[0.04em] text-ink-3 until-wide:hidden"
                    data-parity="sync-note"
                  >
                    <TimeAgo
                      iso={lastUpdate}
                      prefix={lastUpdate ? 'Last telemetry' : undefined}
                      fallback="No telemetry yet"
                    />
                  </span>
                }
                railOpen={railOpen}
                onOpenRail={openRail}
              />
              <MapView user={user} onViewLive={openFromMap} />
            </>
          ) : view === 'wall' ? (
            <>
              <StageBar
                bar="wall"
                title="Live wall"
                summary={wallSummary}
                railOpen={railOpen}
                onOpenRail={openRail}
              />
              <LiveWall onExpand={openFromWall} suspendedSn={focusSn} user={user} />
            </>
          ) : (
            <>
              <StageBar
                bar="shots"
                title="Screenshots"
                summary="Frames captured from live feeds, stored on the server"
                railOpen={railOpen}
                onOpenRail={openRail}
              />
              <ScreenshotGallery user={user} />
            </>
          )}
        </div>
      </div>

      <AlertToasts />

      {focusSn && devices[focusSn] && can(user, 'streams.view', focusSn) && (
        <FocusView
          sn={focusSn}
          user={user}
          backLabel={view === 'map' ? 'Back to map' : 'Back to wall'}
          onClose={closeFocus}
        />
      )}
    </>
  )
}
