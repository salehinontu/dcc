import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, constants, mkdir, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FolderListing } from '@dji/protocol'

const SETTING_KEY = 'recordings.location'
/** Folders used before, remembered so the videos saved in them keep playing. */
const OLDER_MAX = 5
const LIST_MAX = 500
const FOLDER_NAME_MAX = 80

/** Nobody keeps videos in these; choosing one is almost certainly a slip. */
const SYSTEM_POSIX = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/proc',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/System',
  '/Library',
  '/Applications',
  '/private/etc',
]
const SYSTEM_WINDOWS = ['windows', 'program files', 'program files (x86)', 'programdata']

export type PlaceErrorCode =
  | 'relative'
  | 'root'
  | 'system'
  | 'not_found'
  | 'not_dir'
  | 'not_writable'
  | 'not_readable'
  | 'outside'
  | 'locked'
  | 'bad_name'

const MESSAGES: Record<PlaceErrorCode, string> = {
  relative: 'Give the full path of the folder, for example /srv/drone-fleet/videos or D:\\Videos.',
  root: 'That is the top of a disk. Choose a folder on it, or make a new one.',
  system: 'That is a system folder. Choose another one.',
  not_found: 'That folder does not exist.',
  not_dir: 'That is a file, not a folder.',
  not_writable: 'The server cannot write into that folder. Check who may write to it.',
  not_readable: 'The server cannot open that folder.',
  outside: 'Choose a folder inside one of the server’s storage areas.',
  locked:
    'This server was installed with a fixed videos folder (RECORDING_DIR_LOCKED), so it cannot be changed from the app.',
  bad_name: 'A folder name cannot be empty or contain / \\ : * ? " < > |',
}

export class PlaceError extends Error {
  constructor(
    readonly code: PlaceErrorCode,
    detail?: string,
  ) {
    super(detail ?? MESSAGES[code])
  }
}

/** A place the server may keep videos in: a folder, and the words an operator sees for it. */
export interface StorageRoot {
  path: string
  label: string
}

/**
 * Reads `RECORDING_ROOTS`: absolute folders separated by commas, each optionally followed by `=` and a label,
 * for example `/data/recordings=Default storage,/storage=Storage disk`. Anything that is not an absolute path
 * is left out.
 */
export function parseStorageRoots(text: string | undefined): StorageRoot[] {
  const roots: StorageRoot[] = []
  for (const part of (text ?? '').split(',')) {
    const item = part.trim()
    if (!item) continue
    const eq = item.indexOf('=')
    const raw = (eq >= 0 ? item.slice(0, eq) : item).trim()
    if (!path.isAbsolute(raw)) continue
    const resolved = path.resolve(raw)
    if (roots.some((root) => root.path === resolved)) continue
    const label = eq >= 0 ? item.slice(eq + 1).trim() : ''
    roots.push({ path: resolved, label: label || path.basename(resolved) || resolved })
  }
  return roots
}

interface Saved {
  dir?: unknown
  older?: unknown
}

export interface PlaceSettings {
  getSetting<T>(key: string): Promise<T | null>
  setSetting(key: string, value: unknown, by: string | null): Promise<void>
}

