import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LngLatBounds, Marker, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
import type { FlightDetail as FlightDetailData, FlightPoint } from '@dji/protocol'
import { api, type User } from '../api'
import { alertKindLabel } from '../alertFormat'
import BaseMap from '../components/BaseMap'
import ColorDot from '../components/ColorDot'
import StageBar from '../components/StageBar'
import { useFleetData } from '../fleetData'
import {
  altitudeLabel,
  batteryLabel,
  distanceLabel,
  durationLabel,
  formatClock,
  formatDateTime,
  headingLabel,
  speedLabel,
} from '../flightFormat'
import { formatCoord, hasPosition } from '../format'
import { useFleet } from '../store'
import Badge from '../ui/Badge'
import Button from '../ui/Button'
import Notice from '../ui/Notice'
import { cn } from '../ui/cn'
import { eyebrow, segment } from '../ui/surface'
import { addZoneLayers, setZoneData } from '../zoneMap'

const PATH = 'flight-path'
const RATES = [1, 5, 20, 60] as const

interface Placed {
  lng: number
  lat: number
  index: number
}

/** The last point recorded at or before `ms` after take-off, and the position between it and the next. */
function placeAt(points: FlightPoint[], start: number, ms: number): Placed | null {
  if (points.length === 0) return null
  const target = start + ms
  let low = 0
  let high = points.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (points[mid]!.ts <= target) low = mid
    else high = mid - 1
  }
  const a = points[low]!
  const b = points[low + 1]
  if (!b || b.ts <= a.ts) return { lng: a.lon, lat: a.lat, index: low }
  const fraction = Math.min(1, Math.max(0, (target - a.ts) / (b.ts - a.ts)))
  return {
    lng: a.lon + (b.lon - a.lon) * fraction,
    lat: a.lat + (b.lat - a.lat) * fraction,
    index: low,
  }
}

function arrowImage(): ImageData | null {
  const size = 22
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return null
  const css = getComputedStyle(document.documentElement)
  context.lineJoin = 'round'
  context.lineWidth = 3
  context.strokeStyle = css.getPropertyValue('--ink').trim()
  context.fillStyle = css.getPropertyValue('--surface-2').trim()
  context.beginPath()
  context.moveTo(6, 5)
  context.lineTo(17, 11)
  context.lineTo(6, 17)
  context.lineTo(9.5, 11)
  context.closePath()
  context.stroke()
  context.fill()
  return context.getImageData(0, 0, size, size)
}

function pin(label: string, colorVar: string, title: string, className = ''): HTMLElement {
  const element = document.createElement('div')
  element.className = `flight-pin ${className}`.trim()
  element.style.setProperty('--pin-color', colorVar)
  element.textContent = label
  element.title = title
  return element
}

/** A small line chart of one measurement over the flight, with a cursor you can drag to seek. */
function Profile({
  title,
  unit,
  points,
  pick,
  cursor,
  onSeek,
}: {
  title: string
  unit: string
  points: FlightPoint[]
  pick: (point: FlightPoint) => number | null
  /** 0..1 along the flight. */
  cursor: number
  onSeek: (fraction: number) => void
}) {
  const W = 300
  const H = 64
  const first = points[0]?.ts ?? 0
  const span = Math.max(1, (points[points.length - 1]?.ts ?? first) - first)
  const values = points.map(pick)
  const known = values.filter((value): value is number => value != null)
  const min = Math.min(0, ...(known.length ? known : [0]))
  const max = Math.max(1, ...(known.length ? known : [1]))
  const y = (value: number) => H - 3 - ((value - min) / (max - min || 1)) * (H - 8)

  const line = points
    .map((point, index) => {
      const value = values[index]
      return value == null
        ? null
        : `${(((point.ts - first) / span) * W).toFixed(1)},${y(value).toFixed(1)}`
    })
    .filter(Boolean)
    .join(' ')
  const seek = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    onSeek(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)))
  }

  return (
    <div className="mt-3.5">
      <div className="mb-1 flex items-baseline justify-between">
        <span className={eyebrow}>{title}</span>
        <span className="font-mono text-[9px] text-ink-3">
          max {Math.round(max * 10) / 10} {unit}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-16 w-full touch-none cursor-ew-resize rounded-md border border-line bg-surface-2"
        role="img"
        aria-label={`${title} over the flight`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          seek(event)
        }}
        onPointerMove={(event) => {
          if (event.buttons) seek(event)
        }}
      >
        {line && (
          <>
            <polygon className="fill-pine-wash" points={`0,${H} ${line} ${W},${H}`} />
            <polyline
              className="fill-none stroke-pine"
              strokeWidth="1.6"
              vectorEffect="non-scaling-stroke"
              points={line}
            />
          </>
        )}
        <line
          className="stroke-gold-strong"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          x1={cursor * W}
          x2={cursor * W}
          y1="0"
          y2={H}
        />
      </svg>
    </div>
  )
}

