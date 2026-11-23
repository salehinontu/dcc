import { stat } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import type { InferenceSession } from 'onnxruntime-node'
import sharp from 'sharp'
import type { PeopleDetection } from '@dji/protocol'

type Runtime = typeof import('onnxruntime-node')

// ONNX Runtime is a native addon with no build for some platforms (musl/Alpine among them).
// Loading it lazily keeps the API up there; people counting then reports itself unavailable.
let runtime: Promise<Runtime | null> | null = null
function loadRuntime(): Promise<Runtime | null> {
  runtime ??= import('onnxruntime-node')
    // Its ESM build has named exports; older CommonJS builds only a default.
    .then((module) =>
      'InferenceSession' in module ? module : (module as unknown as { default: Runtime }).default,
    )
    .catch((error: unknown) => {
      console.warn(
        `[people] ONNX Runtime unavailable: ${error instanceof Error ? error.message : error}`,
      )
      return null
    })
  return runtime
}

/**
 * Person detection with YOLOX (Apache-2.0, COCO-trained) for stills taken from a drone feed.
 *
 * Aerial people are often 20-60 pixels tall, far below what one 640 px pass over the whole
 * frame can see, so the frame is also cut into overlapping tiles (the SAHI approach) at two
 * scales: native-size tiles, and half-size tiles scaled up 2x for the smallest figures. Each
 * pass keeps only the person sizes it sees reliably: the whole frame keeps people big enough
 * to survive its downscale, the 2x tiles keep only small people (larger ones would arrive cut
 * up), and every tile drops people cut by its inner edges. What remains is merged so that a
 * person found by several passes is counted once.
 *
 * The count is an estimate. Confident detections are counted; weaker ones are only offered as
 * possible people. The operator confirms the result by accepting, removing or adding marks in
 * the viewer, and only that verified count is presented as final.
 */

const INPUT = 640
const STRIDES = [8, 16, 32] as const
const PERSON_CLASS = 0
const PAD_VALUE = 114
const TILE_OVERLAP = 0.25
// Tile edges in source pixels: native resolution, and 2x upscale for the smallest people.
const COARSE_TILE = 640
const FINE_TILE = 320
// The 2x pass is skipped above this short side; people in such frames are big enough already.
const FINE_MAX_SHORT_SIDE = 1440
// Person heights, in model-input pixels, each pass is trusted with.
const FULL_MIN_HEIGHT = 24
const TILE_MIN_HEIGHT = 12
const FINE_MAX_HEIGHT = 128
// Two boxes are one person when they overlap this much (IoU), or when the smaller one lies
// almost entirely inside the larger.
const MERGE_IOU = 0.5
const MERGE_IOS = 0.85
// A tile box this close to an inner tile edge (fraction of the tile) shows a person the edge
// cut through. Anyone small enough to fit in the overlap is whole in a neighbouring tile, and
// anyone larger is found by the whole-frame pass, so cut boxes are dropped.
const EDGE_MARGIN = 0.015

export interface Region {
  left: number
  top: number
  width: number
  height: number
  /** Person heights, in model-input pixels, this pass keeps. */
  minHeight: number
  maxHeight: number
}

/** A box in source-image pixels: top-left corner, size and confidence. */
export interface PixelBox {
  x: number
  y: number
  w: number
  h: number
  score: number
}

export interface DetectionResult {
  model: string
  width: number
  height: number
  passes: number
  durationMs: number
  detections: PeopleDetection[]
}

/** Start offsets along one axis so that tiles of `size` cover `length` with the overlap. */
function offsets(length: number, size: number): number[] {
  if (length <= size) return [0]
  const stride = Math.max(1, Math.floor(size * (1 - TILE_OVERLAP)))
  const starts: number[] = []
  for (let start = 0; start + size < length; start += stride) starts.push(start)
  starts.push(length - size)
  return starts
}

function tiles(
  width: number,
  height: number,
  size: number,
  minHeight: number,
  maxHeight: number,
): Region[] {
  const tileW = Math.min(size, width)
  const tileH = Math.min(size, height)
  const regions: Region[] = []
  for (const top of offsets(height, tileH)) {
    for (const left of offsets(width, tileW)) {
      regions.push({ left, top, width: tileW, height: tileH, minHeight, maxHeight })
    }
  }
  return regions
}

/**
 * The whole frame, then native tiles when the frame is large, then upscaled tiles of
 * `fineTile` source pixels (smaller tiles find smaller people and cost more passes).
 */
export function planRegions(width: number, height: number, fineTile = FINE_TILE): Region[] {
  const regions: Region[] = [
    { left: 0, top: 0, width, height, minHeight: FULL_MIN_HEIGHT, maxHeight: Infinity },
  ]
  if (Math.max(width, height) > COARSE_TILE * 1.25) {
    regions.push(...tiles(width, height, COARSE_TILE, TILE_MIN_HEIGHT, Infinity))
  }
  if (Math.min(width, height) <= FINE_MAX_SHORT_SIDE && Math.max(width, height) > fineTile) {
    regions.push(...tiles(width, height, fineTile, TILE_MIN_HEIGHT, FINE_MAX_HEIGHT))
  }
  return regions
}

