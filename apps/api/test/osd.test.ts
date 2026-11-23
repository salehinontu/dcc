import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toTelemetrySample } from '@dji/protocol'
import { isAirborne } from '../src/flights/tracker'
import { shouldStoreSample } from '../src/registry'

// Shapes taken from real captures of two Matrice aircraft (2026-10-30).
const standby = {
  latitude: 23.8103,
  longitude: 90.4125,
  height: -45.7,
  elevation: 0,
  horizontal_speed: 0,
  mode_code: 0,
  battery: { capacity_percent: 95 },
}

test('height above take-off comes from `elevation`, not the ellipsoid `height`', () => {
  const sample = toTelemetrySample('drone', standby, 1)
  assert.equal(sample.altRel, 0)
  assert.equal(sample.altAbs, -45.7)
  assert.equal(isAirborne(sample), false, 'a drone standing on the ground is not flying')

  // The ellipsoid height wanders by tens of metres on the ground (+27 m on 2026-10-29): it
  // used to read as "flying" and started flights that were then discarded.
  assert.equal(isAirborne(toTelemetrySample('drone', { ...standby, height: 27.4 }, 2)), false)

  const climbing = toTelemetrySample('drone', { ...standby, height: -20.7, elevation: 25 }, 3)
  assert.equal(climbing.altRel, 25)
  assert.equal(isAirborne(climbing), true)
})

test('flight time left is the aircraft’s own figure in seconds, and 0 on the ground means unknown', () => {
  // Captured in the air on 2026-11-03: 43 % and about 16 minutes left.
  const flying = toTelemetrySample(
    'drone',
    {
      ...standby,
      elevation: 3.4,
      mode_code: 15,
      battery: {
        capacity_percent: 43,
        remain_flight_time: 959,
        return_home_power: 14,
        landing_power: 7,
      },
    },
    1,
  )
  assert.equal(flying.remainFlightS, 959)
  assert.equal(flying.batteryPct, 43)

  // Landed: DJI reports 0, which is "not flying", not "no time left".
  const landed = { ...standby, battery: { capacity_percent: 43, remain_flight_time: 0 } }
  assert.equal(toTelemetrySample('drone', landed, 2).remainFlightS, null)

  // A model that sends none has none; the shape of `standby` carries no such field.
  assert.equal(toTelemetrySample('drone', standby, 3).remainFlightS, null)

  // Anything that is not a plausible figure is unknown, never a guess.
  for (const bad of ['soon', null, -5, 0.4, 86_401, Number.POSITIVE_INFINITY, Number.NaN]) {
    const sample = toTelemetrySample(
      'drone',
      { ...standby, battery: { capacity_percent: 43, remain_flight_time: bad } },
      4,
    )
    assert.equal(
      sample.remainFlightS,
      null,
      `remain_flight_time ${String(bad)} must read as unknown`,
    )
  }
  assert.equal(
    toTelemetrySample('drone', { battery: { remain_flight_time: 1234.6 } }, 5).remainFlightS,
    1235,
  )
})

test('an aircraft that does not report `elevation` has no relative height, never the wrong one', () => {
  const withoutElevation: Record<string, unknown> = { ...standby }
  delete withoutElevation.elevation
  const sample = toTelemetrySample('drone', withoutElevation, 1)
  assert.equal(sample.altRel, null)
  assert.equal(isAirborne(sample), false)
})

test('a drone left connected on the ground is stored sparsely, a flying one in full', () => {
  const idleMs = 30_000
  const at = (ts: number, altRel: number | null, speedH: number | null = 0) => ({
    ts,
    altRel,
    speedH,
  })

  // The first reading of a drone is always kept; the next ones on the ground wait for the interval.
  assert.equal(shouldStoreSample(at(0, 0), undefined, idleMs), true)
  assert.equal(shouldStoreSample(at(2_000, 0), 0, idleMs), false)
  assert.equal(shouldStoreSample(at(29_999, 0.4), 0, idleMs), false)
  assert.equal(shouldStoreSample(at(30_000, 0), 0, idleMs), true)

  // In the air, or moving, or not saying its height: kept in full, because flight replay needs them.
  assert.equal(shouldStoreSample(at(2_000, 12), 0, idleMs), true)
  assert.equal(shouldStoreSample(at(2_000, 0, 3.2), 0, idleMs), true, 'rolling on the ground')
  assert.equal(
    shouldStoreSample(at(2_000, null), 0, idleMs),
    true,
    'height unknown: never guess it is idle',
  )

  // A clock that went backwards (a controller reset) does not silence a drone.
  assert.equal(shouldStoreSample(at(1_000, 0), 90_000, idleMs), true)
})
