import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { can, type ScreenshotRecord } from '@dji/protocol'
import { api, screenshotImageUrl, screenshotThumbUrl, type User } from '../api'
import { deviceLabel, deviceName } from '../deviceSearch'
import { formatCoord } from '../format'
import { useFleet } from '../store'
import Button from '../ui/Button'
import { cn } from '../ui/cn'
import Icon from './Icon'
import ScreenshotViewer, { capturedLabel, type PeopleSummary } from './ScreenshotViewer'

const PAGE = 48

/** `YYYY-MM-DD` from a date input, as a local-day [from, to) range in ISO. */
function dayRange(day: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const start = new Date(`${day}T00:00:00`)
  if (Number.isNaN(start.getTime())) return null
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { from: start.toISOString(), to: end.toISOString() }
}

export default function ScreenshotGallery({ user }: { user: User }) {
  const devices = useFleet((state) => state.devices)
  const [deviceSn, setDeviceSn] = useState('')
  const [day, setDay] = useState('')
  const [shots, setShots] = useState<ScreenshotRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [open, setOpen] = useState<ScreenshotRecord | null>(null)
  // Select mode: tick stills, then delete them together.
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const mayDelete = useCallback(
    (shot: ScreenshotRecord) =>
      can(user, 'screenshots.view', shot.deviceSn) &&
      can(user, 'screenshots.delete', shot.deviceSn),
    [user],
  )
  const deletable = useMemo(() => shots.filter(mayDelete), [shots, mayDelete])

  const aircraft = useMemo(
    () => Object.values(devices).sort((a, b) => deviceName(a).localeCompare(deviceName(b))),
    [devices],
  )

  const titleFor = useCallback(
    (shot: ScreenshotRecord) => {
      const device = devices[shot.deviceSn]
      return device ? deviceLabel(device) : (shot.deviceLabel ?? 'Drone')
    },
    [devices],
  )

  const load = useCallback(
    async (before?: string) => {
      setLoading(true)
      setError(null)
      try {
        const range = day ? dayRange(day) : null
        const { screenshots } = await api.screenshots({
          deviceSn: deviceSn || undefined,
          from: range?.from,
          to: range?.to,
          before,
        })
        setShots((current) => (before ? [...current, ...screenshots] : screenshots))
        setHasMore(screenshots.length === PAGE)
      } catch {
        setError('Screenshots could not be loaded from the server.')
      } finally {
        setLoading(false)
      }
    },
    [day, deviceSn],
  )

  useEffect(() => {
    void load()
  }, [load])

  const forget = useCallback((ids: string[]) => {
    const gone = new Set(ids)
    setShots((current) => current.filter((shot) => !gone.has(shot.id)))
    setPicked((current) => new Set([...current].filter((id) => !gone.has(id))))
    setOpen((current) => (current && gone.has(current.id) ? null : current))
  }, [])

  async function deleteOne(shot: ScreenshotRecord) {
    if (
      !window.confirm(
        `Delete ${shot.filename} for good? The picture and its people count are removed.`,
      )
    )
      return
    setNotice(null)
    try {
      await api.deleteScreenshot(shot.id)
      forget([shot.id])
    } catch {
      setError('The screenshot could not be deleted.')
    }
  }

  async function deletePicked() {
    const ids = [...picked]
    if (ids.length === 0) return
    if (
      !window.confirm(
        `Delete ${ids.length} screenshot${ids.length === 1 ? '' : 's'} for good? The pictures and their people counts are removed.`,
      )
    )
      return
    setDeleting(true)
    setNotice(null)
    setError(null)
    try {
      const result = await api.deleteScreenshots(ids)
      forget(ids)
      setNotice(
        `Deleted ${result.deleted} screenshot${result.deleted === 1 ? '' : 's'}${
          result.skipped > 0 ? `; ${result.skipped} could not be deleted by this account` : ''
        }.`,
      )
      setSelecting(false)
    } catch {
      setError('The screenshots could not be deleted.')
    } finally {
      setDeleting(false)
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

  const updatePeople = useCallback((id: string, people: PeopleSummary | null) => {
    setShots((current) => current.map((shot) => (shot.id === id ? { ...shot, people } : shot)))
  }, [])

  const last = shots[shots.length - 1]

  // The next page loads by itself as the end of the list comes near, so a long history scrolls on without a click.
  // The button below stays for a browser without IntersectionObserver, or after an error.
  const scroller = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const lastTime = last?.capturedAt
  useEffect(() => {
    const root = scroller.current
    const node = sentinel.current
    if (!root || !node || !hasMore || loading || error || !lastTime) return undefined
    if (typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void load(lastTime)
      },
      { root, rootMargin: '700px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loading, error, lastTime, load])
  const filterControl =
    'h-8 min-w-[180px] rounded-md border border-line-strong bg-surface-2 px-2.5 font-sans text-[12px] normal-case tracking-normal text-ink outline-none focus:border-pine focus:[box-shadow:0_0_0_3px_var(--input-focus-ring)] until-stack:min-w-0 until-stack:w-full until-stack:flex-1'

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[22px] pb-[26px] pt-[18px] [scrollbar-color:var(--line-strong)_transparent] [scrollbar-width:thin] until-drawer:p-4 until-stack:px-4 until-stack:pb-[22px] until-stack:pt-3.5"
      data-parity="shots-screen"
      data-testid="screenshots"
    >
      <div
        className="mb-4 flex flex-wrap items-end gap-2.5"
        role="group"
        aria-label="Filter screenshots"
      >
        <label className="flex flex-col gap-1 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3 until-stack:min-w-0 until-stack:w-full until-stack:flex-1">
          <span>Drone</span>
          <select
            className={filterControl}
            value={deviceSn}
            onChange={(event) => setDeviceSn(event.target.value)}
          >
            <option value="">All drones</option>
            {aircraft.map((device) => (
              <option key={device.sn} value={device.sn}>
                {deviceLabel(device)} ({device.sn})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3 until-stack:min-w-0 until-stack:w-full until-stack:flex-1">
          <span>Date</span>
          <input
            className={filterControl}
            type="date"
            value={day}
            onChange={(event) => setDay(event.target.value)}
          />
        </label>
        {(deviceSn || day) && (
          <Button
            variant="secondary"
            type="button"
            onClick={() => {
              setDeviceSn('')
              setDay('')
            }}
          >
            Clear filters
          </Button>
        )}
        <Button variant="secondary" type="button" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" />
          Refresh
        </Button>
        {deletable.length > 0 && !selecting && (
          <Button
            variant="secondary"
            type="button"
            onClick={() => setSelecting(true)}
            data-testid="select-screenshots"
          >
            <Icon name="check" />
            Select
          </Button>
        )}
      </div>

      {selecting && (
        <div
          className="mb-3.5 flex flex-wrap items-center gap-2.5 rounded-md border border-line bg-pine-wash px-3 py-2"
          data-testid="select-bar"
        >
          <span className="text-[12px] font-medium text-ink-2">
            {picked.size === 0 ? 'Tick the screenshots to delete' : `${picked.size} selected`}
          </span>
          <Button
            variant="secondary"
            type="button"
            onClick={() =>
              setPicked(
                picked.size === deletable.length
                  ? new Set()
                  : new Set(deletable.map((shot) => shot.id)),
              )
            }
          >
            {picked.size === deletable.length ? 'Clear' : `Select all ${deletable.length} shown`}
          </Button>
          <Button
            variant="secondary"
            type="button"
            disabled={picked.size === 0 || deleting}
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

      {notice && (
        <div
          className="mb-3.5 flex items-center gap-2 rounded-md border border-line-soft bg-pine-wash px-3 py-2.5 text-[12px] text-pine-strong"
          role="status"
          data-testid="shots-notice"
        >
          <Icon name="check" className="size-[15px]" />
          {notice}
        </div>
      )}

      {error && (
        <div
          className="mb-3.5 flex items-center gap-2 rounded-md border border-danger-edge bg-live-soft px-3 py-2.5 text-[12px] text-danger-text"
          role="alert"
        >
          <Icon name="alert" className="size-[15px]" />
          {error}
        </div>
      )}

      {!error && !loading && shots.length === 0 ? (
        <div className="grid min-h-[340px] place-items-center rounded-lg border border-dashed border-line-strong bg-[var(--wall-empty-bg)] px-5 py-10 text-center">
          <div>
            <h2 className="mb-1.5 mt-0 text-[15px] font-semibold">No screenshots yet</h2>
            <p className="m-0 max-w-[42ch] text-[12.5px] leading-[1.6] text-ink-3">
              {deviceSn || day
                ? 'Nothing matches these filters. Clear them to see every capture.'
                : 'Open a live feed and press Capture to save the current frame to the server.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] content-start gap-3.5">
          {shots.map((shot) => (
            <article
              key={shot.id}
              className={cn(
                'overflow-hidden rounded-lg border bg-white [box-shadow:var(--shadow-card)]',
                picked.has(shot.id)
                  ? 'border-pine [box-shadow:0_0_0_2px_var(--pine)]'
                  : 'border-line',
              )}
              data-testid="shot-card"
            >
              <button
                className="group relative block aspect-video w-full overflow-hidden bg-dark-bg"
                type="button"
                onClick={() => (selecting && mayDelete(shot) ? toggle(shot.id) : setOpen(shot))}
                aria-label={
                  selecting && mayDelete(shot) ? `Select ${shot.filename}` : `Open ${shot.filename}`
                }
                aria-pressed={selecting && mayDelete(shot) ? picked.has(shot.id) : undefined}
              >
                {selecting && mayDelete(shot) && (
                  <span
                    className={cn(
                      'absolute right-2 top-2 z-[2] grid size-6 place-items-center rounded-sm border-2 [&_svg]:size-3.5',
                      picked.has(shot.id)
                        ? 'border-pine bg-pine text-white'
                        : 'border-line-strong bg-white text-transparent',
                    )}
                    data-testid="shot-check"
                    aria-hidden="true"
                  >
                    <Icon name="check" />
                  </span>
                )}
                {shot.people && (
                  <span
                    className="absolute left-2 top-2 z-[1] inline-flex items-center gap-1 rounded-[999px] border border-[var(--pill-border)] bg-[var(--pill-bg)] px-2 py-0.5 font-mono text-[10px] tabular-nums text-[var(--pill-text)] [&_svg]:size-3"
                    title={
                      shot.people.verifiedCount === null
                        ? `AI estimate: ${shot.people.aiCount} people, not verified`
                        : `Verified: ${shot.people.verifiedCount} people`
                    }
                    data-testid="people-badge"
                  >
                    <Icon name="users" />
                    {shot.people.verifiedCount === null ? (
                      <>~{shot.people.aiCount}</>
                    ) : (
                      <>
                        {shot.people.verifiedCount}
                        <Icon name="check" className="text-[var(--capture-ok)]" />
                      </>
                    )}
                  </span>
                )}
                {/* The small copy: the full picture is fetched only when someone opens the still. If the small copy
                    cannot be made (a damaged file) the picture itself is shown instead, once. */}
                <img
                  className="block size-full object-cover transition-transform group-hover:scale-[1.03] group-focus-visible:scale-[1.03]"
                  src={screenshotThumbUrl(shot.id)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  onError={(event) => {
                    const image = event.currentTarget
                    if (image.dataset.fallback === '1') return
                    image.dataset.fallback = '1'
                    image.src = screenshotImageUrl(shot.id)
                  }}
                />
              </button>
              <div className="flex min-h-11 items-start gap-2.5 border-t border-t-line px-2.5 py-[7px] pl-3 [background-image:linear-gradient(180deg,var(--surface-2),var(--tile-foot-end))]">
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium tracking-[-0.005em]">
                    {titleFor(shot)}
                  </span>
                  <span className="mt-px block truncate font-mono text-[8.5px] tracking-[0.04em] text-ink-3">
                    {shot.deviceSn}
                  </span>
                  <span className="mt-0.5 block overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-ink-3">
                    {capturedLabel(shot.capturedAt)}
                  </span>
                  <span className="mt-0.5 block overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-ink-3">
                    {shot.missionId ? `Mission ${shot.missionId} · ` : ''}
                    {formatCoord(shot.lat, shot.lon)}
                  </span>
                </div>
                <a
                  className="grid size-[26px] flex-none place-items-center rounded-sm text-ink-3 no-underline transition-colors hover:bg-sunken hover:text-ink [&_svg]:size-[13px]"
                  href={screenshotImageUrl(shot.id, true)}
                  download={shot.filename}
                  aria-label={`Download ${shot.filename}`}
                  title="Download image"
                >
                  <Icon name="download" />
                </a>
                {mayDelete(shot) && (
                  <button
                    type="button"
                    className="grid size-[26px] flex-none place-items-center rounded-sm text-ink-3 transition-colors hover:bg-sunken hover:text-danger [&_svg]:size-[13px]"
                    aria-label={`Delete ${shot.filename}`}
                    title="Delete screenshot"
                    data-testid="delete-one"
                    onClick={() => void deleteOne(shot)}
                  >
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {hasMore && last && (
        <div ref={sentinel} className="flex justify-center px-0 pb-1.5 pt-[18px]">
          <Button
            variant="secondary"
            type="button"
            onClick={() => void load(last.capturedAt)}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      {open && (
        <ScreenshotViewer
          shot={open}
          title={titleFor(open)}
          canDelete={mayDelete(open)}
          onClose={() => setOpen(null)}
          onPeople={updatePeople}
          onDeleted={(id) => forget([id])}
        />
      )}
    </div>
  )
}
