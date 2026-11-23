import { z } from 'zod'

/**
 * Video the server records itself, from the feed it already receives (a copy of the stream, not a
 * re-encode, so it costs next to no CPU). A recording is a run of clips: each clip is one playable
 * MP4 file that runs until the drone's feed ends, with no time limit (an installer may set
 * `RECORDING_SEGMENT_SECONDS` to cut it instead), and a time range is answered by listing the clips
 * that overlap it.
 *
 * This is separate from the local recording an operator makes on their own computer
 * (`recorder.ts` in the web app), which uploads nothing and remains.
 */
export const RECORDING_MODES = ['manual', 'continuous'] as const
export type RecordingMode = (typeof RECORDING_MODES)[number]

/**
 * Where a video in the archive came from: recorded by the server from a drone's live feed, or
 * uploaded by a person (footage recorded elsewhere, kept and played through the same screen).
 */
export const RECORDING_SOURCES = ['drone', 'upload'] as const
export type RecordingSource = (typeof RECORDING_SOURCES)[number]

/** An upload is `processing` while the server makes it playable in a browser. */
export const RECORDING_STATES = ['processing', 'ready', 'failed'] as const
export type RecordingState = (typeof RECORDING_STATES)[number]

/** Longest a folder or a video name can be: they are shown on cards and become file names. */
export const FOLDER_NAME_MAX = 80
export const VIDEO_TITLE_MAX = 120

/** Tags and a note on a video: how a person labels it so it can be found again (a search matches both). */
export const RECORDING_TAG_MAX = 30
export const RECORDING_TAGS_MAX = 20
export const RECORDING_NOTE_MAX = 2000

/** A tag as a person typed it: no leading `#`, no commas or line breaks, one space between words, cut to length. */
export function cleanTag(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f,;]/g, ' ').replace(/^[#\s]+/, '')
  const tag = text.replace(/\s+/g, ' ').trim().slice(0, RECORDING_TAG_MAX).trim()
  return tag === '' ? null : tag
}

/** The tags of one video: cleaned, the same word in another case counted once (the first spelling stays), in order. */
export function cleanTags(list: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const tag = cleanTag(raw)
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
  }
  return out.slice(0, RECORDING_TAGS_MAX)
}

/** A note as typed: line breaks kept, control characters gone, trimmed; nothing left is no note. */
export function cleanNote(raw: string | null): string | null {
  if (raw === null) return null
  const note = raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  return note === '' ? null : note.slice(0, RECORDING_NOTE_MAX)
}

/** `PATCH /api/recordings/:id`: send what changes; `tags` replaces the whole list, a `null` note clears it. */
export const recordingAnnotationSchema = z
  .object({
    tags: z
      .array(z.string().max(200))
      .max(RECORDING_TAGS_MAX * 2)
      .optional(),
    note: z
      .string()
      .max(RECORDING_NOTE_MAX * 2)
      .nullable()
      .optional(),
  })
  .refine((value) => value.tags !== undefined || value.note !== undefined, {
    message: 'nothing to change',
  })

/** A tag in use, with how many videos carry it (for the filter and the suggestions). */
export interface RecordingTagCount {
  name: string
  count: number
}

/** One archived video: a clip of a recording, or an uploaded file. */
export interface RecordingRecord {
  id: string
  /** The recording this clip belongs to: every clip of one start-to-stop shares it. */
  sessionId: string
  source: RecordingSource
  /** An upload may be tied to a drone, or to none. */
  deviceSn: string | null
  deviceName: string | null
  /** null for an upload. */
  mode: RecordingMode | null
  /** The name an uploader gave the video; null for a recorded clip. */
  title: string | null
  /** The folder an uploader put it in; null for a recorded clip or an upload kept in none. */
  folder: string | null
  state: RecordingState
  /** Why an upload could not be made playable. */
  error: string | null
  /** For an upload, when the footage was recorded if the file says so, else when it was uploaded. */
  startedAt: string
  endedAt: string
  durationS: number
  sizeBytes: number
  /** The account that started the recording or uploaded the file; null for a clip found on disk after a restart. */
  startedBy: string | null
  /** What a person labelled it with, in the order they were added. */
  tags: string[]
  /** A free note about it, or null. */
  note: string | null
  filename: string
}

