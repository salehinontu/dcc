import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

/**
 * Gallery thumbnails. A still straight from the drone's picture is 1-8 MB; a gallery of 48 of them is hundreds of
 * megabytes to a browser, and on a long, lossy link that is minutes. So each still gets a small JPEG (about 30-60 kB)
 * that the gallery shows; the full picture is fetched only when someone opens it.
 *
 * A thumbnail is made once, the first time it is asked for (or right after a capture), and kept on disk beside the
 * stills in `.thumbs/<id>.jpg`. It is cheap to lose: asking again makes it again.
 */
export const THUMB_WIDTH = 640
const QUALITY = 72
/** A thumbnail is made by libvips, which already uses several threads: two at a time keeps a small server usable. */
const MAX_AT_ONCE = 2

let running = 0
const waiting: Array<() => void> = []
const inflight = new Map<string, Promise<boolean>>()

async function slot<T>(job: () => Promise<T>): Promise<T> {
  if (running >= MAX_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve))
  running += 1
  try {
    return await job()
  } finally {
    running -= 1
    waiting.shift()?.()
  }
}

/** Where a still's thumbnail lives. The name is the still's id, so it can never leave the folder. */
export function thumbPath(root: string, id: string): string {
  return path.join(path.resolve(root), '.thumbs', `${id}.jpg`)
}

async function exists(file: string): Promise<boolean> {
  const info = await stat(file).catch(() => null)
  return Boolean(info?.isFile() && info.size > 0)
}

async function make(source: string, target: string): Promise<boolean> {
  const part = `${target}.${process.pid}.${Date.now().toString(36)}.part`
  try {
    await mkdir(path.dirname(target), { recursive: true })
    await sharp(source, { failOn: 'none' })
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      // A PNG may be transparent; a JPEG cannot be.
      .flatten({ background: '#000000' })
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .toFile(part)
    // Written whole, then put in place: nobody ever reads half a thumbnail.
    await rename(part, target)
    return true
  } catch {
    await rm(part, { force: true }).catch(() => undefined)
    return false
  }
}

/** Makes the thumbnail unless it is already there. False when the picture cannot be read (a damaged or missing file). */
export async function ensureThumb(source: string, target: string): Promise<boolean> {
  if (await exists(target)) return true
  let job = inflight.get(target)
  if (!job) {
    job = slot(() => make(source, target)).finally(() => inflight.delete(target))
    inflight.set(target, job)
  }
  return job
}
