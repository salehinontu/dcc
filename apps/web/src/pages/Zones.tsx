import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LngLatBounds, Marker, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
import {
  bufferRing,
  can,
  circleRing,
  DEFAULT_BUFFER_M,
  haversineM,
  MAX_BUFFER_M,
  MAX_CIRCLE_RADIUS_M,
  MIN_CIRCLE_RADIUS_M,
  ringAreaM2,
  shapeBounds,
  validateShape,
  ZONE_CATEGORIES,
  type LngLat,
  type Zone,
  type ZoneCategory,
  type ZoneKind,
  type ZoneShape,
} from '@dji/protocol'
import { api, type User } from '../api'
import BaseMap from '../components/BaseMap'
import ColorDot from '../components/ColorDot'
import Icon from '../components/Icon'
import StageBar from '../components/StageBar'
import { deviceLabel, deviceName } from '../deviceSearch'
import { useFleetData } from '../fleetData'
import { hasPosition } from '../format'
import { useFleet } from '../store'
import Badge from '../ui/Badge'
import Button from '../ui/Button'
import Notice from '../ui/Notice'
import { cn } from '../ui/cn'
import { compactInput, eyebrow, segment } from '../ui/surface'
import {
  addZoneLayers,
  categoryLabels,
  metresLabel,
  setZoneData,
  zoneAt,
  zoneColors,
} from '../zoneMap'

type Mode = 'idle' | 'circle' | 'polygon'
type Shape = ZoneShape['type']

interface Draft {
  id: string | null
  kind: ZoneKind
  name: string
  category: ZoneCategory
  shapeType: Shape
  shape: ZoneShape | null
  bufferM: number
  enabled: boolean
  deviceSns: string[]
  notes: string
  source: 'builtin' | 'custom'
}

const DRAFT_SHAPE = 'draft-shape'
const DRAFT_BUFFER = 'draft-buffer'
const DRAFT_PENDING = 'draft-pending'
const FOCUS = 'zone-focus'
const M_PER_DEG = 111_195

const BUFFER_CHIPS = [0, 100, 300, 500, 1000, 3000]

const fieldLabel = 'mb-1.5 block text-[11.5px] font-medium text-ink-2'

const emptyCollection = { type: 'FeatureCollection', features: [] }

function newDraft(kind: ZoneKind): Draft {
  return {
    id: null,
    kind,
    name: '',
    category: 'custom',
    shapeType: 'circle',
    shape: null,
    bufferM: kind === 'no_fly' ? DEFAULT_BUFFER_M.custom : 0,
    enabled: true,
    deviceSns: [],
    notes: '',
    source: 'custom',
  }
}

function draftFromZone(zone: Zone): Draft {
  return {
    id: zone.id,
    kind: zone.kind,
    name: zone.name,
    category: zone.category,
    shapeType: zone.shape.type,
    shape: zone.shape,
    bufferM: zone.bufferM,
    enabled: zone.enabled,
    deviceSns: zone.deviceSns,
    notes: zone.notes,
    source: zone.source,
  }
}

function areaLabel(m2: number): string {
  if (m2 < 10_000) return `${Math.round(m2)} m²`
  if (m2 < 1_000_000) return `${Math.round(m2 / 100) / 100} ha`
  return `${Math.round(m2 / 10_000) / 100} km²`
}

/** Where the radius grip of a circle sits: due east of the centre. */
function eastOf(center: LngLat, radiusM: number): LngLat {
  const scale = M_PER_DEG * Math.max(Math.cos((center[1] * Math.PI) / 180), 0.01)
  return [center[0] + radiusM / scale, center[1]]
}

function midpoint(a: LngLat, b: LngLat): LngLat {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

function feature(coordinates: LngLat[][]) {
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } }
}

function line(coordinates: LngLat[]) {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }
}

function collection(...features: unknown[]) {
  return { type: 'FeatureCollection', features }
}

function ringOf(shape: ZoneShape): LngLat[] {
  return shape.type === 'circle' ? circleRing(shape.center, shape.radiusM) : shape.ring
}

function sourceOf(map: MapLibreMap, id: string): GeoJSONSource | undefined {
  return map.getSource(id) as GeoJSONSource | undefined
}

