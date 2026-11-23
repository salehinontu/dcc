import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import {
  bufferRing,
  circleRing,
  type LngLat,
  type Zone,
  type ZoneCategory,
  type ZoneShape,
} from '@dji/protocol'

/**
 * Drawing zones on a MapLibre map: a translucent red area for a no-fly zone with a dashed
 * band for its warning distance, and a blue dashed outline for a geofence. The same layers
 * serve the operations map, the zone editor and a flight's replay.
 */

export const categoryLabels: Record<ZoneCategory, string> = {
  airport: 'Airport',
  military: 'Military area',
  government: 'Government site',
  critical: 'Critical infrastructure',
  border: 'Border area',
  custom: 'Custom',
}

/** Human distance for a warning band or a radius. */
export function metresLabel(metres: number): string {
  if (metres >= 10_000) return `${Math.round(metres / 1000)} km`
  if (metres >= 1000) return `${Math.round(metres / 100) / 10} km`
  return `${Math.round(metres)} m`
}

const SHAPES = 'zone-shapes'
const BUFFERS = 'zone-buffers'

type Feature = {
  type: 'Feature'
  properties: Record<string, unknown>
  geometry: { type: 'Polygon'; coordinates: LngLat[][] }
}
type Collection = { type: 'FeatureCollection'; features: Feature[] }

const empty = (): Collection => ({ type: 'FeatureCollection', features: [] })

export function zoneColors(): { noFly: string; geofence: string; muted: string; focus: string } {
  const css = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    noFly: read('--zone-nofly', '#d92d3a'),
    geofence: read('--zone-geofence', '#1d6fd6'),
    muted: read('--ink-3', '#627189'),
    focus: read('--gold', '#f2b900'),
  }
}

/** The ring of a shape, closed for GeoJSON. */
export function closedRing(shape: ZoneShape): LngLat[] {
  const ring = shape.type === 'circle' ? circleRing(shape.center, shape.radiusM) : shape.ring
  return [...ring, ring[0]!]
}

function polygon(ring: LngLat[], properties: Record<string, unknown>): Feature {
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] },
  }
}

export function zoneCollections(
  zones: Zone[],
  options: { showNoFly?: boolean; showGeofences?: boolean; hideId?: string | null } = {},
): { shapes: Collection; buffers: Collection } {
  const { showNoFly = true, showGeofences = true, hideId = null } = options
  const shapes = empty()
  const buffers = empty()
  for (const zone of zones) {
    if (zone.id === hideId) continue
    if (zone.kind === 'no_fly' ? !showNoFly : !showGeofences) continue
    const properties = {
      id: zone.id,
      name: zone.name,
      kind: zone.kind,
      category: zone.category,
      enabled: zone.enabled,
      bufferM: zone.bufferM,
    }
    const ring =
      zone.shape.type === 'circle'
        ? circleRing(zone.shape.center, zone.shape.radiusM)
        : zone.shape.ring
    shapes.features.push(polygon(ring, properties))
    if (zone.kind === 'no_fly' && zone.bufferM > 0) {
      buffers.features.push(polygon(bufferRing(zone.shape, zone.bufferM), properties))
    }
  }
  return { shapes, buffers }
}

/** Add the zone sources and layers once the style is loaded. Safe to call twice. */
export function addZoneLayers(map: MapLibreMap): void {
  if (map.getSource(SHAPES)) return
  const colors = zoneColors()
  map.addSource(BUFFERS, { type: 'geojson', data: empty() as never })
  map.addSource(SHAPES, { type: 'geojson', data: empty() as never })

  map.addLayer({
    id: 'zone-buffer-fill',
    type: 'fill',
    source: BUFFERS,
    paint: {
      'fill-color': colors.noFly,
      'fill-opacity': ['case', ['get', 'enabled'], 0.06, 0.02],
    },
  })
  map.addLayer({
    id: 'zone-buffer-line',
    type: 'line',
    source: BUFFERS,
    paint: {
      'line-color': colors.noFly,
      'line-width': 1.2,
      'line-opacity': ['case', ['get', 'enabled'], 0.75, 0.3],
      'line-dasharray': [3, 2.5],
    },
  })
  map.addLayer({
    id: 'zone-fill',
    type: 'fill',
    source: SHAPES,
    paint: {
      'fill-color': ['match', ['get', 'kind'], 'geofence', colors.geofence, colors.noFly],
      'fill-opacity': [
        'case',
        ['!', ['get', 'enabled']],
        0.05,
        ['==', ['get', 'kind'], 'geofence'],
        0.05,
        0.24,
      ],
    },
  })
  map.addLayer({
    id: 'zone-line',
    type: 'line',
    source: SHAPES,
    layout: { 'line-join': 'round' },
    paint: {
      'line-color': ['match', ['get', 'kind'], 'geofence', colors.geofence, colors.noFly],
      'line-width': 2,
      'line-opacity': ['case', ['get', 'enabled'], 0.95, 0.4],
    },
  })
}

export function setZoneData(
  map: MapLibreMap,
  zones: Zone[],
  options?: Parameters<typeof zoneCollections>[1],
): void {
  const shapes = map.getSource(SHAPES) as GeoJSONSource | undefined
  const buffers = map.getSource(BUFFERS) as GeoJSONSource | undefined
  if (!shapes || !buffers) return
  const next = zoneCollections(zones, options)
  shapes.setData(next.shapes as never)
  buffers.setData(next.buffers as never)
}

/** The id of the zone drawn at a map point (topmost first), if any. */
export function zoneAt(map: MapLibreMap, point: { x: number; y: number }): string | null {
  if (!map.getLayer('zone-fill')) return null
  const hits = map.queryRenderedFeatures([point.x, point.y], { layers: ['zone-fill'] })
  const id = hits[0]?.properties?.id
  return typeof id === 'string' ? id : null
}