/** YOLOX letterbox scale: the region is resized to fit the input and padded at the far edges. */
export function letterboxScale(region: Region): number {
  return Math.min(INPUT / region.width, INPUT / region.height)
}

/**
 * Decode raw YOLOX output rows ([cx, cy, w, h, objectness, 80 class scores] per anchor, with
 * grid offsets and log sizes still applied) into person boxes in source-image pixels.
 */
export function decodePersons(
  output: Float32Array,
  rowSize: number,
  region: Region,
  minScore: number,
): PixelBox[] {
  const scale = letterboxScale(region)
  const boxes: PixelBox[] = []
  let row = 0
  for (const stride of STRIDES) {
    const cells = INPUT / stride
    for (let gy = 0; gy < cells; gy += 1) {
      for (let gx = 0; gx < cells; gx += 1, row += 1) {
        const base = row * rowSize
        const score = (output[base + 4] ?? 0) * (output[base + 5 + PERSON_CLASS] ?? 0)
        if (score < minScore) continue
        const cx = ((output[base] ?? 0) + gx) * stride
        const cy = ((output[base + 1] ?? 0) + gy) * stride
        const w = Math.exp(output[base + 2] ?? 0) * stride
        const h = Math.exp(output[base + 3] ?? 0) * stride
        if (h < region.minHeight || h > region.maxHeight) continue
        // Anchors centred in the padding see nothing of the region.
        if (cx / scale > region.width || cy / scale > region.height) continue
        boxes.push({
          x: region.left + (cx - w / 2) / scale,
          y: region.top + (cy - h / 2) / scale,
          w: w / scale,
          h: h / scale,
          score,
        })
      }
    }
  }
  return boxes
}

/**
 * Drop boxes cut by an edge of the tile that lies inside the frame. Edges on the frame border
 * are kept: there is no neighbouring tile beyond them.
 */
export function dropCut(
  boxes: PixelBox[],
  region: Region,
  frameWidth: number,
  frameHeight: number,
): PixelBox[] {
  const marginX = Math.max(2, region.width * EDGE_MARGIN)
  const marginY = Math.max(2, region.height * EDGE_MARGIN)
  const right = region.left + region.width
  const bottom = region.top + region.height
  return boxes.filter(
    (box) =>
      !(region.left > 0 && box.x <= region.left + marginX) &&
      !(region.top > 0 && box.y <= region.top + marginY) &&
      !(right < frameWidth && box.x + box.w >= right - marginX) &&
      !(bottom < frameHeight && box.y + box.h >= bottom - marginY),
  )
}

function overlap(a: PixelBox, b: PixelBox): { iou: number; ios: number } {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  if (inter === 0) return { iou: 0, ios: 0 }
  const areaA = a.w * a.h
  const areaB = b.w * b.h
  return { iou: inter / (areaA + areaB - inter), ios: inter / Math.min(areaA, areaB) }
}

/** Greedy merge, highest score first: a box that duplicates a kept one is dropped. */
export function mergeBoxes(boxes: PixelBox[]): PixelBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score)
  const kept: PixelBox[] = []
  for (const box of sorted) {
    const duplicate = kept.some((other) => {
      const { iou, ios } = overlap(box, other)
      return iou > MERGE_IOU || ios > MERGE_IOS
    })
    if (!duplicate) kept.push(box)
  }
  return kept
}

/**
 * Clamp to the frame and express as fractions of it, which is how the web places marks. Boxes
 * at or above `countScore` are counted; the rest are offered to the operator as possible people.
 */
export function normalise(
  boxes: PixelBox[],
  width: number,
  height: number,
  countScore: number,
): PeopleDetection[] {
  const round = (value: number, places: number) => Number(value.toFixed(places))
  return boxes.map((box) => {
    const x = Math.max(0, box.x)
    const y = Math.max(0, box.y)
    const w = Math.min(width, box.x + box.w) - x
    const h = Math.min(height, box.y + box.h) - y
    return {
      x: round(x / width, 5),
      y: round(y / height, 5),
      w: round(Math.max(0, w) / width, 5),
      h: round(Math.max(0, h) / height, 5),
      score: round(box.score, 3),
      counted: box.score >= countScore,
    }
  })
}

/**
 * Inference is CPU-bound and the API is one process, so model runs go through one lock, one
 * pass at a time. Fast jobs (priority 0) are served before slow ones (priority 1), which means
 * a quick count never waits behind more than the pass that is already running.
 */
export class PassLock {
  private busy = false
  private readonly waiting: [Array<() => void>, Array<() => void>] = [[], []]

