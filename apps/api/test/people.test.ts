import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodePersons,
  dropCut,
  mergeBoxes,
  normalise,
  PassLock,
  planRegions,
  type PixelBox,
  type Region,
} from '../src/people/detector'

const ROW = 85
const ANCHORS = 80 * 80 + 40 * 40 + 20 * 20

function covers(regions: Region[], width: number, height: number): boolean {
  for (let y = 0; y < height; y += 7) {
    for (let x = 0; x < width; x += 7) {
      const inside = regions.some(
        (r) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height,
      )
      if (!inside) return false
    }
  }
  return true
}

test('a 1080p frame gets a whole-frame pass, native tiles and 2x tiles that cover it', () => {
  const regions = planRegions(1920, 1080)
  assert.deepEqual(regions[0], {
    left: 0,
    top: 0,
    width: 1920,
    height: 1080,
    minHeight: 24,
    maxHeight: Infinity,
  })
  const coarse = regions.filter((r) => r.width === 640)
  const fine = regions.filter((r) => r.width === 320)
  assert.ok(coarse.length > 0 && covers(coarse, 1920, 1080))
  assert.ok(fine.length > 0 && covers(fine, 1920, 1080))
  assert.ok(fine.every((r) => r.maxHeight === 128))
  for (const r of regions) {
    assert.ok(r.left >= 0 && r.top >= 0 && r.left + r.width <= 1920 && r.top + r.height <= 1080)
  }
})

test('a 4K frame skips the 2x pass and a small frame skips the native tiles', () => {
  assert.ok(planRegions(3840, 2160).every((r) => r.width !== 320))
  const small = planRegions(640, 360)
  assert.ok(small.every((r) => r.width !== 640 || r.height === 360))
  assert.ok(small.some((r) => r.width === 320))
})

function rows(set: (row: number, values: number[]) => void): Float32Array {
  const output = new Float32Array(ANCHORS * ROW)
  set(0, [])
  return output.map((_, index) => {
    const row = Math.floor(index / ROW)
    const column = index % ROW
    const values: number[] = []
    set(row, values)
    return values[column] ?? 0
  })
}

test('raw YOLOX rows decode to person boxes in source pixels', () => {
  // Anchor (gx=10, gy=20) of stride 8: centre (10.5 * 8, 20.5 * 8) = (84, 164), size 64 x 128.
  const target = 20 * 80 + 10
  const output = rows((row, values) => {
    if (row === target) values.push(0.5, 0.5, Math.log(8), Math.log(16), 0.9, 0.8)
    if (row === target + 1) values.push(0.5, 0.5, Math.log(8), Math.log(16), 0.9, 0.1, 0.9) // a bicycle
  })
  const region: Region = {
    left: 100,
    top: 50,
    width: 320,
    height: 320,
    minHeight: 0,
    maxHeight: Infinity,
  }
  const [box, ...rest] = decodePersons(output, ROW, region, 0.3)
  assert.equal(rest.length, 0)
  // The 320 px tile is scaled 2x into the input, so source sizes are halved.
  assert.ok(box)
  assert.ok(Math.abs(box.score - 0.72) < 1e-6)
  assert.ok(Math.abs(box.x - (100 + (84 - 32) / 2)) < 1e-4)
  assert.ok(Math.abs(box.y - (50 + (164 - 64) / 2)) < 1e-4)
  assert.ok(Math.abs(box.w - 32) < 1e-4 && Math.abs(box.h - 64) < 1e-4)
})

test('a pass keeps only the person heights it is trusted with', () => {
  // A box 120 input pixels tall.
  const target = 20 * 80 + 10
  const output = rows((row, values) => {
    if (row === target) values.push(0.5, 0.5, Math.log(8), Math.log(15), 0.9, 0.9)
  })
  const region = (minHeight: number, maxHeight: number): Region => ({
    left: 0,
    top: 0,
    width: 640,
    height: 640,
    minHeight,
    maxHeight,
  })
  assert.equal(decodePersons(output, ROW, region(0, 100), 0.3).length, 0)
  assert.equal(decodePersons(output, ROW, region(130, Infinity), 0.3).length, 0)
  assert.equal(decodePersons(output, ROW, region(12, 128), 0.3).length, 1)
})

test('boxes cut by an inner tile edge are dropped, boxes on the frame border are kept', () => {
  const region: Region = {
    left: 400,
    top: 0,
    width: 320,
    height: 320,
    minHeight: 0,
    maxHeight: Infinity,
  }
  const box = (x: number, y: number): PixelBox => ({ x, y, w: 20, h: 40, score: 0.9 })
  const kept = dropCut(
    [box(400, 100), box(700, 100), box(500, 0), box(500, 280), box(500, 100)],
    region,
    1920,
    1080,
  )
  // Left and right edges are inside the frame; the top edge is the frame border.
  assert.deepEqual(
    kept.map((b) => [b.x, b.y]),
    [
      [500, 0],
      [500, 100],
    ],
  )
})

test('duplicates and partial views merge, neighbours stay separate', () => {
  const merged = mergeBoxes([
    { x: 100, y: 100, w: 40, h: 80, score: 0.9 },
    { x: 102, y: 101, w: 40, h: 80, score: 0.8 }, // the same person from another pass
    { x: 105, y: 105, w: 20, h: 30, score: 0.95 }, // a head-and-shoulders view inside it
    { x: 150, y: 100, w: 40, h: 80, score: 0.85 }, // a neighbour
  ])
  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map((b) => b.score).sort(), [0.85, 0.95])
})

test('normalised detections are clamped fractions with a counted flag', () => {
  const [inside, edge] = normalise(
    [
      { x: 192, y: 108, w: 96, h: 108, score: 0.45 },
      { x: -10, y: 1000, w: 30, h: 200, score: 0.25 },
    ],
    1920,
    1080,
    0.3,
  )
  assert.deepEqual(inside, { x: 0.1, y: 0.1, w: 0.05, h: 0.1, score: 0.45, counted: true })
  assert.deepEqual(edge, { x: 0, y: 0.92593, w: 0.01042, h: 0.07407, score: 0.25, counted: false })
})

test('larger fine tiles mean fewer passes, which is what the quick stage trades for speed', () => {
  assert.equal(planRegions(1920, 1080).length, 49)
  assert.equal(planRegions(1920, 1080, 448).length, 27)
  const quick = planRegions(1920, 1080, 448).filter((r) => r.width === 448)
  assert.ok(covers(quick, 1920, 1080))
})

test('the pass lock serves fast jobs before slow ones that are already waiting', async () => {
  const lock = new PassLock()
  const order: string[] = []
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const running = lock.run(1, async () => {
    order.push('running')
    await gate
  })
  const slow = lock.run(1, async () => void order.push('slow'))
  const fast = lock.run(0, async () => void order.push('fast'))
  release()
  await Promise.all([running, slow, fast])
  assert.deepEqual(order, ['running', 'fast', 'slow'])
})
