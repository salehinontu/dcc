import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  type GeoJSONSource,
} from 'maplibre-gl'
import { can } from '@dji/protocol'
import { api, type TrailPoint, type User } from '../api'
import { deviceLabel } from '../deviceSearch'
import { openAlerts, useFleetData } from '../fleetData'
import { droneOnMap, hasPosition } from '../format'
import { navigate } from '../routes'
import { useFleet } from '../store'
import { addZoneLayers, categoryLabels, metresLabel, setZoneData, zoneAt } from '../zoneMap'
import MapCard from './MapCard'

type Coordinates = [number, number]

const LAYER_KEY = 'drone-fleet.map-layers'

interface Layers {
  noFly: boolean
  geofence: boolean
}

/** True for a `#rrggbb` colour light enough that dark text reads better on it. */
function isLightColor(hex: string): boolean {
  const value = Number.parseInt(hex.slice(1), 16)
  if (Number.isNaN(value)) return false
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
  // Above this, black text has more contrast than white.
  return luminance > 0.179
}

function loadLayers(): Layers {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYER_KEY) ?? '{}') as Partial<Layers>
    return { noFly: saved.noFly !== false, geofence: saved.geofence !== false }
  } catch {
    return { noFly: true, geofence: true }
  }
}

export default function MapView({
  user,
  onViewLive,
}: {
  user: User
  onViewLive: (sn: string) => void
}) {
  const devices = useFleet((state) => state.devices)
  const selected = useFleet((state) => state.selected)
  const select = useFleet((state) => state.select)
  const zones = useFleetData((state) => state.zones)
  const alerts = useFleetData((state) => state.alerts)
  const focus = useFleetData((state) => state.focus)
  const setFocus = useFleetData((state) => state.setFocus)

  const container = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibreMap | null>(null)
  const markers = useRef(new Map<string, Marker>())
  const fitted = useRef(false)
  const [ready, setReady] = useState(false)
  const [trail, setTrail] = useState<TrailPoint[]>([])
  const [layers, setLayers] = useState<Layers>(loadLayers)
  const [zoneId, setZoneId] = useState<string | null>(null)

  const list = useMemo(() => Object.values(devices), [devices])
  const alerting = useMemo(
    () => new Set(openAlerts(alerts).map((alert) => alert.deviceSn)),
    [alerts],
  )
  const selectedDevice = selected ? devices[selected] : undefined
  const zone = zoneId ? (zones.find((candidate) => candidate.id === zoneId) ?? null) : null

  useEffect(() => {
    try {
      localStorage.setItem(LAYER_KEY, JSON.stringify(layers))
    } catch {
      // the choice just is not remembered
    }
  }, [layers])

  useEffect(() => {
    if (!container.current || map.current) return

    const instance = new MapLibreMap({
      container: container.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [90.4125, 23.8103],
      zoom: 12.5,
    })
    const markerMap = markers.current

    instance.addControl(new NavigationControl({ showCompass: false }), 'top-right')

    instance.on('load', () => {
      const trailColor =
        getComputedStyle(document.documentElement).getPropertyValue('--pine').trim() ||
        'transparent'
      addZoneLayers(instance)
      instance.addSource('trail', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [] },
        },
      })
      instance.addLayer({
        id: 'trail-line',
        type: 'line',
        source: 'trail',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': trailColor, 'line-width': 2.6, 'line-opacity': 0.9 },
      })
      setReady(true)
    })

    instance.on('click', (event) => setZoneId(zoneAt(instance, event.point)))
    instance.on('mousemove', (event) => {
      instance.getCanvas().style.cursor = zoneAt(instance, event.point) ? 'pointer' : ''
    })

    map.current = instance

    return () => {
      instance.remove()
      map.current = null
      markerMap.clear()
      fitted.current = false
      setReady(false)
      setTrail([])
    }
  }, [])

  useEffect(() => {
    const instance = map.current
    if (!instance || !ready) return
    setZoneData(instance, zones, { showNoFly: layers.noFly, showGeofences: layers.geofence })
  }, [zones, layers, ready])

  useEffect(() => {
    const instance = map.current
    if (!instance || !ready) return

    const now = Date.now()
    for (const device of list) {
      const telemetry = device.telemetry
      if (!hasPosition(telemetry) || !droneOnMap(device, now)) {
        markers.current.get(device.sn)?.remove()
        markers.current.delete(device.sn)
        continue
      }

      let marker = markers.current.get(device.sn)
      if (!marker) {
        const element = document.createElement('button')
        element.type = 'button'
        element.className = 'drone-marker'
        element.dataset.parity = `marker-${device.sn}`
        element.innerHTML = `<span class="drone-dot" data-parity="marker-dot-${device.sn}"></span><span class="drone-label" data-parity="marker-label-${device.sn}"></span>`
        element.addEventListener('click', () => select(device.sn))

        marker = new Marker({ element }).setLngLat([telemetry.lon, telemetry.lat]).addTo(instance)
        markers.current.set(device.sn, marker)
      }

      marker.setLngLat([telemetry.lon, telemetry.lat])
      const element = marker.getElement()
      element.style.setProperty('--drone-color', device.color)
      element.style.setProperty(
        '--drone-label-text',
        isLightColor(device.color) ? 'var(--drone-label-dark)' : 'var(--drone-label-light)',
      )
      element.classList.toggle('is-selected', device.sn === selected)
      element.classList.toggle('is-offline', !device.online)
      element.classList.toggle('has-alert', alerting.has(device.sn))
      const markerName = `${deviceLabel(device)} (${device.sn.slice(-6)})`
      element.setAttribute('aria-label', `Select ${markerName}`)
      element.title = markerName
      const label = element.querySelector('.drone-label')
      if (label) {
        label.textContent = [
          device.displayName?.trim() || device.sn.slice(-6),
          device.label?.trim(),
        ]
          .filter(Boolean)
          .join(' · ')
      }
    }

    for (const [sn, marker] of markers.current) {
      if (!list.some((device) => device.sn === sn)) {
        marker.remove()
        markers.current.delete(sn)
      }
    }

    if (!fitted.current) {
      const coordinates = list
        .filter((device) => droneOnMap(device, now))
        .map((device) => device.telemetry)
        .filter(hasPosition)
        .map((telemetry) => [telemetry.lon, telemetry.lat] as Coordinates)

      if (coordinates.length > 0) {
        const bounds = new LngLatBounds()
        for (const coordinate of coordinates) bounds.extend(coordinate)
        instance.fitBounds(bounds, { padding: 90, maxZoom: 15, duration: 700 })
        fitted.current = true
      }
    }
  }, [alerting, list, ready, select, selected])

  // "Show on map" from an alert or a flight: centre on that aircraft once.
  useEffect(() => {
    if (!focus || !ready) return
    const telemetry = devices[focus]?.telemetry
    if (!hasPosition(telemetry)) return
    map.current?.flyTo({ center: [telemetry.lon, telemetry.lat], zoom: 14.5, duration: 800 })
    fitted.current = true
    setFocus(null)
  }, [devices, focus, ready, setFocus])

  // The trail takes the colour of the aircraft it belongs to.
  useEffect(() => {
    const instance = map.current
    if (!instance || !ready || !instance.getLayer('trail-line')) return
    instance.setPaintProperty('trail-line', 'line-color', selectedDevice?.color ?? '#2563eb')
  }, [ready, selectedDevice?.color])

  useEffect(() => {
    if (!selected || !ready) return
    let cancelled = false

    const setTrailData = (points: TrailPoint[]) => {
      const source = map.current?.getSource('trail') as GeoJSONSource | undefined
      source?.setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: points
            .filter(hasPosition)
            .map((point) => [point.lon, point.lat] as Coordinates),
        },
      } as unknown as Parameters<GeoJSONSource['setData']>[0])
    }

    const load = async () => {
      try {
        if (!can(user, 'telemetry.view', selected)) return
        const result = await api.trail(selected, 10)
        if (cancelled) return
        const ordered = [...result.points].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''))
        setTrail(ordered)
        setTrailData(ordered)
      } catch {
        // keep the previous trail
      }
    }

    void load()
    const timer = window.setInterval(() => void load(), 5000)

    return () => {
      cancelled = true
      clearInterval(timer)
      setTrail([])
      setTrailData([])
    }
  }, [selected, ready, user])

  const noFlyCount = zones.filter((candidate) => candidate.kind === 'no_fly').length
  const fenceCount = zones.length - noFlyCount

  return (
    <div
      className="relative min-h-0 flex-1 overflow-hidden bg-map-land"
      data-parity="map-screen"
      data-testid="map"
    >
      <div className="map" data-parity="map-container" ref={container} />
      <div className="absolute left-4 top-4 z-[2] flex flex-col items-start gap-1.5 until-phone-lg:top-3">
        <div
          className="inline-flex h-[30px] items-center gap-2 whitespace-nowrap rounded-sm border border-line bg-glass-paper px-2.5 font-mono text-[9px] tracking-[0.03em] text-ink-2 until-phone-lg:h-7 until-phone-lg:text-[8.5px]"
          data-parity="map-legend"
        >
          <span
            className="relative h-0.5 w-4 flex-none bg-pine"
            data-decor="legend-swatch"
            data-parity="legend-swatch"
            aria-hidden="true"
          />
          Flight trail / last 10 min
        </div>
        <fieldset
          className="m-0 flex flex-col gap-1 rounded-sm border border-line bg-glass-paper px-2.5 py-1.5 text-[11px] text-ink-2"
          data-testid="map-layers"
        >
          <legend className="sr-only">Map layers</legend>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="size-3.5 accent-[var(--zone-nofly)]"
              checked={layers.noFly}
              onChange={(event) => setLayers({ ...layers, noFly: event.target.checked })}
            />
            <span className="size-2.5 rounded-[2px] border border-zone-nofly bg-zone-nofly-soft" />
            No-fly zones
            <span className="font-mono text-[9px] text-ink-3">{noFlyCount}</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="size-3.5 accent-[var(--zone-geofence)]"
              checked={layers.geofence}
              onChange={(event) => setLayers({ ...layers, geofence: event.target.checked })}
            />
            <span className="size-2.5 rounded-[2px] border border-dashed border-zone-geofence bg-zone-geofence-soft" />
            Geofences
            <span className="font-mono text-[9px] text-ink-3">{fenceCount}</span>
          </label>
        </fieldset>
      </div>

      {zone && (
        <div
          className="absolute right-[62px] top-4 z-[3] w-[250px] rounded-[12px] border border-line bg-surface-2 p-3 text-[12px] [box-shadow:var(--shadow-float)] until-phone-lg:right-3 until-phone-lg:top-auto until-phone-lg:bottom-[250px]"
          data-testid="zone-card"
        >
          <div className="flex items-start gap-2">
            <span
              className={`mt-1 size-2.5 flex-none rounded-[2px] border ${
                zone.kind === 'no_fly'
                  ? 'border-zone-nofly bg-zone-nofly-soft'
                  : 'border-dashed border-zone-geofence bg-zone-geofence-soft'
              }`}
            />
            <div className="min-w-0 flex-1">
              <div className="font-semibold leading-[1.3]">{zone.name}</div>
              <div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-3">
                {zone.kind === 'no_fly' ? `No-fly · ${categoryLabels[zone.category]}` : 'Geofence'}
                {!zone.enabled && ' · off'}
              </div>
            </div>
            <button
              type="button"
              className="-mr-1 -mt-1 grid size-6 place-items-center rounded-sm text-ink-3 hover:bg-sunken hover:text-ink"
              aria-label="Close"
              onClick={() => setZoneId(null)}
            >
              ×
            </button>
          </div>
          {zone.kind === 'no_fly' && (
            <div className="mt-2 text-ink-2">
              Warning starts <strong>{metresLabel(zone.bufferM)}</strong> before the edge.
            </div>
          )}
          {zone.notes && <div className="mt-1.5 leading-[1.5] text-ink-3">{zone.notes}</div>}
          {can(user, 'zones.manage') && (
            <button
              type="button"
              className="mt-2.5 text-[11.5px] font-medium text-pine hover:underline"
              onClick={() => navigate(`/zones?zone=${encodeURIComponent(zone.id)}`)}
            >
              Edit this zone
            </button>
          )}
        </div>
      )}

      <MapCard
        canViewLive={Boolean(selected && can(user, 'streams.view', selected))}
        trail={trail}
        onViewLive={onViewLive}
      />
    </div>
  )
}