/** Sources and layers for the shape being drawn, above the saved zones. */
function addDraftLayers(map: MapLibreMap): void {
  if (map.getSource(DRAFT_SHAPE)) return
  const colors = zoneColors()
  for (const id of [DRAFT_BUFFER, DRAFT_SHAPE, DRAFT_PENDING, FOCUS]) {
    map.addSource(id, { type: 'geojson', data: emptyCollection as never })
  }
  map.addLayer({
    id: 'focus-line',
    type: 'line',
    source: FOCUS,
    layout: { 'line-join': 'round' },
    paint: { 'line-color': colors.focus, 'line-width': 5, 'line-opacity': 0.9 },
  })
  map.addLayer({
    id: 'draft-buffer-line',
    type: 'line',
    source: DRAFT_BUFFER,
    paint: { 'line-color': colors.noFly, 'line-width': 1.6, 'line-dasharray': [3, 2.5] },
  })
  map.addLayer({
    id: 'draft-fill',
    type: 'fill',
    source: DRAFT_SHAPE,
    paint: { 'fill-color': colors.noFly, 'fill-opacity': 0.28 },
  })
  map.addLayer({
    id: 'draft-line',
    type: 'line',
    source: DRAFT_SHAPE,
    layout: { 'line-join': 'round' },
    paint: { 'line-color': colors.noFly, 'line-width': 2.4 },
  })
  map.addLayer({
    id: 'draft-pending-fill',
    type: 'fill',
    source: DRAFT_PENDING,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': colors.noFly, 'fill-opacity': 0.14 },
  })
  map.addLayer({
    id: 'draft-pending-line',
    type: 'line',
    source: DRAFT_PENDING,
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': colors.noFly, 'line-width': 2.4, 'line-dasharray': [2, 1.5] },
  })
}

/** Repaint the draft: its shape, warning band and the polygon being traced. */
function paintDraft(
  map: MapLibreMap,
  draft: Draft | null,
  mode: Mode,
  pending: LngLat[],
  cursor: LngLat | null,
): void {
  if (!map.getSource(DRAFT_SHAPE)) return
  const colors = zoneColors()
  const color = draft?.kind === 'geofence' ? colors.geofence : colors.noFly
  for (const layer of ['draft-fill', 'draft-line', 'draft-pending-fill', 'draft-pending-line']) {
    const property = layer.endsWith('fill') ? 'fill-color' : 'line-color'
    map.setPaintProperty(layer, property, color)
  }
  map.setPaintProperty('draft-buffer-line', 'line-color', color)
  map.setPaintProperty('draft-fill', 'fill-opacity', draft?.kind === 'geofence' ? 0.1 : 0.28)

  const shape = draft && mode === 'idle' ? draft.shape : null
  sourceOf(map, DRAFT_SHAPE)?.setData(
    (shape
      ? collection(feature([[...ringOf(shape), ringOf(shape)[0]!]]))
      : emptyCollection) as never,
  )
  const band =
    shape && draft?.kind === 'no_fly' && draft.bufferM > 0 ? bufferRing(shape, draft.bufferM) : null
  sourceOf(map, DRAFT_BUFFER)?.setData(
    (band ? collection(feature([[...band, band[0]!]])) : emptyCollection) as never,
  )

  const trace = mode === 'polygon' ? (cursor ? [...pending, cursor] : pending) : []
  const features: unknown[] = []
  if (trace.length >= 2) features.push(line(trace))
  if (trace.length >= 3) features.push(feature([[...trace, trace[0]!]]))
  sourceOf(map, DRAFT_PENDING)?.setData(collection(...features) as never)
}

/**
 * Draw, edit and review no-fly zones and geofences. Zones sit on a map with a list beside it.
 * A no-fly zone is red with a dashed warning band; a geofence is blue and alerts when an
 * aircraft that is flying leaves it. Shapes are circles or polygons, drawn by clicking and
 * reshaped by dragging their handles.
 */
