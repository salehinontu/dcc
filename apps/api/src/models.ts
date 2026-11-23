import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { config } from './config'

/**
 * Installs the people-counting models: `pnpm models:fetch`. Both are YOLOX from the official
 * YOLOX release (Apache-2.0): the small model answers in seconds, the large one refines the
 * count. The release publishes no checksums, so each hash is the one recorded when the model
 * was first adopted; a download that does not match is discarded.
 */
const RELEASE = 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0'
const MODELS = [
  {
    label: 'YOLOX-S (quick)',
    path: () => config.peopleQuickModelPath,
    url: `${RELEASE}/yolox_s.onnx`,
    bytes: 35_858_002,
    sha256: 'c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063',
  },
  {
    label: 'YOLOX-L (thorough)',
    path: () => config.peopleModelPath,
    url: `${RELEASE}/yolox_l.onnx`,
    bytes: 216_746_733,
    sha256: '7860ae79de6c89a3c1eb72ae9a2756c0ccfbe04b7791bb5880afabd97855a411',
  },
]

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

async function install(model: (typeof MODELS)[number]): Promise<void> {
  const target = path.resolve(model.path())
  const existing = await stat(target).catch(() => null)
  if (existing?.isFile() && existing.size === model.bytes) {
    console.log(`[models] ${model.label} present: ${target}`)
    return
  }

  await mkdir(path.dirname(target), { recursive: true })
  const partial = `${target}.part`
  console.log(
    `[models] downloading ${model.label} (${Math.round(model.bytes / 1e6)} MB) to ${target}`,
  )
  const response = await fetch(model.url)
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))

  const digest = await sha256(partial)
  if (digest !== model.sha256) {
    await rm(partial, { force: true })
    throw new Error(`${model.label}: checksum mismatch (got ${digest}); the file was discarded`)
  }
  await rename(partial, target)
  console.log(`[models] ${model.label} installed and verified`)
}

async function main(): Promise<void> {
  for (const model of MODELS) await install(model)
}

main().catch((error: unknown) => {
  console.error(`[models] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