/**
 * One flight: the path on the map with arrows for the direction of travel, take-off and landing
 * pins, the zones around it, who flew it, and a replay with height and speed charts.
 */
export default function FlightDetail({
  id,
  railOpen,
  onOpenRail,
}: {
  id: string
  user: User
  railOpen: boolean
  onOpenRail: (trigger: HTMLButtonElement) => void
}) {
  const zones = useFleetData((state) => state.zones)
  const loadZones = useFleetData((state) => state.loadZones)
  const devices = useFleet((state) => state.devices)
  const [data, setData] = useState<FlightDetailData | null>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState<(typeof RATES)[number]>(20)

  const mapRef = useRef<MapLibreMap | null>(null)
  const runner = useRef<Marker | null>(null)
  const extras = useRef<Marker[]>([])
  const fitted = useRef(false)
  const clock = useRef(0)

  useEffect(() => {
    void loadZones()
  }, [loadZones])

  // Load the flight; one still in progress keeps growing, so it is refreshed.
  const status = data?.flight.status
  useEffect(() => {
    let cancelled = false
    const load = () =>
      api
        .flight(id)
        .then((result) => {
          if (cancelled) return
          setData(result)
          setError('')
        })
        .catch((e: Error) => !cancelled && setError(e.message))
    void load()
    if (status !== 'active') return () => void (cancelled = true)
    const timer = window.setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [id, status])

  const points = useMemo(() => (data?.points ?? []).filter(hasPosition), [data])
  const start = points[0]?.ts ?? 0
  const duration = points.length > 1 ? points[points.length - 1]!.ts - start : 0
  const here = placeAt(points, start, t)
  const sample = here ? points[here.index] : null

  const onReady = useCallback((map: MapLibreMap) => {
    mapRef.current = map
    addZoneLayers(map)
    map.addSource(PATH, {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
    })
    map.addLayer({
      id: 'flight-casing',
      type: 'line',
      source: PATH,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': getComputedStyle(document.documentElement)
          .getPropertyValue('--surface-2')
          .trim(),
        'line-width': 7,
        'line-opacity': 0.9,
      },
    })
    map.addLayer({
      id: 'flight-line',
      type: 'line',
      source: PATH,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': getComputedStyle(document.documentElement).getPropertyValue('--pine').trim(),
        'line-width': 4,
      },
    })
    const arrow = arrowImage()
    if (arrow) {
      map.addImage('flight-arrow', arrow, { pixelRatio: 1 })
      map.addLayer({
        id: 'flight-arrows',
        type: 'symbol',
        source: PATH,
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 90,
          'icon-image': 'flight-arrow',
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      })
    }
    setReady(true)
  }, [])

  const onDispose = useCallback(() => {
    runner.current?.remove()
    for (const marker of extras.current) marker.remove()
    runner.current = null
    extras.current = []
    mapRef.current = null
    setReady(false)
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (map && ready) setZoneData(map, zones)
  }, [zones, ready])

  // The path, its colour, and the pins at take-off, landing and each alert.
  const color = data?.flight.deviceColor ?? null
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return undefined
    const coordinates = points.map((point) => [point.lon, point.lat] as [number, number])
    ;(map.getSource(PATH) as GeoJSONSource | undefined)?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    } as never)
    if (color) map.setPaintProperty('flight-line', 'line-color', color)

    for (const marker of extras.current) marker.remove()
    extras.current = []
    const place = (element: HTMLElement, at: [number, number]) =>
      extras.current.push(new Marker({ element }).setLngLat(at).addTo(map))
    const first = coordinates[0]
    const last = coordinates[coordinates.length - 1]
    if (first) place(pin('S', 'var(--ok)', 'Take-off'), first)
    if (last && data?.flight.status === 'completed') place(pin('E', 'var(--ink)', 'Landing'), last)
    for (const alert of data?.alerts ?? []) {
      if (alert.lat == null || alert.lon == null) continue
      place(
        pin(
          '!',
          'var(--zone-nofly)',
          alert.zoneName
            ? `${alertKindLabel[alert.kind]}: ${alert.zoneName}`
            : alertKindLabel[alert.kind],
          'is-alert',
        ),
        [alert.lon, alert.lat],
      )
    }

    if (!fitted.current && coordinates.length > 0) {
      const bounds = new LngLatBounds()
      for (const coordinate of coordinates) bounds.extend(coordinate)
      map.fitBounds(bounds, { padding: 70, maxZoom: 17, duration: 0 })
      fitted.current = true
    }
    return undefined
  }, [points, color, data?.alerts, data?.flight.status, ready])

  // The replay marker follows the playhead.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !here) return
    if (!runner.current) {
      const element = document.createElement('div')
      element.className = 'drone-marker is-selected'
      element.innerHTML = '<span class="drone-dot"></span>'
      runner.current = new Marker({ element }).setLngLat([here.lng, here.lat]).addTo(map)
    }
    runner.current.setLngLat([here.lng, here.lat])
    runner.current.getElement().style.setProperty('--drone-color', color ?? 'var(--pine)')
    if (playing && !map.getBounds().contains([here.lng, here.lat])) {
      map.panTo([here.lng, here.lat], { animate: false })
    }
  }, [here, color, playing, ready])

  useEffect(() => {
    if (!playing) return undefined
    let frame = 0
    let last = performance.now()
    clock.current = t
    const tick = (now: number) => {
      clock.current = Math.min(duration, clock.current + (now - last) * rate)
      last = now
      setT(clock.current)
      if (clock.current >= duration) setPlaying(false)
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // t is read once as the starting point; the loop owns the clock after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, rate, duration])

  function seek(ms: number) {
    clock.current = ms
    setT(ms)
  }

  const flight = data?.flight
  const live = aircraftName(devices, flight?.deviceSn, flight?.deviceLabel)
  const fraction = duration > 0 ? t / duration : 0

  return (
    <>
      <StageBar
        bar="flight"
        title={flight ? `Flight, ${formatDateTime(flight.startedAt)}` : 'Flight'}
        summary={
          flight
            ? `${live} / ${durationLabel(flight.durationS)} / ${distanceLabel(flight.distanceM)}`
            : undefined
        }
        back={{ label: 'Back to flight history', to: '/flights' }}
        railOpen={railOpen}
        onOpenRail={onOpenRail}
      />
      <div
        className="grid min-h-0 flex-1 grid-cols-[400px_minmax(0,1fr)] until-drawer:grid-cols-1 until-drawer:grid-rows-[minmax(260px,44%)_minmax(0,1fr)]"
        data-testid="flight-screen"
      >
        <section
          className="min-h-0 overflow-y-auto overscroll-contain border-r border-r-line bg-surface p-4 [scrollbar-width:thin] until-drawer:order-2 until-drawer:border-r-0 until-drawer:border-t until-drawer:border-t-line"
          aria-label="Flight details"
        >
          {error && (
            <Notice tone="error" className="mb-3.5">
              {error === 'not found' ? 'This flight was not found, or you cannot see it.' : error}
            </Notice>
          )}
          {!flight && !error && <p className="text-[12.5px] text-ink-3">Loading flight…</p>}
          {flight && (
            <>
              <div className="flex items-center gap-2.5">
                <ColorDot color={flight.deviceColor ?? 'transparent'} className="size-3" />
                <h2 className="m-0 min-w-0 flex-1 truncate text-[15px] font-semibold">{live}</h2>
                {flight.status === 'active' ? (
                  <Badge tone="ok">In flight</Badge>
                ) : (
                  <Badge>Completed</Badge>
                )}
              </div>

              <dl
                className="m-0 mt-3.5 grid grid-cols-2 gap-x-3 gap-y-3"
                data-testid="flight-stats"
              >
                {(
                  [
                    ['Took off', formatDateTime(flight.startedAt)],
                    ['Landed', flight.endedAt ? formatDateTime(flight.endedAt) : 'In the air'],
                    ['Duration', durationLabel(flight.durationS)],
                    ['Distance flown', distanceLabel(flight.distanceM)],
                    ['Highest', altitudeLabel(flight.maxAltM)],
                    ['Top speed', speedLabel(flight.maxSpeedMs)],
                    ['Average speed', speedLabel(flight.avgSpeedMs)],
                    ['Lowest battery', batteryLabel(flight.minBatteryPct)],
                    ['Furthest from take-off', distanceLabel(flight.maxRangeM)],
                    ['Controller', flight.controllerSn ?? '—'],
                    ['Take-off point', formatCoord(flight.startLat, flight.startLon)],
                    [
                      'Landing point',
                      flight.endedAt ? formatCoord(flight.endLat, flight.endLon) : '—',
                    ],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className={eyebrow}>{label}</dt>
                    <dd className="m-0 mt-0.5 truncate text-[12.5px] font-medium" title={value}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              <div
                className="mt-4 rounded-lg border border-line bg-white p-3"
                data-testid="flight-replay"
              >
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={duration === 0}
                    aria-pressed={playing}
                    data-testid="replay-toggle"
                    onClick={() => {
                      if (!playing && t >= duration) seek(0)
                      setPlaying(!playing)
                    }}
                  >
                    {playing ? 'Pause' : 'Replay'}
                  </Button>
                  <div className="ml-auto flex gap-1.5" role="group" aria-label="Replay speed">
                    {RATES.map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={cn(segment(rate === value), 'px-2.5')}
                        aria-pressed={rate === value}
                        onClick={() => setRate(value)}
                      >
                        {value}×
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  type="range"
                  className="mt-3 w-full accent-[var(--pine)]"
                  min={0}
                  max={Math.max(duration, 1)}
                  step={100}
                  value={Math.min(t, duration)}
                  disabled={duration === 0}
                  aria-label="Replay position"
                  onChange={(event) => seek(Number(event.target.value))}
                />
                <div className="mt-2 grid grid-cols-4 gap-2 text-center" aria-live="off">
                  {(
                    [
                      ['Time', sample ? formatClock(sample.ts) : '—'],
                      ['Height', altitudeLabel(sample?.alt)],
                      ['Speed', speedLabel(sample?.speed)],
                      ['Heading', headingLabel(sample?.heading)],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <div className={eyebrow}>{label}</div>
                      <div className="mt-0.5 font-mono text-[11px] font-medium">{value}</div>
                    </div>
                  ))}
                </div>
                <Profile
                  title="Height"
                  unit="m"
                  points={points}
                  pick={(point) => point.alt}
                  cursor={fraction}
                  onSeek={(value) => seek(value * duration)}
                />
                <Profile
                  title="Speed"
                  unit="m/s"
                  points={points}
                  pick={(point) => point.speed}
                  cursor={fraction}
                  onSeek={(value) => seek(value * duration)}
                />
              </div>

              <div className="mt-4">
                <div className={`${eyebrow} mb-2`}>Alerts during this flight</div>
                {data.alerts.length === 0 ? (
                  <p className="m-0 text-[12px] text-ink-3">
                    None. The drone stayed clear of every zone.
                  </p>
                ) : (
                  <ul className="m-0 grid list-none gap-1.5 p-0" data-testid="flight-alerts">
                    {data.alerts.map((alert) => (
                      <li key={alert.id}>
                        <button
                          type="button"
                          className="flex w-full items-start gap-2 rounded-md border border-line bg-white px-2.5 py-2 text-left hover:border-zone-nofly"
                          onClick={() => {
                            seek(
                              Math.min(duration, Math.max(0, Date.parse(alert.raisedAt) - start)),
                            )
                            if (alert.lat != null && alert.lon != null)
                              mapRef.current?.flyTo({
                                center: [alert.lon, alert.lat],
                                zoom: 16,
                                duration: 600,
                              })
                          }}
                        >
                          <Badge tone={alert.severity === 'critical' ? 'danger' : 'pending'}>
                            {alertKindLabel[alert.kind]}
                          </Badge>
                          <span className="min-w-0 flex-1 text-[12px]">
                            <span className="block truncate font-medium">
                              {alert.zoneName ?? alert.message}
                            </span>
                            <span className="block font-mono text-[10px] text-ink-3">
                              {formatClock(alert.raisedAt)}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>

        <div className="relative min-h-0 overflow-hidden bg-map-land until-drawer:order-1">
          <BaseMap onReady={onReady} onDispose={onDispose} testId="flight-map" />
          {flight && points.length === 0 && (
            <div className="absolute left-1/2 top-4 z-[3] -translate-x-1/2 rounded-md border border-line bg-surface-2 px-3 py-2 text-[12px] text-ink-2 [box-shadow:var(--shadow-card)]">
              This flight has no recorded positions.
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/** The aircraft's name as the fleet shows it, or what the flight recorded if it has since gone. */
function aircraftName(
  devices: Record<string, { displayName: string | null; model: string | null }>,
  sn: string | undefined,
  fallback: string | null | undefined,
): string {
  const found = sn ? devices[sn] : undefined
  return found?.displayName?.trim() || found?.model || fallback || sn || 'Drone'
}