function isInside(child: string, parent: string): boolean {
  const a = process.platform === 'win32' ? child.toLowerCase() : child
  const b = process.platform === 'win32' ? parent.toLowerCase() : parent
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

function isSystemFolder(dir: string): boolean {
  if (process.platform === 'win32') {
    const { root } = path.parse(dir)
    return SYSTEM_WINDOWS.some((name) => isInside(dir, path.join(root, name)))
  }
  return SYSTEM_POSIX.some((system) => isInside(dir, system))
}

async function isDirectory(dir: string): Promise<boolean> {
  return stat(dir).then(
    (info) => info.isDirectory(),
    () => false,
  )
}

/**
 * The main folder the videos are kept in, and the folders used before it. The folder is chosen once at
 * install or later by a Developer, saved in the database so it survives updates, and read through
 * `dir` every time something is written, so a change needs no restart. Videos are stored under it by
 * a path relative to the folder, so a video saved in an earlier folder is found there: changing the
 * folder never loses a video and never has to copy a terabyte.
 */
export class RecordingPlace {
  private current: string
  private older: string[] = []
  /** Why the saved folder was not used at start-up, if it was not. */
  warning: string | null = null

  constructor(
    private readonly fallback: string,
    /** True when the install forbids changing the folder from the app. */
    readonly locked: boolean,
    private readonly settings?: PlaceSettings,
    /**
     * The storage areas a folder may be chosen in. A Docker install lists the folders it mounts, since a
     * folder anywhere else would live inside the container; empty means the whole disk (a plain server).
     */
    readonly roots: StorageRoot[] = [],
  ) {
    this.current = path.resolve(fallback)
  }

  private within(dir: string): boolean {
    return this.roots.length === 0 || this.roots.some((root) => isInside(dir, root.path))
  }

  private outside(): PlaceError {
    return new PlaceError(
      'outside',
      `Choose a folder inside one of the server’s storage areas: ${this.roots.map((root) => root.label).join(', ')}.`,
    )
  }

  get dir(): string {
    return this.current
  }

  /** The folders used before this one, newest first. */
  get olderDirs(): string[] {
    return this.older
  }

  /** Reads the folder saved by a Developer; the install's own folder is used when there is none. */
  async load(): Promise<void> {
    if (this.locked || !this.settings) return
    const saved = await this.settings.getSetting<Saved>(SETTING_KEY).catch(() => null)
    if (!saved || typeof saved.dir !== 'string') return
    this.older = Array.isArray(saved.older)
      ? saved.older.filter((dir): dir is string => typeof dir === 'string').slice(0, OLDER_MAX)
      : []
    try {
      await this.inspect(saved.dir, false)
      this.current = path.resolve(saved.dir)
    } catch (error) {
      // A disk that is not plugged in must not stop the server: keep recording where it can, and say so.
      const why = error instanceof PlaceError ? error.message : (error as Error).message
      this.warning = `The folder ${saved.dir} cannot be used now (${why}) Videos are being saved in ${this.current} instead.`
      console.error(`[rec] ${this.warning}`)
      this.older = [saved.dir, ...this.older.filter((dir) => dir !== saved.dir)].slice(0, OLDER_MAX)
    }
  }

  /** Whether `dir` can be used: absolute, not a system folder, a folder, writable. Makes it when `create`. */
  async inspect(
    input: string,
    create: boolean,
  ): Promise<{ dir: string; freeBytes: number | null; totalBytes: number | null }> {
    const text = typeof input === 'string' ? input.trim() : ''
    if (!text || text.length > 400 || text.includes('\0') || !path.isAbsolute(text))
      throw new PlaceError('relative')
    const dir = path.resolve(text)
    if (path.parse(dir).root === dir) throw new PlaceError('root')
    if (isSystemFolder(dir)) throw new PlaceError('system')
    if (!this.within(dir)) throw this.outside()

    let info = await stat(dir).catch(() => null)
    if (!info) {
      if (!create) throw new PlaceError('not_found')
      await mkdir(dir, { recursive: true }).catch(() => {
        throw new PlaceError('not_writable')
      })
      info = await stat(dir).catch(() => null)
    }
    if (!info?.isDirectory()) throw new PlaceError('not_dir')

    // Writing and deleting a small file is the only honest test of "the server can save here".
    const probe = path.join(dir, `.drone-fleet-test-${randomBytes(4).toString('hex')}`)
    try {
      await writeFile(probe, 'ok')
    } catch {
      throw new PlaceError('not_writable')
    } finally {
      await rm(probe, { force: true })
    }
    const space = await statfs(dir).catch(() => null)
    return {
      dir,
      freeBytes: space ? space.bavail * space.bsize : null,
      totalBytes: space ? space.blocks * space.bsize : null,
    }
  }

  /** Free and total bytes of the disk the main folder is on. */
  async space(): Promise<{ freeBytes: number | null; totalBytes: number | null }> {
    const info = await statfs(this.current).catch(() => null)
    return {
      freeBytes: info ? info.bavail * info.bsize : null,
      totalBytes: info ? info.blocks * info.bsize : null,
    }
  }

  /** Makes `input` the main folder (made if it does not exist). Returns the folders before and after. */
  async set(input: string, by: string | null): Promise<{ from: string; to: string }> {
    if (this.locked) throw new PlaceError('locked')
    const { dir } = await this.inspect(input, true)
    const from = this.current
    if (dir === from) return { from, to: dir }
    this.older = [from, ...this.older.filter((old) => old !== from && old !== dir)].slice(
      0,
      OLDER_MAX,
    )
    this.current = dir
    this.warning = null
    await this.settings?.setSetting(SETTING_KEY, { dir, older: this.older }, by)
    return { from, to: dir }
  }

  /**
   * A video's file as an absolute path. The file is named relative to the main folder, so it is looked
   * for there first and then in the folders used before. Null for a path that would leave the folder.
   */
  resolve(file: string): string | null {
    let first: string | null = null
    for (const root of [this.current, ...this.older]) {
      const base = path.resolve(root)
      const abs = path.resolve(base, file)
      if (!abs.startsWith(base + path.sep)) return null
      first ??= abs
      if (existsSync(abs)) return abs
    }
    return first
  }

  /** One level of the server's folders, starting at `input` or the main folder. Only folders are listed. */
  async browse(input?: string): Promise<FolderListing> {
    let dir = this.current
    if (input !== undefined && input !== '') {
      if (input.includes('\0') || !path.isAbsolute(input)) throw new PlaceError('relative')
      dir = path.resolve(input)
    }
    // Where storage areas are set, the picker stays inside them.
    if (!this.within(dir)) {
      if (input !== undefined && input !== '') throw this.outside()
      dir = this.roots[0]!.path
    }
    // A folder that is not there yet: show the nearest one that is (never above a storage area).
    while (!(await isDirectory(dir))) {
      const up = path.dirname(dir)
      if (up === dir || !this.within(up)) break
      dir = up
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => {
      throw new PlaceError('not_readable')
    })
    const folders: { name: string; path: string }[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue
      const full = path.join(dir, entry.name)
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (await isDirectory(full)))
      if (isDir) folders.push({ name: entry.name, path: full })
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    const writable = await access(dir, constants.W_OK).then(
      () => true,
      () => false,
    )
    const up = path.dirname(dir)
    const space = await statfs(dir).catch(() => null)
    return {
      path: dir,
      parent: up === dir || !this.within(up) ? null : up,
      folders: folders.slice(0, LIST_MAX),
      writable,
      freeBytes: space ? space.bavail * space.bsize : null,
      totalBytes: space ? space.blocks * space.bsize : null,
      truncated: folders.length > LIST_MAX,
      shortcuts: await this.shortcuts(),
    }
  }

  /** A new folder inside `parent`, for the picker's "New folder". Already there is fine. */
  async makeFolder(parent: string, name: string): Promise<string> {
    const clean = typeof name === 'string' ? name.trim() : ''
    if (
      !clean ||
      clean.length > FOLDER_NAME_MAX ||
      clean === '.' ||
      clean === '..' ||
      /[/\\:*?"<>|\p{Cc}]/u.test(clean)
    )
      throw new PlaceError('bad_name')
    if (typeof parent !== 'string' || parent.includes('\0') || !path.isAbsolute(parent))
      throw new PlaceError('relative')
    const base = path.resolve(parent)
    if (isSystemFolder(base)) throw new PlaceError('system')
    if (!this.within(base)) throw this.outside()
    if (!(await isDirectory(base))) throw new PlaceError('not_found')
    const made = path.join(base, clean)
    await mkdir(made).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST' && (await isDirectory(made))) return
      throw new PlaceError('not_writable')
    })
    return made
  }

  /** Places worth jumping to in the picker: home, mounted disks and drives, the folder in use. */
  private async shortcuts(): Promise<{ label: string; path: string }[]> {
    // Storage areas are the only places to go.
    if (this.roots.length > 0)
      return this.roots.map((root) => ({ label: root.label, path: root.path }))
    const out: { label: string; path: string }[] = [
      { label: 'Videos folder in use', path: this.current },
    ]
    const add = async (label: string, dir: string): Promise<void> => {
      if (out.length < 24 && !out.some((item) => item.path === dir) && (await isDirectory(dir)))
        out.push({ label, path: dir })
    }
    await add('Home', os.homedir())
    if (process.platform === 'win32') {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') await add(`${letter}:`, `${letter}:\\`)
    } else {
      const parents = process.platform === 'darwin' ? ['/Volumes'] : ['/mnt', '/media']
      for (const parent of parents) {
        for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => []))
          if (!entry.name.startsWith('.')) await add(entry.name, path.join(parent, entry.name))
      }
      await add('/srv', '/srv')
    }
    return out
  }
}