export default function Zones({
  user,
  railOpen,
  onOpenRail,
}: {
  user: User
  railOpen: boolean
  onOpenRail: (trigger: HTMLButtonElement) => void
}) {
  const zones = useFleetData((state) => state.zones)
  const zonesLoaded = useFleetData((state) => state.zonesLoaded)
  const loadZones = useFleetData((state) => state.loadZones)
  const devices = useFleet((state) => state.devices)
  const canManage = can(user, 'zones.manage')

  const [ready, setReady] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [mode, setMode] = useState<Mode>('idle')
  const [pending, setPending] = useState<LngLat[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | ZoneKind>('all')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  const mapRef = useRef<MapLibreMap | null>(null)
  const fitted = useRef(false)
  const deepLinked = useRef(false)
  const dragging = useRef(false)
  const cursor = useRef<LngLat | null>(null)
  const live = useRef({ draft, mode, pending })
  const handles = useRef<{
    center: Marker | null
    radius: Marker | null
    vertices: Marker[]
    mids: Marker[]
  }>({ center: null, radius: null, vertices: [], mids: [] })

  useEffect(() => {
    live.current = { draft, mode, pending }
  })

  useEffect(() => {
    void loadZones()
  }, [loadZones])

  const fleet = useMemo(
    () => Object.values(devices).sort((a, b) => deviceName(a).localeCompare(deviceName(b))),
    [devices],
  )
  const noFlyCount = zones.filter((zone) => zone.kind === 'no_fly').length
  const geofenceCount = zones.length - noFlyCount
  const selected = zones.find((zone) => zone.id === selectedId) ?? null

  const shown = useMemo(() => {
    const text = query.trim().toLowerCase()
    return zones
      .filter((zone) => kindFilter === 'all' || zone.kind === kindFilter)
      .filter(
        (zone) =>
          !text ||
          zone.name.toLowerCase().includes(text) ||
          categoryLabels[zone.category].toLowerCase().includes(text),
      )
      .sort(
        (a, b) =>
          (a.source === b.source ? 0 : a.source === 'custom' ? -1 : 1) ||
          a.kind.localeCompare(b.kind) ||
          a.name.localeCompare(b.name),
      )
  }, [zones, query, kindFilter])

  const fitShape = useCallback((shape: ZoneShape, bufferM = 0) => {
    const map = mapRef.current
    if (!map) return
    const [west, south, east, north] = shapeBounds(shape)
    const pad = bufferM / M_PER_DEG
    map.fitBounds(
      [
        [west - pad, south - pad],
        [east + pad, north + pad],
      ],
      { padding: 70, maxZoom: 16, duration: 600 },
    )
  }, [])

  const openEditor = useCallback(
    (zone: Zone) => {
      setError('')
      setNotice('')
      setMode('idle')
      setPending([])
      setSelectedId(zone.id)
      setDraft(draftFromZone(zone))
      fitShape(zone.shape, zone.bufferM)
    },
    [fitShape],
  )

  function startNew(kind: ZoneKind) {
    setError('')
    setNotice('')
    setSelectedId(null)
    setDraft(newDraft(kind))
    setPending([])
    setMode('circle')
  }

  function startDraw(type: Shape) {
    if (!draft) return
    setError('')
    setPending([])
    setDraft({ ...draft, shapeType: type, shape: draft.shape?.type === type ? draft.shape : null })
    // Redrawing the current shape type replaces it on the next click.
    setMode(type)
  }

  function closeEditor() {
    setDraft(null)
    setMode('idle')
    setPending([])
    setError('')
  }

  const finishPolygon = useCallback(() => {
    const { draft: current, pending: points } = live.current
    if (!current) return
    if (points.length < 3) {
      setError('Add at least three points, then finish the shape.')
      return
    }
    const shape: ZoneShape = { type: 'polygon', ring: points }
    const problem = validateShape(shape)
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    setDraft({ ...current, shapeType: 'polygon', shape })
    setPending([])
    setMode('idle')
  }, [])

  function cancelDrawing() {
    setPending([])
    setMode('idle')
    setError('')
  }

  /* ---------------------------------------------------------------- map wiring */

  const onReady = useCallback((map: MapLibreMap) => {
    mapRef.current = map
    addZoneLayers(map)
    addDraftLayers(map)

    map.on('click', (event) => {
      const { draft: current, mode: drawing } = live.current
      const point: LngLat = [event.lngLat.lng, event.lngLat.lat]
      if (!current) {
        // Not editing: clicking a zone on the map picks it in the list.
        setSelectedId(zoneAt(map, event.point))
        return
      }
      if (drawing === 'circle') {
        const bounds = map.getBounds()
        const width = haversineM([bounds.getWest(), point[1]], [bounds.getEast(), point[1]])
        const radiusM = Math.min(MAX_CIRCLE_RADIUS_M, Math.max(50, Math.round(width / 8 / 10) * 10))
        setDraft({
          ...current,
          shapeType: 'circle',
          shape: { type: 'circle', center: point, radiusM },
        })
        setMode('idle')
      } else if (drawing === 'polygon') {
        setPending((points) => [...points, point])
      }
    })
    map.on('mousemove', (event) => {
      if (live.current.mode !== 'polygon') return
      cursor.current = [event.lngLat.lng, event.lngLat.lat]
      paintDraft(map, live.current.draft, 'polygon', live.current.pending, cursor.current)
    })
    setReady(true)
  }, [])

  const onDispose = useCallback(() => {
    mapRef.current = null
    setReady(false)
  }, [])

  // Saved zones, minus the one being edited (the draft layer draws it instead).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    setZoneData(map, zones, { hideId: draft?.id ?? null })
  }, [zones, draft?.id, ready])

  // The draft shape, its warning band and the polygon being traced.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    cursor.current = null
    paintDraft(map, draft, mode, pending, null)
    map.getCanvas().style.cursor = mode === 'idle' ? '' : 'crosshair'
    if (mode === 'idle') map.doubleClickZoom.enable()
    else map.doubleClickZoom.disable()
  }, [draft, mode, pending, ready])

  // A thick gold outline around the zone picked in the list.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const focused = selected && selected.id !== draft?.id ? selected : null
    sourceOf(map, FOCUS)?.setData(
      (focused
        ? collection(feature([[...ringOf(focused.shape), ringOf(focused.shape)[0]!]]))
        : emptyCollection) as never,
    )
  }, [selected, draft?.id, ready])

  // First view: where the fleet is, else all zones.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !zonesLoaded || fitted.current) return
    if (new URLSearchParams(window.location.search).has('zone')) return
    const bounds = new LngLatBounds()
    let any = false
    for (const device of Object.values(devices)) {
      if (!hasPosition(device.telemetry)) continue
      bounds.extend([device.telemetry.lon, device.telemetry.lat])
      any = true
    }
    if (!any) {
      for (const zone of zones) {
        const [west, south, east, north] = shapeBounds(zone.shape)
        bounds.extend([west, south])
        bounds.extend([east, north])
        any = true
      }
    }
    fitted.current = true
    if (any) map.fitBounds(bounds, { padding: 70, maxZoom: 11, duration: 0 })
  }, [devices, ready, zones, zonesLoaded])

  // `?zone=<id>` from the map card opens that zone for editing (or just shows it).
  useEffect(() => {
    if (deepLinked.current || !ready || !zonesLoaded) return
    const id = new URLSearchParams(window.location.search).get('zone')
    if (!id) return
    deepLinked.current = true
    fitted.current = true
    const zone = zones.find((candidate) => candidate.id === id)
    window.history.replaceState(null, '', window.location.pathname)
    if (!zone) return
    if (canManage) openEditor(zone)
    else {
      setSelectedId(zone.id)
      fitShape(zone.shape, zone.bufferM)
    }
  }, [canManage, fitShape, openEditor, ready, zones, zonesLoaded])

  // Drag handles: vertices, midpoints, circle centre and radius grip.
  const ringLength = draft?.shape?.type === 'polygon' ? draft.shape.ring.length : 0
  const structure = `${mode}|${draft?.shape?.type ?? ''}|${ringLength}|${pending.length}|${draft?.kind ?? ''}`

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return undefined
    const { draft: current, mode: drawing, pending: points } = live.current
    if (!current) return undefined

    const color = current.kind === 'geofence' ? 'var(--zone-geofence)' : 'var(--zone-nofly)'
    const halo =
      current.kind === 'geofence' ? 'var(--zone-geofence-halo)' : 'var(--zone-nofly-halo)'
    const created: Marker[] = []
    const make = (className: string, at: LngLat, draggable: boolean, label: string): Marker => {
      const element = document.createElement('div')
      element.className = `zone-handle ${className}`
      element.style.setProperty('--handle-color', color)
      element.style.setProperty('--handle-halo', halo)
      element.setAttribute('role', 'presentation')
      element.title = label
      const marker = new Marker({ element, draggable }).setLngLat(at).addTo(map)
      created.push(marker)
      return marker
    }
    const bag = { center: null, radius: null, vertices: [], mids: [] } as typeof handles.current
    handles.current = bag

    const updateDraftShape = (shape: ZoneShape) =>
      setDraft((existing) => (existing ? { ...existing, shape } : existing))

    if (drawing === 'polygon') {
      points.forEach((point, index) => {
        const marker = make(
          index === 0 && points.length >= 3 ? 'is-pending is-first' : 'is-pending',
          point,
          false,
          index === 0 && points.length >= 3 ? 'Close the shape' : `Point ${index + 1}`,
        )
        if (index === 0 && points.length >= 3) {
          marker.getElement().addEventListener('click', (event) => {
            event.stopPropagation()
            finishPolygon()
          })
        }
      })
    } else if (drawing === 'idle' && current.shape?.type === 'circle') {
      const circle = current.shape
      const centerMarker = make('is-center', circle.center, true, 'Drag to move the zone')
      const radiusMarker = make(
        'is-radius',
        eastOf(circle.center, circle.radiusM),
        true,
        'Drag to resize the zone',
      )
      bag.center = centerMarker
      bag.radius = radiusMarker
      for (const marker of [centerMarker, radiusMarker]) {
        marker.on('dragstart', () => {
          dragging.current = true
        })
      }
      centerMarker.on('drag', () => {
        const at = centerMarker.getLngLat()
        const radiusM =
          (live.current.draft?.shape as { radiusM?: number } | null)?.radiusM ?? circle.radiusM
        radiusMarker.setLngLat(eastOf([at.lng, at.lat], radiusM))
        updateDraftShape({ type: 'circle', center: [at.lng, at.lat], radiusM })
      })
      radiusMarker.on('drag', () => {
        const at = radiusMarker.getLngLat()
        const centre = centerMarker.getLngLat()
        const radiusM = Math.min(
          MAX_CIRCLE_RADIUS_M,
          Math.max(
            MIN_CIRCLE_RADIUS_M,
            Math.round(haversineM([centre.lng, centre.lat], [at.lng, at.lat])),
          ),
        )
        updateDraftShape({ type: 'circle', center: [centre.lng, centre.lat], radiusM })
      })
      for (const marker of [centerMarker, radiusMarker]) {
        marker.on('dragend', () => {
          dragging.current = false
          const centre = centerMarker.getLngLat()
          const shape = live.current.draft?.shape
          if (shape?.type === 'circle') {
            radiusMarker.setLngLat(eastOf([centre.lng, centre.lat], shape.radiusM))
          }
        })
      }
    } else if (drawing === 'idle' && current.shape?.type === 'polygon') {
      const ring = current.shape.ring
      const placeMids = () => {
        bag.mids.forEach((mid, index) => {
          const a = bag.vertices[index]!.getLngLat()
          const b = bag.vertices[(index + 1) % bag.vertices.length]!.getLngLat()
          mid.setLngLat(midpoint([a.lng, a.lat], [b.lng, b.lat]))
        })
      }
      const readRing = (): LngLat[] =>
        bag.vertices.map((marker) => {
          const at = marker.getLngLat()
          return [at.lng, at.lat] as LngLat
        })

      ring.forEach((vertex, index) => {
        const marker = make('is-vertex', vertex, true, 'Drag to move. Double-click to remove.')
        marker.on('dragstart', () => {
          dragging.current = true
        })
        marker.on('drag', () => {
          placeMids()
          updateDraftShape({ type: 'polygon', ring: readRing() })
        })
        marker.on('dragend', () => {
          dragging.current = false
          // The last pointer move may not have fired a drag event: commit where it landed.
          updateDraftShape({ type: 'polygon', ring: readRing() })
        })
        const remove = (event: Event) => {
          event.preventDefault()
          event.stopPropagation()
          const shape = live.current.draft?.shape
          if (shape?.type !== 'polygon') return
          if (shape.ring.length <= 3) {
            setError('A polygon needs at least three points.')
            return
          }
          updateDraftShape({ type: 'polygon', ring: shape.ring.filter((_, at) => at !== index) })
        }
        marker.getElement().addEventListener('dblclick', remove)
        marker.getElement().addEventListener('contextmenu', remove)
        bag.vertices.push(marker)
      })
      ring.forEach((vertex, index) => {
        const next = ring[(index + 1) % ring.length]!
        const mid = make('is-mid', midpoint(vertex, next), false, 'Click to add a point here')
        mid.getElement().addEventListener('click', (event) => {
          event.stopPropagation()
          const shape = live.current.draft?.shape
          if (shape?.type !== 'polygon') return
          const at = midpoint(shape.ring[index]!, shape.ring[(index + 1) % shape.ring.length]!)
          const ringCopy = [...shape.ring]
          ringCopy.splice(index + 1, 0, at)
          updateDraftShape({ type: 'polygon', ring: ringCopy })
        })
        bag.mids.push(mid)
      })
    }

    return () => {
      for (const marker of created) marker.remove()
      handles.current = { center: null, radius: null, vertices: [], mids: [] }
      dragging.current = false
    }
  }, [structure, ready, finishPolygon])

  // Typing a radius or moving a point elsewhere repositions the handles in place.
  useEffect(() => {
    if (dragging.current) return
    const shape = draft?.shape
    const bag = handles.current
    if (shape?.type === 'circle' && bag.center && bag.radius) {
      bag.center.setLngLat(shape.center)
      bag.radius.setLngLat(eastOf(shape.center, shape.radiusM))
    }
  }, [draft?.shape])

  // Keyboard: Enter closes the polygon, Escape drops the drawing in progress.
  useEffect(() => {
    if (mode === 'idle') return undefined
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (event.key === 'Escape') {
        setPending([])
        setMode('idle')
      } else if (event.key === 'Enter' && mode === 'polygon') {
        finishPolygon()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, finishPolygon])

  /* ---------------------------------------------------------------- saving */

  async function save() {
    if (!draft) return
    const name = draft.name.trim()
    if (!name) {
      setError('Give the zone a name.')
      return
    }
    if (!draft.shape) {
      setError('Draw the area on the map first.')
      return
    }
    const problem = validateShape(draft.shape)
    if (problem) {
      setError(problem)
      return
    }
    setSaving(true)
    setError('')
    const input = {
      kind: draft.kind,
      name,
      category: draft.kind === 'geofence' ? ('custom' as const) : draft.category,
      shape: draft.shape,
      bufferM: draft.kind === 'no_fly' ? draft.bufferM : 0,
      enabled: draft.enabled,
      deviceSns: draft.kind === 'geofence' ? draft.deviceSns : [],
      notes: draft.notes.trim(),
    }
    try {
      const result = draft.id ? await api.updateZone(draft.id, input) : await api.createZone(input)
      await loadZones()
      setSelectedId(result.zone.id)
      setNotice(draft.id ? 'Zone saved.' : 'Zone added.')
      closeEditor()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!draft?.id) return
    const builtin = draft.source === 'builtin'
    if (
      !window.confirm(
        builtin
          ? `Delete “${draft.name}”? It is one of the zones that came with the app; it will not come back.`
          : `Delete “${draft.name}”?`,
      )
    )
      return
    setSaving(true)
    try {
      await api.deleteZone(draft.id)
      await loadZones()
      setSelectedId(null)
      setNotice('Zone deleted.')
      closeEditor()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  function pickCategory(category: ZoneCategory) {
    if (!draft) return
    // A new zone follows the usual warning distance of its category until it is changed by hand.
    const usual = Object.values(DEFAULT_BUFFER_M).includes(draft.bufferM)
    setDraft({
      ...draft,
      category,
      bufferM: !draft.id && usual ? DEFAULT_BUFFER_M[category] : draft.bufferM,
    })
  }

  const shape = draft?.shape ?? null
  const noFlyDraft = draft?.kind === 'no_fly'

  return (
    <>
      <StageBar
        bar="zones"
        title="Zones and geofences"
        summary={`${noFlyCount} no-fly zones / ${geofenceCount} geofences`}
        actions={
          canManage && !draft ? (
            <>
              <Button
                variant="secondary"
                type="button"
                onClick={() => startNew('no_fly')}
                data-testid="add-nofly"
              >
                <Icon name="plus" />
                No-fly zone
              </Button>
              <Button
                variant="secondary"
                type="button"
                onClick={() => startNew('geofence')}
                data-testid="add-geofence"
              >
                <Icon name="plus" />
                Geofence
              </Button>
            </>
          ) : undefined
        }
        railOpen={railOpen}
        onOpenRail={onOpenRail}
      />

      <div
        className="grid min-h-0 flex-1 grid-cols-[380px_minmax(0,1fr)] until-drawer:grid-cols-1 until-drawer:grid-rows-[minmax(260px,44%)_minmax(0,1fr)] until-narrow:grid-cols-1"
        data-testid="zones-screen"
      >
        <section
          className="flex min-h-0 flex-col border-r border-r-line bg-surface until-drawer:order-2 until-drawer:border-r-0 until-drawer:border-t until-drawer:border-t-line"
          aria-label={draft ? 'Zone editor' : 'Zones'}
        >
          {draft ? (
            <form
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 [scrollbar-width:thin]"
              data-testid="zone-form"
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              <div className="mb-3.5 flex items-center gap-2.5">
                <span
                  className={cn(
                    'size-3 flex-none rounded-[3px] border',
                    noFlyDraft
                      ? 'border-zone-nofly bg-zone-nofly-soft'
                      : 'border-dashed border-zone-geofence bg-zone-geofence-soft',
                  )}
                />
                <h2 className="m-0 text-[15px] font-semibold">
                  {draft.id ? 'Edit' : 'New'} {noFlyDraft ? 'no-fly zone' : 'geofence'}
                </h2>
                {draft.source === 'builtin' && <Badge tone="neutral">Built-in</Badge>}
              </div>

              <p className="m-0 mb-3.5 text-[12px] leading-[1.55] text-ink-3">
                {noFlyDraft
                  ? 'A drone that is flying gets a warning when it comes within the warning distance of this area, and a critical alert when it enters.'
                  : 'You are alerted when a drone that is flying leaves this area.'}
              </p>

              <label className={fieldLabel} htmlFor="zone-name">
                Name
              </label>
              <input
                id="zone-name"
                className={compactInput}
                maxLength={80}
                value={draft.name}
                placeholder={noFlyDraft ? 'Cantonment north gate' : 'Site boundary'}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />

              {noFlyDraft && (
                <div className="mt-3.5">
                  <label className={fieldLabel} htmlFor="zone-category">
                    Type
                  </label>
                  <select
                    id="zone-category"
                    className={compactInput}
                    value={draft.category}
                    onChange={(event) => pickCategory(event.target.value as ZoneCategory)}
                  >
                    {ZONE_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {categoryLabels[category]}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="mt-3.5">
                <span className={fieldLabel}>Shape</span>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Shape">
                  {(['circle', 'polygon'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      className={segment(draft.shapeType === type)}
                      aria-pressed={draft.shapeType === type}
                      data-testid={`shape-${type}`}
                      onClick={() => startDraw(type)}
                    >
                      {type === 'circle' ? 'Circle' : 'Polygon'}
                    </button>
                  ))}
                </div>

                <div
                  className="mt-2.5 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-[12px] leading-[1.55] text-ink-2"
                  data-testid="shape-status"
                >
                  {mode === 'circle' && 'Click the map where the zone should be centred.'}
                  {mode === 'polygon' &&
                    (pending.length < 3
                      ? `Click the map to add corners (${pending.length} so far, at least 3).`
                      : `${pending.length} corners. Click the first point, press Enter or use Finish to close the shape.`)}
                  {mode === 'idle' && !shape && 'Choose a shape, then draw it on the map.'}
                  {mode === 'idle' && shape?.type === 'circle' && (
                    <>
                      Circle, radius <strong>{metresLabel(shape.radiusM)}</strong>. Drag the centre
                      to move it, or the square grip to resize.
                    </>
                  )}
                  {mode === 'idle' && shape?.type === 'polygon' && (
                    <>
                      Polygon, <strong>{shape.ring.length} corners</strong>,{' '}
                      {areaLabel(Math.abs(ringAreaM2(shape.ring)))}. Drag a corner to move it, click
                      a small dot to add one, double-click a corner to remove it.
                    </>
                  )}
                </div>

                {mode === 'polygon' && (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      type="button"
                      disabled={pending.length < 3}
                      onClick={finishPolygon}
                      data-testid="finish-polygon"
                    >
                      <Icon name="check" />
                      Finish
                    </Button>
                    <Button
                      variant="secondary"
                      type="button"
                      disabled={pending.length === 0}
                      onClick={() => setPending((points) => points.slice(0, -1))}
                    >
                      Undo point
                    </Button>
                  </div>
                )}
                {mode !== 'idle' && (
                  <Button
                    variant="secondary"
                    type="button"
                    className="mt-2"
                    onClick={cancelDrawing}
                  >
                    Stop drawing
                  </Button>
                )}
                {mode === 'idle' && shape && (
                  <Button
                    variant="secondary"
                    type="button"
                    className="mt-2.5"
                    onClick={() => startDraw(shape.type)}
                  >
                    <Icon name="crosshair" />
                    Redraw
                  </Button>
                )}

                {shape?.type === 'circle' && mode === 'idle' && (
                  <div className="mt-3">
                    <label className={fieldLabel} htmlFor="zone-radius">
                      Radius (metres)
                    </label>
                    <input
                      id="zone-radius"
                      type="number"
                      inputMode="numeric"
                      className={compactInput}
                      min={MIN_CIRCLE_RADIUS_M}
                      max={MAX_CIRCLE_RADIUS_M}
                      value={Math.round(shape.radiusM)}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          shape: { ...shape, radiusM: Number(event.target.value) || 0 },
                        })
                      }
                    />
                  </div>
                )}
              </div>

              {noFlyDraft ? (
                <div className="mt-4 rounded-md border border-line p-3">
                  <label className={fieldLabel} htmlFor="zone-buffer">
                    Warning distance (metres from the edge)
                  </label>
                  <input
                    id="zone-buffer"
                    type="number"
                    inputMode="numeric"
                    className={compactInput}
                    min={0}
                    max={MAX_BUFFER_M}
                    step={50}
                    value={draft.bufferM}
                    data-testid="zone-buffer"
                    onChange={(event) =>
                      setDraft({ ...draft, bufferM: Math.max(0, Number(event.target.value) || 0) })
                    }
                  />
                  <input
                    type="range"
                    className="mt-2.5 w-full accent-[var(--zone-nofly)]"
                    min={0}
                    max={10_000}
                    step={50}
                    value={Math.min(draft.bufferM, 10_000)}
                    aria-label="Warning distance"
                    onChange={(event) =>
                      setDraft({ ...draft, bufferM: Number(event.target.value) })
                    }
                  />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {BUFFER_CHIPS.map((metres) => (
                      <button
                        key={metres}
                        type="button"
                        className={segment(draft.bufferM === metres)}
                        onClick={() => setDraft({ ...draft, bufferM: metres })}
                      >
                        {metres === 0 ? 'None' : metresLabel(metres)}
                      </button>
                    ))}
                  </div>
                  <p className="m-0 mt-2 text-[11.5px] leading-[1.5] text-ink-3">
                    The dashed red line on the map shows where the warning starts. This distance is
                    saved with the zone.
                  </p>
                </div>
              ) : (
                <fieldset className="m-0 mt-4 rounded-md border border-line p-3">
                  <legend className="px-1 text-[11.5px] font-medium text-ink-2">Applies to</legend>
                  <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                    <input
                      type="checkbox"
                      checked={draft.deviceSns.length === 0}
                      onChange={(event) => {
                        if (event.target.checked) setDraft({ ...draft, deviceSns: [] })
                      }}
                    />
                    Every drone
                  </label>
                  {fleet.length > 0 && (
                    <ul className="m-0 mt-2 grid list-none gap-1.5 p-0">
                      {fleet.map((device) => (
                        <li key={device.sn}>
                          <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                            <input
                              type="checkbox"
                              checked={draft.deviceSns.includes(device.sn)}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  deviceSns: event.target.checked
                                    ? [...draft.deviceSns, device.sn]
                                    : draft.deviceSns.filter((sn) => sn !== device.sn),
                                })
                              }
                            />
                            <ColorDot color={device.color} />
                            <span className="min-w-0 flex-1 truncate">{deviceLabel(device)}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="m-0 mt-2 text-[11.5px] leading-[1.5] text-ink-3">
                    Tick specific drones to fence only those; leave “Every drone” for all of them.
                  </p>
                </fieldset>
              )}

              <label className="mt-4 flex cursor-pointer items-center gap-2 text-[12px] text-ink-2">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                Active (raise alerts for this {noFlyDraft ? 'zone' : 'geofence'})
              </label>

              <label className={`${fieldLabel} mt-3.5`} htmlFor="zone-notes">
                Notes
              </label>
              <input
                id="zone-notes"
                className={compactInput}
                maxLength={500}
                value={draft.notes}
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
              />

              {error && (
                <Notice tone="error" className="mt-3.5">
                  {error}
                </Notice>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  type="submit"
                  disabled={saving || mode !== 'idle'}
                  data-testid="save-zone"
                >
                  {saving ? 'Saving…' : 'Save zone'}
                </Button>
                <Button variant="secondary" type="button" disabled={saving} onClick={closeEditor}>
                  Cancel
                </Button>
                {draft.id && (
                  <Button
                    variant="secondary"
                    type="button"
                    className="ml-auto"
                    disabled={saving}
                    onClick={() => void remove()}
                    data-testid="delete-zone"
                  >
                    <Icon name="trash" />
                    Delete
                  </Button>
                )}
              </div>
            </form>
          ) : (
            <>
              <div className="flex-none border-b border-b-line p-3.5">
                <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
                  {(
                    [
                      ['all', `All ${zones.length}`],
                      ['no_fly', `No-fly ${noFlyCount}`],
                      ['geofence', `Geofences ${geofenceCount}`],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={segment(kindFilter === id)}
                      aria-pressed={kindFilter === id}
                      onClick={() => setKindFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <input
                  className={`${compactInput} mt-2.5`}
                  type="search"
                  value={query}
                  placeholder="Search zones"
                  aria-label="Search zones"
                  onChange={(event) => setQuery(event.target.value)}
                />
                {notice && (
                  <Notice tone="success" className="mt-2.5" onDismiss={() => setNotice('')}>
                    {notice}
                  </Notice>
                )}
              </div>
              <ul
                className="m-0 min-h-0 flex-1 list-none overflow-y-auto overscroll-contain p-2 [scrollbar-width:thin]"
                data-testid="zone-list"
              >
                {shown.length === 0 && (
                  <li className="px-3 py-8 text-center text-[12.5px] leading-[1.6] text-ink-3">
                    {zones.length === 0
                      ? canManage
                        ? 'No zones yet. Add a no-fly zone or a geofence above, then draw it on the map.'
                        : 'No zones have been drawn yet.'
                      : 'No zone matches.'}
                  </li>
                )}
                {shown.map((zone) => {
                  const active = zone.id === selectedId
                  return (
                    <li key={zone.id}>
                      <div
                        className={cn(
                          'rounded-md border px-2.5 py-2 transition-colors',
                          active
                            ? 'border-line-strong bg-pine-wash'
                            : 'border-transparent hover:bg-pine-wash',
                        )}
                        data-testid="zone-row"
                      >
                        <button
                          type="button"
                          className="flex w-full items-start gap-2.5 text-left"
                          aria-pressed={active}
                          onClick={() => {
                            setSelectedId(zone.id)
                            fitShape(zone.shape, zone.bufferM)
                          }}
                        >
                          <span
                            className={cn(
                              'mt-0.5 size-3 flex-none rounded-[3px] border',
                              zone.kind === 'no_fly'
                                ? 'border-zone-nofly bg-zone-nofly-soft'
                                : 'border-dashed border-zone-geofence bg-zone-geofence-soft',
                              !zone.enabled && 'opacity-45',
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px] font-medium leading-[1.35]">
                              {zone.name}
                            </span>
                            <span className="mt-0.5 block font-mono text-[9px] uppercase tracking-[0.05em] text-ink-3">
                              {zone.kind === 'no_fly'
                                ? `${categoryLabels[zone.category]} · warn ${metresLabel(zone.bufferM)}`
                                : zone.deviceSns.length === 0
                                  ? 'Geofence · every drone'
                                  : `Geofence · ${zone.deviceSns.length} drone${zone.deviceSns.length === 1 ? '' : 's'}`}
                              {!zone.enabled && ' · off'}
                            </span>
                          </span>
                        </button>
                        {active && (
                          <div className="mt-2 pl-[22px] text-[11.5px] leading-[1.55] text-ink-2">
                            {zone.notes && <p className="m-0 mb-1.5">{zone.notes}</p>}
                            {zone.source === 'builtin' && (
                              <p className={`${eyebrow} m-0 mb-1.5 normal-case tracking-normal`}>
                                Came with the app. Boundaries are approximate; check official
                                aviation notices before flying.
                              </p>
                            )}
                            {canManage && (
                              <Button
                                variant="secondary"
                                type="button"
                                onClick={() => openEditor(zone)}
                                data-testid="edit-zone"
                              >
                                <Icon name="edit" />
                                Edit
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </section>

        <div className="relative min-h-0 overflow-hidden bg-map-land until-drawer:order-1">
          <BaseMap onReady={onReady} onDispose={onDispose} testId="zones-map" />
          {mode !== 'idle' && (
            <div
              className="absolute left-1/2 top-3 z-[3] flex max-w-[calc(100%-90px)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-[12px] border border-line bg-surface-2 px-3 py-2 text-[12px] font-medium text-ink [box-shadow:var(--shadow-float)]"
              role="status"
              data-testid="draw-hint"
            >
              {mode === 'circle'
                ? 'Click the map to place the zone'
                : pending.length < 3
                  ? 'Click to add corners'
                  : 'Click the first point or press Enter to finish'}
              <button
                type="button"
                className="text-[11.5px] font-medium text-pine hover:underline"
                onClick={cancelDrawing}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