/**
 * A recording in progress. `waiting` means the drone's feed is not live right now; `paused` means the
 * server's disk is too full to record (see `RecordingStorage`). A `continuous` one belongs to a drone
 * set to record automatically: it never ends by itself, and records each time the drone connects.
 */
export interface ActiveRecording {
  sessionId: string
  deviceSn: string
  deviceName: string | null
  mode: RecordingMode
  startedAt: string
  startedBy: string | null
  state: 'waiting' | 'recording' | 'paused'
  /** Clips finished so far; the clip being written is not counted. */
  clips: number
}

/** A folder uploads are kept in, with how many videos are in it. */
export interface RecordingFolder {
  name: string
  count: number
}

/** A drone and whether it records automatically (every time it connects, until turned off). */
export interface RecordingAutoDrone {
  deviceSn: string
  deviceName: string | null
  /** The choice made for this drone: true, false, or null to follow the installation's default. */
  setting: boolean | null
  /** Whether it records automatically now (the choice, or the default when none was made). */
  enabled: boolean
  /** `off` when not automatic, `waiting` while the drone is not connected, `paused` when the disk is full. */
  state: 'off' | 'waiting' | 'recording' | 'paused'
  online: boolean
}

/** How much the recordings use, how much room is left, and the rules that keep the disk from filling. */
export interface RecordingStorage {
  /** Everything kept: automatic clips, manual clips and uploads. */
  usedBytes: number
  /** The automatic clips: the only ones the server ever deletes by itself. */
  autoBytes: number
  clips: number
  oldestAutoAt: string | null
  newestAt: string | null
  /** What was written in the last 24 hours, to estimate how long the room lasts. */
  bytesLast24h: number
  freeBytes: number | null
  diskBytes: number | null
  /** Automatic clips older than this many days are deleted; 0 keeps them until room is needed. */
  retentionDays: number
  /** Most the recordings may use; 0 means no limit but the free-space floor. */
  maxBytes: number
  /** The server deletes the oldest automatic clips, then stops recording, rather than go below this. */
  minFreeBytes: number
  /** Whether a drone with no choice of its own records automatically. */
  autoDefault: boolean
  paused: boolean
  pausedReason: string | null
  /** Days until the free-space floor at the last 24 hours' pace; null when nothing was written. */
  daysLeft: number | null
  lastCleanup: { at: string; clips: number; bytes: number; reason: string } | null
}

/** Where the server keeps the videos (what the Developer sees on the Recordings screen). */
export interface RecordingLocation {
  /** The main folder on the server's disk. */
  dir: string
  /** True when the install fixes it (Docker): it can only be changed in the server's own settings. */
  locked: boolean
  freeBytes: number | null
  totalBytes: number | null
  /**
   * Where a folder may be chosen: the server's storage areas (in Docker, the folders it mounts). Empty means
   * any folder on the server's disk.
   */
  roots: { path: string; label: string }[]
  /** Folders used before; videos already saved there keep playing from them. */
  older: string[]
  /** Set when the chosen folder could not be used at start-up and another one is in use instead. */
  warning: string | null
  clips: number
  usedBytes: number
}

/** One level of the server's folders, for the folder picker. */
export interface FolderListing {
  path: string
  /** The folder above, or null at the top of a disk. */
  parent: string | null
  folders: { name: string; path: string }[]
  writable: boolean
  /** Free and total bytes of the disk this folder is on. */
  freeBytes: number | null
  totalBytes: number | null
  /** More than the picker shows were in the folder. */
  truncated: boolean
  /** Places worth jumping to: the home folder, other disks and drives. */
  shortcuts: { label: string; path: string }[]
}

/** How the list of videos is ordered: by when the footage was recorded, or by when it was added. */
export const RECORDING_SORTS = ['recorded', 'oldest', 'added'] as const
export type RecordingSort = (typeof RECORDING_SORTS)[number]
