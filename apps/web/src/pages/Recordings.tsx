import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  can,
  type ActiveRecording,
  type RecordingFolder,
  type RecordingRecord,
  type RecordingSort,
  type RecordingTagCount,
} from '@dji/protocol'
import { api, recordingThumbnailUrl, recordingVideoUrl, type User } from '../api'
import ColorDot from '../components/ColorDot'
import Icon from '../components/Icon'
import RecordingNotes, { TagChip } from '../components/RecordingNotes'
import RecordingStoragePanel from '../components/RecordingStoragePanel'
import StageBar from '../components/StageBar'
import UploadVideoDialog from '../components/UploadVideoDialog'
import { deviceLabel } from '../deviceSearch'
import { clockLabel, durationLabel, formatDateTime, sizeLabel } from '../flightFormat'
import { useFleet } from '../store'
import Badge from '../ui/Badge'
import Button, { ButtonLink } from '../ui/Button'
import Notice from '../ui/Notice'
import { cn } from '../ui/cn'
import { card, emptyPanel, filterControl, filterLabel, screenBody, td, th } from '../ui/surface'

const PAGE = 48
const SPEEDS = [0.5, 1, 2, 4]
type View = 'grid' | 'list'

/** A `datetime-local` value is in the browser's own time zone; the server wants an instant. */
function toIso(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function savedView(): View {
  try {
    return window.localStorage.getItem('recordings-view') === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

/**
 * Every video the server keeps: what it recorded from the drones and what people uploaded into
 * folders. Shown as a grid of thumbnails like the screenshots, or as a list; filtered by folder,
 * drone, name and date-time range; played with the usual controls and a speed choice, downloaded,
 * and (with the right) deleted. A recording is a run of clips; when one ends the next plays.
 */
export default function Recordings({
  user,
  railOpen,
  onOpenRail,
}: {
  user: User
  railOpen: boolean
  onOpenRail: (trigger: HTMLButtonElement) => void
}) {
  const devices = useFleet((state) => state.devices)
  const [view, setView] = useState<View>(savedView)
  const [deviceSn, setDeviceSn] = useState('')
  const [folder, setFolder] = useState('')
  const [source, setSource] = useState<'' | 'drone' | 'upload'>('')
  const [tag, setTag] = useState('')
  const [tags, setTags] = useState<RecordingTagCount[]>([])
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sort, setSort] = useState<RecordingSort>('recorded')
  // The video just uploaded, so it can be shown first and marked, and the message that says so.
  const [justAdded, setJustAdded] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  // Bumped to make the storage box read its figures again (after an upload or a delete).
  const [storageTick, setStorageTick] = useState(0)
  const [clips, setClips] = useState<RecordingRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [active, setActive] = useState<ActiveRecording[]>([])
  const [folders, setFolders] = useState<RecordingFolder[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [speed, setSpeed] = useState(1)
  const [uploading, setUploading] = useState(false)
  // Select mode: tick videos, then delete them together.
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  // Bumped to reload the list: after an upload or a delete, and while an upload is being made ready.
  const [tick, setTick] = useState(0)
  const video = useRef<HTMLVideoElement>(null)
  const player = useRef<HTMLDivElement>(null)
  const mayUpload = can(user, 'recordings.upload')

  const filter = useMemo(
    () => ({
      deviceSn: deviceSn || undefined,
      source: source || undefined,
      folder: folder || undefined,
      tag: tag || undefined,
      q: q || undefined,
      from: toIso(from),
      to: toIso(to),
      sort,
    }),
    [deviceSn, source, folder, tag, q, from, to, sort],
  )

  function chooseView(next: View) {
    setView(next)
    try {
      window.localStorage.setItem('recordings-view', next)
    } catch {
      /* the choice just is not remembered */
    }
  }

  // The words typed in the search box are applied a moment after typing stops.
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  // Recordings in progress, so an operator sees what is being kept and can stop it.
  useEffect(() => {
    let cancelled = false
    const load = () =>
      api
        .activeRecordings()
        .then((result) => !cancelled && setActive(result.recordings))
        .catch(() => undefined)
    void load()
    const timer = window.setInterval(load, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api
      .recordingFolders()
      .then((result) => !cancelled && setFolders(result.folders))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [tick])

  // The tags in use, for the filter and for the suggestions while typing one.
  useEffect(() => {
    let cancelled = false
    api
      .recordingTags()
      .then((result) => !cancelled && setTags(result.tags))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [tick])

  // A new clip appears when a recording finishes one, so the list reloads when that changes.
  const signature = active.map((rec) => `${rec.sessionId}:${rec.clips}`).join(',')
  useEffect(() => {
    let cancelled = false
    setError('')
    api
      .recordings({ ...filter, limit: PAGE, offset: 0 })
      .then((result) => {
        if (cancelled) return
        setClips(result.recordings)
        setTotal(result.total)
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [filter, signature, tick])

  // An upload is made playable in the background: look again until none is still being made ready.
  const busy = clips.some((clip) => clip.state === 'processing')
  useEffect(() => {
    if (!busy) return undefined
    const timer = window.setInterval(() => setTick((n) => n + 1), 3000)
    return () => window.clearInterval(timer)
  }, [busy])

  // Others upload and record too: look again now and then while this page is in front, and the moment the
  // tab is brought back, unless more than the first page was opened (the list would jump back to the top).
  const opened = clips.length
  useEffect(() => {
    const look = () => {
      if (document.visibilityState !== 'visible' || opened > PAGE) return
      setTick((n) => n + 1)
      setStorageTick((n) => n + 1)
    }
    const timer = window.setInterval(look, 20_000)
    document.addEventListener('visibilitychange', look)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', look)
    }
  }, [opened])

  const loadMore = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.recordings({ ...filter, limit: PAGE, offset: clips.length })
      setClips((current) => [...current, ...result.recordings])
      setTotal(result.total)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [filter, clips.length])

  const selected = clips.find((clip) => clip.id === selectedId) ?? null
  const nameOf = useCallback(
    (clip: RecordingRecord) => {
      if (clip.source === 'upload') return clip.title ?? 'Video'
      const device = clip.deviceSn ? devices[clip.deviceSn] : undefined
      return device ? deviceLabel(device) : (clip.deviceName ?? clip.deviceSn ?? 'Drone')
    },
    [devices],
  )
  const droneOf = useCallback(
    (clip: RecordingRecord) => {
      const device = clip.deviceSn ? devices[clip.deviceSn] : undefined
      return device ? deviceLabel(device) : (clip.deviceName ?? clip.deviceSn)
    },
    [devices],
  )

  // The player sits above the list: bring it into view when a video is chosen.
  useEffect(() => {
    if (selectedId) player.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [selectedId])

  const totals = useMemo(
    () => ({
      seconds: clips.reduce((sum, clip) => sum + clip.durationS, 0),
      bytes: clips.reduce((sum, clip) => sum + clip.sizeBytes, 0),
    }),
    [clips],
  )
  const more = clips.length < total
  const filtered = Boolean(deviceSn || folder || source || tag || q || from || to)

  function open(clip: RecordingRecord) {
    if (clip.state === 'failed') {
      setError(`${nameOf(clip)}: ${clip.error ?? 'This video could not be processed.'}`)
      return
    }
    if (clip.state === 'ready') setSelectedId(clip.id)
  }

  function playNext() {
    if (!selected) return
    // The next clip of the same recording, in time order: a long recording plays through.
    const next = clips
      .filter(
        (clip) => clip.sessionId === selected.sessionId && clip.startedAt > selected.startedAt,
      )
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))[0]
    if (next) setSelectedId(next.id)
  }

  const mayDelete = useCallback(
    (clip: RecordingRecord) => can(user, 'recordings.delete', clip.deviceSn ?? undefined),
    [user],
  )
  // Whoever may record on the drone, or upload, labels a video (the server decides the same way).
  const mayAnnotate = useCallback(
    (clip: RecordingRecord) =>
      can(user, 'recordings.record', clip.deviceSn ?? undefined) ||
      (clip.source === 'upload' && can(user, 'recordings.upload')),
    [user],
  )
  // A video still being made ready is left out of a selection: the server is working on its file.
  const pickable = useCallback(
    (clip: RecordingRecord) => clip.state !== 'processing' && mayDelete(clip),
    [mayDelete],
  )
  const deletable = useMemo(() => clips.filter(pickable), [clips, pickable])
  // Only what is on the screen is deleted, however the list was filtered after ticking.
  const chosen = useMemo(() => clips.filter((clip) => picked.has(clip.id)), [clips, picked])

  async function remove(clip: RecordingRecord) {
    const sure = window.confirm(
      `Delete "${nameOf(clip)}", ${formatDateTime(clip.startedAt)}?\nThe file is removed from the server and cannot be restored.`,
    )
    if (!sure) return
    try {
      await api.deleteRecording(clip.id)
      setClips((current) => current.filter((item) => item.id !== clip.id))
      setTotal((count) => Math.max(0, count - 1))
      if (selectedId === clip.id) setSelectedId(null)
      setTick((n) => n + 1)
      setStorageTick((n) => n + 1)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function endSelecting() {
    setSelecting(false)
    setPicked(new Set())
  }

  // Nothing left that could be ticked (all deleted, or the filter shows none): leave select mode.
  useEffect(() => {
    if (selecting && !loading && deletable.length === 0) {
      setSelecting(false)
      setPicked(new Set())
    }
  }, [selecting, loading, deletable.length])

  async function deletePicked() {
    if (chosen.length === 0) return
    const bytes = chosen.reduce((sum, clip) => sum + clip.sizeBytes, 0)
    const sure = window.confirm(
      `Delete ${chosen.length} video${chosen.length === 1 ? '' : 's'} (${sizeLabel(bytes)}) for good?\nThe files are removed from the server and cannot be restored.`,
    )
    if (!sure) return
    const ids = chosen.map((clip) => clip.id)
    setDeleting(true)
    setError('')
    setNotice('')
    let deleted = 0
    let skipped = 0
    try {
      // The server takes 200 at a time.
      for (let at = 0; at < ids.length; at += 200) {
        const result = await api.deleteRecordings(ids.slice(at, at + 200))
        deleted += result.deleted
        skipped += result.skipped
      }
      const gone = new Set(ids)
      setClips((current) => current.filter((clip) => !gone.has(clip.id)))
      setTotal((count) => Math.max(0, count - deleted))
      if (selectedId && gone.has(selectedId)) setSelectedId(null)
      setNotice(
        `Deleted ${deleted} video${deleted === 1 ? '' : 's'}${skipped > 0 ? `; ${skipped} could not be deleted by this account` : ''}.`,
      )
      endSelecting()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeleting(false)
      // Look again either way: some may have gone before a failure, and a skipped one is still there.
      setTick((n) => n + 1)
      setStorageTick((n) => n + 1)
    }
  }

  async function stop(sn: string) {
    try {
      await api.stopServerRecording(sn)
      setActive((current) => current.filter((rec) => rec.deviceSn !== sn))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const statePill = (clip: RecordingRecord) =>
    clip.state === 'processing' ? (
      <Badge tone="pending">Making it ready…</Badge>
    ) : clip.state === 'failed' ? (
      <Badge tone="danger">Could not be processed</Badge>
    ) : null

  return (
    <>
      <StageBar
        bar="recordings"
        title="Recordings"
        summary={`${total} video${total === 1 ? '' : 's'} / ${durationLabel(totals.seconds)}${more ? '+' : ''} / ${sizeLabel(totals.bytes)}${more ? '+' : ''}`}
        actions={
          mayUpload ? (
            <Button
              variant="mapPrimary"
              type="button"
              onClick={() => setUploading(true)}
              data-testid="upload-open"
            >
              <Icon name="upload" />
              <span>Upload video</span>
            </Button>
          ) : undefined
        }
        railOpen={railOpen}
        onOpenRail={onOpenRail}
      />
      <div className={screenBody} data-testid="recordings-screen">
        <RecordingStoragePanel user={user} refresh={storageTick} />

        {active.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2" data-testid="recordings-active">
            {active.map((rec) => (
              <div
                key={rec.sessionId}
                className="inline-flex items-center gap-2.5 rounded-md border border-[var(--rec)] bg-[var(--rec-bg)] px-3 py-1.5 text-[12px] text-[var(--rec-text)]"
                data-testid="recording-active"
              >
                <span className="size-2 rounded-full bg-[var(--rec-text)]" aria-hidden="true" />
                <span className="font-medium">
                  {devices[rec.deviceSn]
                    ? deviceLabel(devices[rec.deviceSn]!)
                    : (rec.deviceName ?? rec.deviceSn)}
                </span>
                <span className="font-mono text-[10.5px]">
                  {rec.mode === 'continuous' ? 'automatic · ' : ''}
                  {rec.state === 'waiting'
                    ? 'waiting for the drone'
                    : rec.state === 'paused'
                      ? 'paused: disk full'
                      : 'recording'}{' '}
                  · since {formatDateTime(rec.startedAt)} · {rec.clips} clip
                  {rec.clips === 1 ? '' : 's'} saved
                </span>
                {rec.mode !== 'continuous' && can(user, 'recordings.record', rec.deviceSn) && (
                  <button
                    className="rounded border border-[var(--rec)] px-2 py-0.5 text-[11px] font-medium hover:bg-white/40"
                    type="button"
                    onClick={() => void stop(rec.deviceSn)}
                  >
                    Stop
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {selected && (
          <div
            ref={player}
            className={cn(card, 'mb-4 overflow-hidden')}
            data-testid="recording-player"
          >
            <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-2.5">
              <div className="mr-auto min-w-0">
                <div className="truncate text-[13px] font-semibold">{nameOf(selected)}</div>
                <div className="font-mono text-[10.5px] text-ink-3">
                  {selected.folder ? `${selected.folder} · ` : ''}
                  {formatDateTime(selected.startedAt)} · {durationLabel(selected.durationS)} ·{' '}
                  {sizeLabel(selected.sizeBytes)}
                </div>
              </div>
              <label className="flex items-center gap-1.5 text-[11.5px] text-ink-2">
                <span>Speed</span>
                <select
                  className={filterControl}
                  value={speed}
                  data-testid="recording-speed"
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    setSpeed(value)
                    if (video.current) video.current.playbackRate = value
                  }}
                >
                  {SPEEDS.map((value) => (
                    <option key={value} value={value}>
                      {value}×
                    </option>
                  ))}
                </select>
              </label>
              <ButtonLink
                variant="secondary"
                href={recordingVideoUrl(selected.id, true)}
                download={selected.filename}
                data-testid="recording-download"
              >
                Download
              </ButtonLink>
              {mayDelete(selected) && (
                <Button variant="secondary" type="button" onClick={() => void remove(selected)}>
                  Delete
                </Button>
              )}
              <Button variant="secondary" type="button" onClick={() => setSelectedId(null)}>
                Close
              </Button>
            </div>
            <video
              key={selected.id}
              ref={video}
              className="block max-h-[62vh] w-full bg-black"
              controls
              autoPlay
              playsInline
              preload="metadata"
              src={recordingVideoUrl(selected.id)}
              data-testid="recording-video"
              onLoadedMetadata={(event) => {
                event.currentTarget.playbackRate = speed
              }}
              onEnded={playNext}
            />
            <RecordingNotes
              clip={selected}
              mayEdit={mayAnnotate(selected) && selected.state === 'ready'}
              suggestions={tags.map((item) => item.name)}
              onError={setError}
              onSaved={(updated) => {
                setClips((current) =>
                  current.map((item) => (item.id === updated.id ? updated : item)),
                )
                // The tag list and the filter follow what was just saved.
                setTick((n) => n + 1)
              }}
            />
          </div>
        )}

        <div className="mb-4" role="group" aria-label="Filter recordings">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] items-end gap-2.5">
            <label className={filterLabel}>
              <span>Folder</span>
              <select
                className={cn(filterControl, 'w-full')}
                value={folder}
                data-testid="recordings-folder"
                onChange={(event) => setFolder(event.target.value)}
              >
                <option value="">All folders</option>
                {folders.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} ({item.count})
                  </option>
                ))}
              </select>
            </label>
            <label className={filterLabel}>
              <span>Drone</span>
              <select
                className={cn(filterControl, 'w-full')}
                value={deviceSn}
                onChange={(event) => setDeviceSn(event.target.value)}
              >
                <option value="">All drones</option>
                {Object.values(devices).map((device) => (
                  <option key={device.sn} value={device.sn}>
                    {deviceLabel(device)}
                  </option>
                ))}
              </select>
            </label>
            <label className={filterLabel}>
              <span>Kind</span>
              <select
                className={cn(filterControl, 'w-full')}
                value={source}
                data-testid="recordings-source"
                onChange={(event) => setSource(event.target.value as '' | 'drone' | 'upload')}
              >
                <option value="">Everything</option>
                <option value="drone">Recorded from drones</option>
                <option value="upload">Uploaded</option>
              </select>
            </label>
            <label className={filterLabel}>
              <span>Tag</span>
              <select
                className={cn(filterControl, 'w-full')}
                value={tag}
                data-testid="recordings-tag"
                onChange={(event) => setTag(event.target.value)}
              >
                <option value="">Any tag</option>
                {tag && !tags.some((item) => item.name.toLowerCase() === tag.toLowerCase()) && (
                  <option value={tag}>{tag}</option>
                )}
                {tags.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} ({item.count})
                  </option>
                ))}
              </select>
            </label>
            <label className={filterLabel}>
              <span>Name</span>
              <input
                className={cn(filterControl, 'w-full')}
                type="search"
                value={search}
                placeholder="Search name, folder, tag or note"
                data-testid="recordings-search"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className={filterLabel}>
              <span>Order</span>
              <select
                className={cn(filterControl, 'w-full')}
                value={sort}
                data-testid="recordings-sort"
                onChange={(event) => setSort(event.target.value as RecordingSort)}
              >
                <option value="recorded">Recorded: newest first</option>
                <option value="oldest">Recorded: oldest first</option>
                <option value="added">Recently added</option>
              </select>
            </label>
          </div>
          <div className="mt-2.5 flex flex-wrap items-end gap-2.5">
            <label className={filterLabel}>
              <span>From</span>
              <input
                className={filterControl}
                type="datetime-local"
                value={from}
                max={to || undefined}
                data-testid="recordings-from"
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label className={filterLabel}>
              <span>To</span>
              <input
                className={filterControl}
                type="datetime-local"
                value={to}
                min={from || undefined}
                data-testid="recordings-to"
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
            {filtered && (
              <Button
                variant="secondary"
                type="button"
                onClick={() => {
                  setDeviceSn('')
                  setFolder('')
                  setSource('')
                  setTag('')
                  setSearch('')
                  setFrom('')
                  setTo('')
                }}
              >
                Clear filters
              </Button>
            )}
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setTick((n) => n + 1)
                setStorageTick((n) => n + 1)
              }}
              data-testid="recordings-refresh"
            >
              <Icon name="refresh" />
              <span>Refresh</span>
            </Button>
            {deletable.length > 0 && !selecting && (
              <Button
                variant="secondary"
                type="button"
                onClick={() => setSelecting(true)}
                data-testid="select-recordings"
              >
                <Icon name="check" />
                <span>Select</span>
              </Button>
            )}
            <div
              className="ml-auto inline-flex overflow-hidden rounded-md border border-line-strong"
              role="group"
              aria-label="Show as"
            >
              {(['grid', 'list'] as const).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className={cn(
                    'h-8 px-3 text-[11.5px] font-medium capitalize transition-colors',
                    view === choice
                      ? 'bg-pine text-white'
                      : 'bg-surface-2 text-ink-2 hover:bg-pine-wash hover:text-pine-strong',
                  )}
                  aria-pressed={view === choice}
                  data-testid={`recordings-view-${choice}`}
                  onClick={() => chooseView(choice)}
                >
                  {choice}
                </button>
              ))}
            </div>
          </div>
        </div>

        {selecting && (
          <div
            className="mb-3.5 flex flex-wrap items-center gap-2.5 rounded-md border border-line bg-pine-wash px-3 py-2"
            data-testid="select-bar"
          >
            <span className="text-[12px] font-medium text-ink-2">
              {chosen.length === 0
                ? 'Tick the videos to delete'
                : `${chosen.length} selected · ${sizeLabel(chosen.reduce((sum, clip) => sum + clip.sizeBytes, 0))}`}
            </span>
            <Button
              variant="secondary"
              type="button"
              onClick={() =>
                setPicked(
                  chosen.length === deletable.length
                    ? new Set()
                    : new Set(deletable.map((clip) => clip.id)),
                )
              }
            >
              {chosen.length === deletable.length
                ? 'Clear'
                : `Select all ${deletable.length} shown`}
            </Button>
            <Button
              variant="secondary"
              type="button"
              disabled={chosen.length === 0 || deleting}
              onClick={() => void deletePicked()}
              data-testid="delete-selected"
              className="hover:border-danger hover:text-danger"
            >
              <Icon name="trash" />
              {deleting ? 'Deleting…' : 'Delete selected'}
            </Button>
            <Button variant="secondary" type="button" onClick={endSelecting}>
              Cancel
            </Button>
          </div>
        )}

        {error && (
          <Notice tone="error" className="mb-3.5" onDismiss={() => setError('')}>
            {error}
          </Notice>
        )}
        {notice && (
          <div data-testid="recordings-notice">
            <Notice tone="success" className="mb-3.5" onDismiss={() => setNotice('')}>
              {notice}
            </Notice>
          </div>
        )}

        {!loading && clips.length === 0 ? (
          <div className={emptyPanel}>
            <div>
              <h2 className="mb-1.5 mt-0 text-[15px] font-semibold">
                {filtered ? 'No videos match' : 'No videos yet'}
              </h2>
              <p className="m-0 max-w-[48ch] text-[12.5px] leading-[1.6] text-ink-3">
                {filtered
                  ? 'Try a wider date and time range, another folder, drone or tag, or different words.'
                  : mayUpload
                    ? 'Press Upload video to keep a video recorded elsewhere, in a folder you name. Open a live feed and press Record to server to keep a drone’s video here too.'
                    : 'Videos recorded from the drones, and videos uploaded into folders, are kept here.'}
              </p>
            </div>
          </div>
        ) : view === 'grid' ? (
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] content-start gap-3.5"
            data-testid="recordings-grid"
          >
            {clips.map((clip) => {
              const ready = clip.state === 'ready'
              return (
                <article
                  key={clip.id}
                  className={cn(
                    'overflow-hidden rounded-lg border bg-white [box-shadow:var(--shadow-card)]',
                    clip.id === selectedId || picked.has(clip.id)
                      ? 'border-pine [box-shadow:0_0_0_2px_var(--pine)]'
                      : clip.id === justAdded
                        ? 'border-pine [box-shadow:0_0_0_2px_var(--pine-soft)]'
                        : 'border-line',
                  )}
                  data-testid="recording-card"
                  data-state={clip.state}
                >
                  <button
                    className="group relative block aspect-video w-full overflow-hidden bg-dark-bg"
                    type="button"
                    onClick={() => (selecting && pickable(clip) ? toggle(clip.id) : open(clip))}
                    aria-label={
                      selecting && pickable(clip)
                        ? `Select ${nameOf(clip)}, ${formatDateTime(clip.startedAt)}`
                        : `${ready ? 'Play' : 'Open'} ${nameOf(clip)}`
                    }
                    aria-pressed={selecting && pickable(clip) ? picked.has(clip.id) : undefined}
                  >
                    {selecting && pickable(clip) && (
                      <span
                        className={cn(
                          'absolute right-2 top-2 z-[2] grid size-6 place-items-center rounded-sm border-2 [&_svg]:size-3.5',
                          picked.has(clip.id)
                            ? 'border-pine bg-pine text-white'
                            : 'border-line-strong bg-white text-transparent',
                        )}
                        data-testid="recording-check"
                        aria-hidden="true"
                      >
                        <Icon name="check" />
                      </span>
                    )}
                    {ready ? (
                      <img
                        className="block size-full object-cover transition-transform group-hover:scale-[1.03] group-focus-visible:scale-[1.03]"
                        src={recordingThumbnailUrl(clip.id)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onError={(event) => {
                          event.currentTarget.style.visibility = 'hidden'
                        }}
                      />
                    ) : (
                      <span className="grid size-full place-items-center px-3 text-center text-[11.5px] text-dark-faint">
                        {clip.state === 'processing'
                          ? 'Making it ready to play…'
                          : 'This video could not be processed'}
                      </span>
                    )}
                    <span
                      className="absolute left-2 top-2 z-[1] inline-flex max-w-[80%] items-center gap-1 rounded-[999px] border border-[var(--pill-border)] bg-[var(--pill-bg)] px-2 py-0.5 font-mono text-[10px] text-[var(--pill-text)] [&_svg]:size-3 [&_svg]:flex-none"
                      data-testid="recording-badge"
                    >
                      <Icon name={clip.source === 'upload' ? 'folder' : 'record'} />
                      <span className="truncate">
                        {clip.id === justAdded ? 'New · ' : ''}
                        {clip.source === 'upload'
                          ? (clip.folder ?? 'No folder')
                          : clip.mode === 'continuous'
                            ? 'Automatic'
                            : 'From a drone'}
                      </span>
                    </span>
                    {ready && (
                      <>
                        <span
                          className="absolute bottom-2 right-2 z-[1] rounded-sm bg-black/70 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white"
                          data-testid="recording-length"
                        >
                          {clockLabel(clip.durationS)}
                        </span>
                        {!selecting && (
                          <span
                            className="absolute inset-0 z-[1] grid place-items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                            aria-hidden="true"
                          >
                            <span className="grid size-11 place-items-center rounded-full bg-black/55 text-white [&_svg]:size-5">
                              <Icon name="play" />
                            </span>
                          </span>
                        )}
                      </>
                    )}
                  </button>
                  <div className="flex min-h-11 items-start gap-2.5 border-t border-t-line px-2.5 py-[7px] pl-3 [background-image:linear-gradient(180deg,var(--surface-2),var(--tile-foot-end))]">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium tracking-[-0.005em]">
                        {nameOf(clip)}
                      </span>
                      {clip.source === 'upload' && droneOf(clip) && (
                        <span className="mt-px block truncate font-mono text-[8.5px] tracking-[0.04em] text-ink-3">
                          {droneOf(clip)}
                        </span>
                      )}
                      <span className="mt-0.5 block overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-ink-3">
                        {formatDateTime(clip.startedAt)}
                      </span>
                      <span className="mt-0.5 block overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-ink-3">
                        {ready ? sizeLabel(clip.sizeBytes) : (statePill(clip) ?? '')}
                        {ready && clip.startedBy ? ` · ${clip.startedBy}` : ''}
                      </span>
                      {clip.tags.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1" data-testid="recording-tags">
                          {clip.tags.slice(0, 3).map((name) => (
                            <TagChip
                              key={name.toLowerCase()}
                              name={name}
                              onPress={selecting ? undefined : () => setTag(name)}
                            />
                          ))}
                          {clip.tags.length > 3 && (
                            <span className="text-[10.5px] text-ink-3">
                              +{clip.tags.length - 3}
                            </span>
                          )}
                        </span>
                      )}
                      {clip.note && (
                        <span
                          className="mt-1 block truncate text-[11px] italic text-ink-3"
                          title={clip.note}
                          data-testid="recording-note-line"
                        >
                          {clip.note.split('\n')[0]}
                        </span>
                      )}
                    </div>
                    {ready && (
                      <a
                        className="grid size-[26px] flex-none place-items-center rounded-sm text-ink-3 no-underline transition-colors hover:bg-sunken hover:text-ink [&_svg]:size-[13px]"
                        href={recordingVideoUrl(clip.id, true)}
                        download={clip.filename}
                        aria-label={`Download ${nameOf(clip)}`}
                        title="Download video"
                      >
                        <Icon name="download" />
                      </a>
                    )}
                    {mayDelete(clip) && (
                      <button
                        type="button"
                        className="grid size-[26px] flex-none place-items-center rounded-sm text-ink-3 transition-colors hover:bg-sunken hover:text-danger [&_svg]:size-[13px]"
                        aria-label={`Delete ${nameOf(clip)}`}
                        title="Delete video"
                        data-testid="delete-recording"
                        onClick={() => void remove(clip)}
                      >
                        <Icon name="trash" />
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-white [box-shadow:var(--shadow-card)]">
            <table className="w-full border-collapse" data-testid="recordings-table">
              <thead>
                <tr>
                  {selecting && (
                    <th className={th}>
                      <span className="sr-only">Select</span>
                    </th>
                  )}
                  <th className={th}>Started</th>
                  <th className={th}>Name</th>
                  <th className={th}>Folder</th>
                  <th className={th}>Tags and note</th>
                  <th className={th}>Length</th>
                  <th className={th}>Size</th>
                  <th className={th}>Added by</th>
                  <th className={th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {clips.map((clip) => (
                  <tr
                    key={clip.id}
                    className={cn(
                      'hover:bg-pine-wash',
                      (clip.id === selectedId || clip.id === justAdded || picked.has(clip.id)) &&
                        'bg-pine-wash',
                    )}
                    data-testid="recording-row"
                    data-state={clip.state}
                  >
                    {selecting && (
                      <td className={td}>
                        {pickable(clip) && (
                          <input
                            type="checkbox"
                            className="size-4 cursor-pointer accent-[var(--pine)]"
                            checked={picked.has(clip.id)}
                            onChange={() => toggle(clip.id)}
                            aria-label={`Select ${nameOf(clip)}, ${formatDateTime(clip.startedAt)}`}
                            data-testid="recording-check"
                          />
                        )}
                      </td>
                    )}
                    <td className={`${td} whitespace-nowrap`}>
                      <button
                        className="cursor-pointer border-0 bg-transparent p-0 font-medium text-pine-strong hover:underline"
                        type="button"
                        onClick={() => (selecting && pickable(clip) ? toggle(clip.id) : open(clip))}
                      >
                        {formatDateTime(clip.startedAt)}
                      </button>
                    </td>
                    <td className={td}>
                      <span className="flex items-center gap-2">
                        {clip.source === 'drone' && (
                          <ColorDot
                            color={
                              (clip.deviceSn && devices[clip.deviceSn]?.color) || 'transparent'
                            }
                          />
                        )}
                        <span className="font-medium">{nameOf(clip)}</span>
                        {statePill(clip)}
                      </span>
                    </td>
                    <td className={`${td} text-ink-2`}>{clip.folder ?? '—'}</td>
                    <td className={`${td} max-w-[280px]`}>
                      {clip.tags.length > 0 && (
                        <span className="flex flex-wrap gap-1">
                          {clip.tags.map((name) => (
                            <TagChip
                              key={name.toLowerCase()}
                              name={name}
                              onPress={selecting ? undefined : () => setTag(name)}
                            />
                          ))}
                        </span>
                      )}
                      {clip.note && (
                        <span
                          className="mt-0.5 block truncate text-[11px] italic text-ink-3"
                          title={clip.note}
                        >
                          {clip.note.split('\n')[0]}
                        </span>
                      )}
                      {clip.tags.length === 0 && !clip.note && (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className={`${td} whitespace-nowrap font-mono text-[11px]`}>
                      {durationLabel(clip.durationS)}
                    </td>
                    <td className={`${td} whitespace-nowrap font-mono text-[11px]`}>
                      {sizeLabel(clip.sizeBytes)}
                    </td>
                    <td className={`${td} text-ink-2`}>
                      {clip.startedBy ?? <Badge tone="pending">Recovered</Badge>}
                    </td>
                    <td className={`${td} whitespace-nowrap text-right`}>
                      <Button
                        variant="secondary"
                        type="button"
                        disabled={clip.state !== 'ready'}
                        onClick={() => open(clip)}
                      >
                        Play
                      </Button>
                      {mayDelete(clip) && (
                        <Button
                          className="ml-1.5"
                          variant="secondary"
                          type="button"
                          onClick={() => void remove(clip)}
                        >
                          Delete
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {loading && <p className="mt-4 text-center text-[12px] text-ink-3">Loading videos…</p>}
        {more && !loading && (
          <div className="flex justify-center pt-[18px]">
            <Button variant="secondary" type="button" onClick={() => void loadMore()}>
              Load more videos
            </Button>
          </div>
        )}
      </div>

      {uploading && (
        <UploadVideoDialog
          folders={folders}
          onClose={() => setUploading(false)}
          onUploaded={(recording) => {
            // The video must be seen at once: a filter that does not match it (a search, a folder, a date) is
            // cleared and the list shows what was added last, so it is first. The page then looks again until
            // the video is playable.
            setDeviceSn('')
            setFolder('')
            setSource('')
            setTag('')
            setSearch('')
            setQ('')
            setFrom('')
            setTo('')
            setSort('added')
            setJustAdded(recording.id)
            setNotice(
              `“${recording.title ?? recording.filename}” was uploaded${recording.folder ? ` into the folder ${recording.folder}` : ''}. ${recording.state === 'processing' ? 'It is being made ready to play.' : ''}`.trim(),
            )
            setClips((current) => [
              recording,
              ...current.filter((item) => item.id !== recording.id),
            ])
            setTotal((count) => count + 1)
            setTick((n) => n + 1)
            setStorageTick((n) => n + 1)
          }}
        />
      )}
    </>
  )
}
