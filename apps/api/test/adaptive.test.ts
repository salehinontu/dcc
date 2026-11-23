import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AdaptiveQuality, suggestedQuality } from '../src/streams/adaptive'

const healthy = { concurrentStreams: 1, loss: 0, stalled: false }
const stalled = { ...healthy, stalled: true }

test('only an explicit slow link sizes the wall; loss and stalls lower one level', () => {
  assert.equal(suggestedQuality(3, 3, { ...healthy, downlinkMbps: 1 }), 1)
  assert.equal(suggestedQuality(3, 3, { ...healthy, downlinkMbps: 0.5, concurrentStreams: 2 }), 1)
  // The browser's own estimate (often 1.5–3 Mbps on a fine link) no longer caps quality.
  assert.equal(suggestedQuality(3, 3, { ...healthy, downlinkMbps: 2.5, concurrentStreams: 2 }), 3)
  assert.equal(suggestedQuality(3, 3, { ...healthy, loss: 0.1 }), 2)
  assert.equal(suggestedQuality(2, 3, stalled), 1)
  assert.equal(suggestedQuality(1, 3, healthy), 3)
})

test('a publisher restart settles first, and one stall is a blip, not a reason to step down', () => {
  const adaptive = new AdaptiveQuality()
  adaptive.settle('s', 3, 0)
  // The controller is re-encoding: stalls in the settle window are not counted.
  assert.equal(adaptive.report('s', 'v', 3, stalled, 10_000), null)
  assert.equal(adaptive.report('s', 'v', 3, stalled, 20_000), null)
  // After it, one bad report is not enough; two in a row are.
  assert.equal(adaptive.report('s', 'v', 3, stalled, 31_000), null)
  assert.equal(adaptive.report('s', 'v', 3, stalled, 41_000), 2)
  // The change opens a new settle window.
  assert.equal(adaptive.report('s', 'v', 2, stalled, 51_000), null)
  assert.equal(adaptive.report('s', 'v', 2, stalled, 61_000), null)
  // A healthy report in between breaks the streak.
  assert.equal(adaptive.report('s', 'v', 2, stalled, 72_000), null)
  assert.equal(adaptive.report('s', 'v', 2, healthy, 82_000), null)
  assert.equal(adaptive.report('s', 'v', 2, stalled, 92_000), null)
  // Recovery waits two minutes after the change at 41 s, one level at a time.
  assert.equal(adaptive.report('s', 'v', 2, healthy, 150_000), null)
  assert.equal(adaptive.report('s', 'v', 2, healthy, 161_000), 3)
  // Another publisher restart is another settle window.
  adaptive.settle('s', 3, 200_000)
  assert.equal(adaptive.report('s', 'v', 3, stalled, 210_000), null)
  assert.equal(adaptive.report('s', 'v', 3, stalled, 220_000), null)
})

test('weakest viewer wins, an explicit slow link acts at once, reports expire, DJI auto is left alone', () => {
  const adaptive = new AdaptiveQuality()
  adaptive.reset('s', 3, 0)
  assert.equal(adaptive.report('s', 'weak', 3, { ...healthy, downlinkMbps: 0.5 }, 31_000), 1)
  assert.equal(adaptive.report('s', 'strong', 1, healthy, 70_000), null)
  // The weak viewer's last report expired at 61 s; two healthy minutes after the change it climbs.
  assert.equal(adaptive.report('s', 'strong', 1, healthy, 140_000), null)
  assert.equal(adaptive.report('s', 'strong', 1, healthy, 151_000), 2)
  assert.equal(adaptive.report('s', 'strong', 2, healthy, 200_000), null)
  assert.equal(adaptive.report('s', 'strong', 2, healthy, 271_000), 3)
  // An admin's choice is the ceiling.
  adaptive.reset('s', 2, 300_000)
  assert.equal(adaptive.report('s', 'strong', 2, healthy, 500_000), null)
  assert.equal(adaptive.report('s', 'strong', 0, stalled, 510_000), null)
  assert.equal(adaptive.report('s', 'strong', 0, stalled, 520_000), null)
})
