/**
 * Plain geometry on the WGS-84 sphere, shared by the API (alerts) and the dashboard
 * (drawing). Zones are small next to the Earth, so distances use a local flat projection
 * around the point being tested; that is exact enough (centimetres at 50 km) and keeps the
 * code short and testable.
 */

/** `[longitude, latitude]`, the GeoJSON and MapLibre order. */
export type LngLat = [number, number]

export type ZoneShape =
  | { type: 'circle'; center: LngLat; radiusM: number }
  /** An open ring: the last vertex joins the first. At least three vertices. */
  | { type: 'polygon'; ring: LngLat[] }

const EARTH_RADIUS_M = 6_371_008.8
// One degree of arc on the sphere used by haversineM, so a circle (haversine) and a polygon
// (local projection) measure the same metres.
const M_PER_DEG_LAT = (EARTH_RADIUS_M * Math.PI) / 180
const M_PER_DEG_LON_EQUATOR = M_PER_DEG_LAT

export const MIN_CIRCLE_RADIUS_M = 5
export const MAX_CIRCLE_RADIUS_M = 200_000
export const MAX_RING_VERTICES = 500

const rad = (deg: number) => (deg * Math.PI) / 180

/** Great-circle distance in metres. */
export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1])
  const dLon = rad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Metres east and north of `origin`. */
function local(p: LngLat, origin: LngLat): [number, number] {
  return [
    (p[0] - origin[0]) * Math.cos(rad(origin[1])) * M_PER_DEG_LON_EQUATOR,
    (p[1] - origin[1]) * M_PER_DEG_LAT,
  ]
}

function fromLocal(xy: [number, number], origin: LngLat): LngLat {
  return [
    origin[0] + xy[0] / (Math.cos(rad(origin[1])) * M_PER_DEG_LON_EQUATOR),
    origin[1] + xy[1] / M_PER_DEG_LAT,
  ]
}

/** Ray casting in longitude/latitude; exact for any polygon that does not cross itself. */
export function pointInRing(p: LngLat, ring: LngLat[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    const crosses = yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    if (crosses) inside = !inside
  }
  return inside
}

function distanceToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSq = dx * dx + dy * dy
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Distance from `p` to the nearest edge of the ring, in metres (always positive). */
export function distanceToRingM(p: LngLat, ring: LngLat[]): number {
  const points = ring.map((vertex) => local(vertex, p))
  let best = Infinity
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length]!
    best = Math.min(best, distanceToSegment([0, 0], points[i]!, next))
  }
  return best
}

/**
 * Metres from `p` to the zone's boundary: positive outside, negative inside (how deep),
 * zero on the edge.
 */
export function signedDistanceM(shape: ZoneShape, p: LngLat): number {
  if (shape.type === 'circle') return haversineM(shape.center, p) - shape.radiusM
  const distance = distanceToRingM(p, shape.ring)
  return pointInRing(p, shape.ring) ? -distance : distance
}

/** `[west, south, east, north]` of the shape. */
export function shapeBounds(shape: ZoneShape): [number, number, number, number] {
  if (shape.type === 'circle') {
    const dLat = shape.radiusM / M_PER_DEG_LAT
    const dLon = shape.radiusM / (Math.cos(rad(shape.center[1])) * M_PER_DEG_LON_EQUATOR)
    return [
      shape.center[0] - dLon,
      shape.center[1] - dLat,
      shape.center[0] + dLon,
      shape.center[1] + dLat,
    ]
  }
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const [lon, lat] of shape.ring) {
    west = Math.min(west, lon)
    east = Math.max(east, lon)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  return [west, south, east, north]
}

/** Whether `p` can possibly be within `marginM` of the shape; a cheap pre-filter. */
export function nearBounds(shape: ZoneShape, p: LngLat, marginM: number): boolean {
  const [west, south, east, north] = shapeBounds(shape)
  const dLat = marginM / M_PER_DEG_LAT
  const dLon = marginM / (Math.cos(rad(p[1])) * M_PER_DEG_LON_EQUATOR)
  return p[0] >= west - dLon && p[0] <= east + dLon && p[1] >= south - dLat && p[1] <= north + dLat
}

/** A circle as a closed polygon ring, for drawing. */
export function circleRing(center: LngLat, radiusM: number, steps = 72): LngLat[] {
  const ring: LngLat[] = []
  for (let i = 0; i < steps; i += 1) {
    const angle = (2 * Math.PI * i) / steps
    ring.push(fromLocal([radiusM * Math.cos(angle), radiusM * Math.sin(angle)], center))
  }
  return ring
}