  async run<T>(priority: 0 | 1, task: () => Promise<T>): Promise<T> {
    if (this.busy) {
      await new Promise<void>((resolve) => this.waiting[priority].push(resolve))
    } else {
      this.busy = true
    }
    try {
      return await task()
    } finally {
      const next = this.waiting[0].shift() ?? this.waiting[1].shift()
      if (next) next()
      else this.busy = false
    }
  }
}
const passLock = new PassLock()

export interface DetectorOptions {
  modelPath: string
  /** The floor for offering a possible person. */
  minScore: number
  /** The confidence at which a detection is counted without the operator's say. */
  countScore: number
  /** Source-pixel size of the upscaled tiles. Larger is faster and sees smaller people less. */
  fineTile?: number
  /** 0 runs before 1 when both are waiting. */
  priority?: 0 | 1
  /** ONNX Runtime threads for this model. */
  threads?: number
}

export class PeopleDetector {
  private session: Promise<InferenceSession> | null = null
  private readonly modelPath: string
  private readonly minScore: number
  private readonly countScore: number
  private readonly fineTile: number
  private readonly priority: 0 | 1
  private readonly threads: number

  constructor(options: DetectorOptions) {
    this.modelPath = options.modelPath
    this.minScore = options.minScore
    this.countScore = options.countScore
    this.fineTile = options.fineTile ?? FINE_TILE
    this.priority = options.priority ?? 1
    this.threads = Math.max(1, options.threads ?? availableParallelism())
  }

  get modelName(): string {
    return (
      this.modelPath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.onnx$/, '') ?? 'model'
    )
  }

  /** Load the model and run one blank pass, so the first real count does not pay for it. */
  async warm(): Promise<void> {
    const ort = await loadRuntime()
    if (!ort || !(await this.available())) return
    const session = await this.load(ort)
    const input = session.inputNames[0] ?? 'images'
    await passLock.run(this.priority, () =>
      session.run({
        [input]: new ort.Tensor('float32', new Float32Array(3 * INPUT * INPUT), [
          1,
          3,
          INPUT,
          INPUT,
        ]),
      }),
    )
  }

  /** The model file is installed and the runtime loads on this platform. */
  async available(): Promise<boolean> {
    const info = await stat(this.modelPath).catch(() => null)
    return Boolean(info?.isFile()) && (await loadRuntime()) !== null
  }

  private load(ort: Runtime): Promise<InferenceSession> {
    const session =
      this.session ??
      ort.InferenceSession.create(this.modelPath, {
        graphOptimizationLevel: 'all',
        intraOpNumThreads: this.threads,
      }).catch((error: unknown) => {
        this.session = null
        throw error
      })
    this.session = session
    return session
  }

  detect(image: Buffer): Promise<DetectionResult> {
    return this.detectNow(image)
  }

  private async detectNow(image: Buffer): Promise<DetectionResult> {
    const started = Date.now()
    const ort = await loadRuntime()
    if (!ort) throw new Error('ONNX Runtime is not available on this platform')
    const session = await this.load(ort)
    const inputName = session.inputNames[0] ?? 'images'
    const outputName = session.outputNames[0] ?? 'output'

    // Decode once (EXIF orientation applied, alpha dropped); every pass crops this buffer.
    const { data: rgb, info } = await sharp(image)
      .rotate()
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const width = info.width
    const height = info.height
    const regions = planRegions(width, height, this.fineTile)

    const found: PixelBox[] = []
    const tensor = new Float32Array(3 * INPUT * INPUT)
    const plane = INPUT * INPUT
    for (const region of regions) {
      const scale = letterboxScale(region)
      const w = Math.max(1, Math.round(region.width * scale))
      const h = Math.max(1, Math.round(region.height * scale))
      const pixels = await sharp(rgb, { raw: { width, height, channels: 3 } })
        .extract(region)
        .resize(w, h, { fit: 'fill', kernel: 'cubic' })
        .raw()
        .toBuffer()

      // YOLOX takes BGR, 0-255, CHW, with the letterbox padding at 114.
      tensor.fill(PAD_VALUE)
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const source = (y * w + x) * 3
          const target = y * INPUT + x
          tensor[target] = pixels[source + 2] ?? PAD_VALUE
          tensor[plane + target] = pixels[source + 1] ?? PAD_VALUE
          tensor[2 * plane + target] = pixels[source] ?? PAD_VALUE
        }
      }

      const outputs = await passLock.run(this.priority, () =>
        session.run({ [inputName]: new ort.Tensor('float32', tensor, [1, 3, INPUT, INPUT]) }),
      )
      const output = outputs[outputName]
      if (!output) throw new Error('the model returned no output')
      const rowSize = output.dims[2] ?? 85
      const boxes = decodePersons(output.data as Float32Array, rowSize, region, this.minScore)
      found.push(...dropCut(boxes, region, width, height))
    }

    const merged = mergeBoxes(found)
    return {
      model: this.modelName,
      width,
      height,
      passes: regions.length,
      durationMs: Date.now() - started,
      detections: normalise(merged, width, height, this.countScore),
    }
  }
}
