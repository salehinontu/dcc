import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bufferRing,
  circleRing,
  haversineM,
  offsetRing,
  pathLengthM,
  pointInRing,
  ringAreaM2,
  ringSelfIntersects,
  signedDistanceM,
  summarizeTrack,
  thin,
  validateShape,
  zoneInputSchema,
  type LngLat,
  type ZoneShape,
} from '@dji/protocol'
import { geofencePhase, noFlyPhase } from '../src/geo/engine'

const origin: LngLat = [90.4, 23.8]
const M_PER_DEG = (6_371_008.8 * Math.PI) / 180
const M_PER_DEG_LON = M_PER_DEG * Math.cos((origin[1] * Math.PI) / 180)
/** A point `meters` north or east of the origin. */
const north = (m: number): LngLat => [origin[0], origin[1] + m / M_PER_DEG]
const east = (m: number): LngLat => [origin[0] + m / M_PER_DEG_LON, origin[1]]

const near = (actual: number, expected: number, tolerance: number) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not within ${tolerance} of ${expected}`,
  )

const square = (half: number): LngLat[] => [
  [origin[0] - half / M_PER_DEG_LON, origin[1] - half / M_PER_DEG],
  [origin[0] + half / M_PER_DEG_LON, origin[1] - half / M_PER_DEG],
  [origin[0] + half / M_PER_DEG_LON, origin[1] + half / M_PER_DEG],
  [origin[0] - half / M_PER_DEG_LON, origin[1] + half / M_PER_DEG],
]

test('haversine matches known distances', () => {
  near(haversineM([0, 0], [0, 1]), 111_195, 5)
  near(haversineM(origin, north(1000)), 1000, 2)
  assert.equal(haversineM(origin, origin), 0)
})

test('a circle reports metres to its edge, negative inside', () => {
  const circle: ZoneShape = { type: 'circle', center: origin, radiusM: 500 }
  near(signedDistanceM(circle, north(1500)), 1000, 3)
  near(signedDistanceM(circle, north(200)), -300, 3)
  near(signedDistanceM(circle, north(500)), 0, 3)
})

test('a polygon reports metres to its nearest edge, negative inside', () => {
  const polygon: ZoneShape = { type: 'polygon', ring: square(500) }
  assert.ok(pointInRing(origin, square(500)))
  near(signedDistanceM(polygon, origin), -500, 5)
  near(signedDistanceM(polygon, east(800)), 300, 5)
  // Off a corner the nearest point is the corner itself.
  const diagonal: LngLat = [origin[0] + 800 / M_PER_DEG_LON, origin[1] + 800 / M_PER_DEG]
  near(signedDistanceM(polygon, diagonal), Math.hypot(300, 300), 6)
})

test('rings: orientation, area and crossings', () => {
  const ring = square(100)
  near(Math.abs(ringAreaM2(ring)), 200 * 200, 200)
  assert.ok(ringAreaM2(ring) > 0 !== ringAreaM2([...ring].reverse()) > 0)
  const bowtie: LngLat[] = [ring[0]!, ring[2]!, ring[1]!, ring[3]!]
  assert.equal(ringSelfIntersects(bowtie), true)
  assert.equal(ringSelfIntersects(ring), false)
})

test('the drawn warning band grows a ring outward on both orientations', () => {
  const ring = square(500)
  for (const candidate of [ring, [...ring].reverse()]) {
    const grown = offsetRing(candidate, 200)
    assert.ok(Math.abs(ringAreaM2(grown)) > Math.abs(ringAreaM2(candidate)))
    // Every corner of the grown ring is about 200 * sqrt(2) from the original corner.
    const farthest = Math.max(
      ...grown.map((vertex) =>
        Math.abs(signedDistanceM({ type: 'polygon', ring: candidate }, vertex)),
      ),
    )
    near(farthest, 200 * Math.SQRT2, 15)
  }
  const circle: ZoneShape = { type: 'circle', center: origin, radiusM: 500 }
  const band = bufferRing(circle, 300)
  near(haversineM(origin, band[0]!), 800, 2)
  assert.equal(circleRing(origin, 100, 36).length, 36)
})

test('shapes are validated before they are stored', () => {
  assert.equal(validateShape({ type: 'circle', center: origin, radiusM: 500 }), null)
  assert.match(validateShape({ type: 'circle', center: origin, radiusM: 1 }) ?? '', /radius/)
  assert.match(validateShape({ type: 'circle', center: [200, 0], radiusM: 500 }) ?? '', /centre/)
  assert.match(validateShape({ type: 'polygon', ring: square(100).slice(0, 2) }) ?? '', /three/)
  const bowtie: LngLat[] = [square(100)[0]!, square(100)[2]!, square(100)[1]!, square(100)[3]!]
  assert.match(validateShape({ type: 'polygon', ring: bowtie }) ?? '', /crosses/)
  assert.equal(
    zoneInputSchema.safeParse({
      kind: 'no_fly',
      name: ' ',
      shape: { type: 'circle', center: origin, radiusM: 50 },
    }).success,
    false,
  )
})

test('no-fly phases: warning inside the buffer, breach inside the zone, with hysteresis', () => {
  assert.equal(noFlyPhase(5000, 1000, 'clear'), 'clear')
  assert.equal(noFlyPhase(900, 1000, 'clear'), 'warning')
  assert.equal(noFlyPhase(-20, 1000, 'warning'), 'breach')
  // Just outside the buffer: stays in warning until it is clearly out (5 % or 10 m).
  assert.equal(noFlyPhase(1030, 1000, 'warning'), 'warning')
  assert.equal(noFlyPhase(1100, 1000, 'warning'), 'clear')
  // Just outside the zone edge: still a breach until 10 m clear of it.
  assert.equal(noFlyPhase(5, 1000, 'breach'), 'breach')
  assert.equal(noFlyPhase(40, 1000, 'breach'), 'warning')
  // No buffer: only the zone itself matters.
  assert.equal(noFlyPhase(30, 0, 'clear'), 'clear')
})

test('geofence phases flip only once the aircraft is clearly across the line', () => {
  assert.equal(geofencePhase(-300, undefined), 'inside')
  assert.equal(geofencePhase(300, undefined), 'outside')
  assert.equal(geofencePhase(5, 'inside'), 'inside')
  assert.equal(geofencePhase(25, 'inside'), 'outside')
  assert.equal(geofencePhase(-5, 'outside'), 'outside')
  assert.equal(geofencePhase(-25, 'outside'), 'inside')
})

test('a recorded path is summarised: distance, height, speed, range, battery', () => {
  const t0 = 1_700_000_000_000
  const stats = summarizeTrack([
    { ts: t0, lat: origin[1], lon: origin[0], altRel: 0, speedH: 0, batteryPct: 100 },
    { ts: t0 + 10_000, lat: north(500)[1], lon: origin[0], altRel: 40, speedH: 8, batteryPct: 98 },
    {
      ts: t0 + 20_000,
      lat: north(500)[1],
      lon: east(500)[0],
      altRel: 60,
      speedH: 12,
      batteryPct: 96,
    },
    { ts: t0 + 30_000, lat: null, lon: null, altRel: 20, speedH: 4, batteryPct: 95 },
  ])
  assert.equal(stats.durationS, 30)
  near(stats.distanceM, 1000, 8)
  assert.equal(stats.maxAltM, 60)
  assert.equal(stats.maxSpeedMs, 12)
  near(stats.avgSpeedMs ?? 0, 6, 0.01)
  assert.equal(stats.minBatteryPct, 95)
  near(stats.maxRangeM, Math.hypot(500, 500), 8)
  assert.deepEqual(stats.start, { lat: origin[1], lon: origin[0] })
  // A teleporting GPS glitch adds nothing.
  const glitch = summarizeTrack([
    { ts: 0, lat: 23.8, lon: 90.4, altRel: 10, speedH: 1, batteryPct: 90 },
    { ts: 1000, lat: 24.8, lon: 90.4, altRel: 10, speedH: 1, batteryPct: 90 },
  ])
  assert.equal(glitch.distanceM, 0)
  near(
    pathLengthM([
      { lat: 23.8, lon: 90.4 },
      { lat: null, lon: null },
      { lat: 23.8, lon: 90.401 },
    ]),
    102,
    3,
  )
})

test('thinning keeps the ends', () => {
  const items = Array.from({ length: 1000 }, (_, i) => i)
  const thinned = thin(items, 100)
  assert.equal(thinned.length, 100)
  assert.equal(thinned[0], 0)
  assert.equal(thinned[99], 999)
  assert.deepEqual(thin([1, 2, 3], 100), [1, 2, 3])
})