/** Signed area of the ring in square metres: positive when it runs counter-clockwise. */
export function ringAreaM2(ring: LngLat[]): number {
  if (ring.length < 3) return 0
  const origin = ring[0]!
  const points = ring.map((vertex) => local(vertex, origin))
  let sum = 0
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i]!
    const [x2, y2] = points[(i + 1) % points.length]!
    sum += x1 * y2 - x2 * y1
  }
  return sum / 2
}

/**
 * The ring pushed outward by `meters`, with mitred corners. It is only used to draw the
 * warning band: the alerts use the exact distance to the real boundary.
 */
export function offsetRing(ring: LngLat[], meters: number): LngLat[] {
  if (meters <= 0 || ring.length < 3) return ring
  const origin = ring[0]!
  let points = ring.map((vertex) => local(vertex, origin))
  const counterClockwise = ringAreaM2(ring) > 0
  if (!counterClockwise) points = [...points].reverse()

  const normals = points.map((a, i) => {
    const b = points[(i + 1) % points.length]!
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    // Outward is to the right of the direction of travel for a counter-clockwise ring.
    return [(b[1] - a[1]) / length, -(b[0] - a[0]) / length] as [number, number]
  })

  const out: [number, number][] = []
  for (let i = 0; i < points.length; i += 1) {
    const prev = normals[(i + points.length - 1) % points.length]!
    const next = normals[i]!
    const v = points[i]!
    const sx = prev[0] + next[0]
    const sy = prev[1] + next[1]
    const sum = Math.hypot(sx, sy)
    const cosHalf = sum / 2
    if (sum < 1e-9 || 1 / cosHalf > 3) {
      // A very sharp corner: cut it flat instead of sending a spike far out.
      out.push([v[0] + prev[0] * meters, v[1] + prev[1] * meters])
      out.push([v[0] + next[0] * meters, v[1] + next[1] * meters])
    } else {
      const scale = meters / cosHalf / sum
      out.push([v[0] + sx * scale, v[1] + sy * scale])
    }
  }
  return out.map((xy) => fromLocal(xy, origin))
}

/** The shape grown by `meters`, as a ring. */
export function bufferRing(shape: ZoneShape, meters: number): LngLat[] {
  return shape.type === 'circle'
    ? circleRing(shape.center, shape.radiusM + meters)
    : offsetRing(shape.ring, meters)
}

function segmentsCross(a: LngLat, b: LngLat, c: LngLat, d: LngLat): boolean {
  const orient = (p: LngLat, q: LngLat, r: LngLat) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  return o1 * o2 < 0 && o3 * o4 < 0
}

/** True when two non-adjacent edges of the ring cross, which makes inside/outside ambiguous. */
export function ringSelfIntersects(ring: LngLat[]): boolean {
  const n = ring.length
  for (let i = 0; i < n; i += 1) {
    const a = ring[i]!
    const b = ring[(i + 1) % n]!
    for (let j = i + 1; j < n; j += 1) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue
      if (segmentsCross(a, b, ring[j]!, ring[(j + 1) % n]!)) return true
    }
  }
  return false
}

/** A human-readable reason the shape cannot be saved, or null when it is fine. */
export function validateShape(shape: ZoneShape): string | null {
  const valid = ([lon, lat]: LngLat) =>
    Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90
  if (shape.type === 'circle') {
    if (!valid(shape.center)) return 'The centre is not a valid position.'
    if (!(shape.radiusM >= MIN_CIRCLE_RADIUS_M && shape.radiusM <= MAX_CIRCLE_RADIUS_M))
      return `The radius must be between ${MIN_CIRCLE_RADIUS_M} m and ${MAX_CIRCLE_RADIUS_M / 1000} km.`
    return null
  }
  if (shape.ring.length < 3) return 'A polygon needs at least three points.'
  if (shape.ring.length > MAX_RING_VERTICES)
    return `A polygon can have at most ${MAX_RING_VERTICES} points.`
  if (!shape.ring.every(valid)) return 'A point of the polygon is not a valid position.'
  if (ringSelfIntersects(shape.ring))
    return 'The polygon crosses itself; redraw it without crossing lines.'
  if (Math.abs(ringAreaM2(shape.ring)) < 25) return 'The polygon is too small or flat.'
  return null
}

/** Total length of a path, in metres. Points without a position are skipped. */
export function pathLengthM(points: { lat: number | null; lon: number | null }[]): number {
  let total = 0
  let previous: LngLat | null = null
  for (const point of points) {
    if (point.lat == null || point.lon == null) continue
    const current: LngLat = [point.lon, point.lat]
    if (previous) total += haversineM(previous, current)
    previous = current
  }
  return total
}
