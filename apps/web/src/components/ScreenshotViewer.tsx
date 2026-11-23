import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type {
  PeopleCount,
  PeopleCountResponse,
  PeopleDetection,
  PeopleMark,
  ScreenshotRecord,
} from '@dji/protocol'
import { api, screenshotImageUrl, screenshotThumbUrl } from '../api'
import { formatCoord } from '../format'
import Button, { ButtonLink } from '../ui/Button'
import Spinner from '../ui/Spinner'
import Icon from './Icon'

export type PeopleSummary = NonNullable<ScreenshotRecord['people']>

// A counted detection below this confidence gets a ring asking the operator to check it.
const CHECK_BELOW = 0.5
const ZOOMS = [1, 1.5, 2, 3, 4]
const UNDO_DEPTH = 50

const capturedFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export function capturedLabel(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : capturedFormat.format(date)
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The request failed.'
}

/** Which model detections the operator counts, plus the people they added by hand. */
interface Draft {
  accepted: boolean[]
  manual: { x: number; y: number }[]
}

function centre(detection: PeopleDetection): { x: number; y: number } {
  return { x: detection.x + detection.w / 2, y: detection.y + detection.h / 2 }
}

/** A saved verification, or the model's own counted set when nobody has verified yet. */
function draftFrom(people: PeopleCount): Draft {
  if (!people.marks) {
    return { accepted: people.detections.map((detection) => detection.counted), manual: [] }
  }
  const kept = people.marks.filter((mark) => mark.source === 'ai')
  return {
    accepted: people.detections.map((detection) => {
      const { x, y } = centre(detection)
      return kept.some((mark) => Math.abs(mark.x - x) < 1e-4 && Math.abs(mark.y - y) < 1e-4)
    }),
    manual: people.marks.filter((mark) => mark.source === 'manual').map(({ x, y }) => ({ x, y })),
  }
}

function marksFrom(draft: Draft, detections: PeopleDetection[]): PeopleMark[] {
  const marks: PeopleMark[] = []
  detections.forEach((detection, index) => {
    if (draft.accepted[index]) marks.push({ ...centre(detection), source: 'ai' })
  })
  for (const mark of draft.manual) marks.push({ ...mark, source: 'manual' })
  return marks
}

function sameDraft(a: Draft | null, b: Draft | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function Metadata({ shot }: { shot: ScreenshotRecord }) {
  const items: [string, string][] = [
    ['Drone', shot.deviceSn],
    ['Captured', capturedLabel(shot.capturedAt)],
    ['Location', formatCoord(shot.lat, shot.lon)],
    ...(shot.missionId ? ([['Mission', shot.missionId]] as [string, string][]) : []),
    ['Operator', shot.operatorEmail ?? 'Unknown'],
    [
      'Image',
      `${shot.width && shot.height ? `${shot.width} × ${shot.height}, ` : ''}${sizeLabel(shot.sizeBytes)}`,
    ],
  ]
  return (
    <dl className="m-0 flex flex-wrap gap-x-[22px] gap-y-2 text-[11.5px]">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="font-mono text-[8.5px] uppercase tracking-[0.08em] text-dark-faint">
            {label}
          </dt>
          <dd className="mt-0.5">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export default function ScreenshotViewer({
  shot,
  title,
  startWithPeople = false,
  canDelete = false,
  onClose,
  onPeople,
  onDeleted,
}: {
  shot: ScreenshotRecord
  title: string
  /** Show Delete: the account holds screenshots.delete on this drone. */
  canDelete?: boolean
  /** Told after the still was deleted, so a list can drop it. */
  onDeleted?: (id: string) => void
  /** Open with the people count running, as the Count people action after a capture does. */
  startWithPeople?: boolean
  onClose: () => void
  /** Told whenever the stored count for this still changes. */
  onPeople?: (id: string, people: PeopleSummary | null) => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(shot.width && shot.height ? shot.width / shot.height : 16 / 9)
  // The small copy, already in the browser from the gallery, shows at once; the full picture loads over it and
  // takes its place the moment it is ready.
  const [fullReady, setFullReady] = useState(false)
  const [thumbFailed, setThumbFailed] = useState(false)
  useEffect(() => {
    setFullReady(false)
    setThumbFailed(false)
  }, [shot.id])

  const [peopleOpen, setPeopleOpen] = useState(startWithPeople)
  const [result, setResult] = useState<PeopleCountResponse | null>(null)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'counting' | 'saving'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [history, setHistory] = useState<Draft[]>([])
  const [zoom, setZoom] = useState(1)
  const [showBoxes, setShowBoxes] = useState(false)
  // A better result that arrived while the operator had unsaved changes, waiting to be taken.
  const [newer, setNewer] = useState<PeopleCountResponse | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const people = result?.people ?? null
  const detections = useMemo(() => people?.detections ?? [], [people])
  const stored = useMemo(() => (people ? draftFrom(people) : null), [people])
  const dirty = Boolean(people) && !sameDraft(draft, stored)
  const canEdit = Boolean(result?.canVerify && people && phase === 'idle')

  const apply = useCallback(
    (next: PeopleCountResponse) => {
      setResult(next)
      setDraft(next.people ? draftFrom(next.people) : null)
      setHistory([])
      onPeople?.(
        shot.id,
        next.people
          ? { aiCount: next.people.aiCount, verifiedCount: next.people.verifiedCount }
          : null,
      )
    },
    [onPeople, shot.id],
  )

  const runCount = useCallback(async () => {
    setPhase('counting')
    setError(null)
    try {
      apply(await api.countPeople(shot.id))
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setPhase('idle')
    }
  }, [apply, shot.id])

  // Opening the panel loads the stored count, and runs the model when there is none yet.
  useEffect(() => {
    if (!peopleOpen || result) return
    let cancelled = false
    setPhase('loading')
    setError(null)
    api
      .people(shot.id)
      .then((response) => {
        if (cancelled) return
        apply(response)
        setPhase('idle')
        if (!response.people && response.available) void runCount()
      })
      .catch((failure: unknown) => {
        if (cancelled) return
        setError(errorText(failure))
        setPhase('idle')
      })
    return () => {
      cancelled = true
    }
  }, [apply, peopleOpen, result, runCount, shot.id])

  // While the server is still refining the count (the thorough scan after the quick one), look
  // for the better result. It replaces the marks at once unless the operator has started
  // changing them; then it is offered instead, so nothing is lost under their hands.
  useEffect(() => {
    if (!peopleOpen || !result?.counting || phase !== 'idle') return
    let cancelled = false
    const timer = window.setTimeout(() => {
      api
        .people(shot.id)
        .then((next) => {
          if (cancelled) return
          const changed =
            Boolean(next.people) && next.people?.analyzedAt !== result.people?.analyzedAt
          if (!changed) {
            setResult((current) => (current ? { ...current, counting: next.counting } : current))
          } else if (dirty) {
            setNewer(next)
            setResult((current) => (current ? { ...current, counting: next.counting } : current))
          } else {
            apply(next)
            if (next.people?.stage === 'thorough') setNotice('Updated with the thorough scan.')
          }
        })
        .catch(() => undefined)
    }, 2000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [apply, dirty, peopleOpen, phase, result, shot.id])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function deleteThis() {
    if (
      !window.confirm(
        `Delete ${shot.filename} for good? The picture and its people count are removed.`,
      )
    )
      return
    setError(null)
    try {
      await api.deleteScreenshot(shot.id)
    } catch {
      setError('The screenshot could not be deleted.')
      return
    }
    onDeleted?.(shot.id)
    onClose()
  }

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('Discard the people count you have not saved?')) return
    onClose()
  }, [dirty, onClose])

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [requestClose])

  function edit(change: (current: Draft) => Draft) {
    if (!draft || !canEdit) return
    setHistory((previous) => [...previous.slice(-(UNDO_DEPTH - 1)), draft])
    setDraft(change(draft))
  }

  function toggleDetection(index: number) {
    edit((current) => ({
      ...current,
      accepted: current.accepted.map((value, i) => (i === index ? !value : value)),
    }))
  }

  function addAt(event: MouseEvent<HTMLDivElement>) {
    const frame = frameRef.current
    if (!frame || !peopleOpen) return
    const rect = frame.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width
    const y = (event.clientY - rect.top) / rect.height
    if (x < 0 || x > 1 || y < 0 || y > 1) return
    edit((current) => ({ ...current, manual: [...current.manual, { x, y }] }))
  }

  async function save() {
    if (!draft || !people) return
    setPhase('saving')
    setError(null)
    try {
      apply(await api.verifyPeople(shot.id, marksFrom(draft, detections)))
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setPhase('idle')
    }
  }

  function rerun() {
    const lose = people?.verifiedCount !== null || dirty
    if (
      lose &&
      !window.confirm('Counting again replaces the AI result and clears the verified count.')
    ) {
      return
    }
    void runCount()
  }

  const accepted = draft ? draft.accepted.filter(Boolean).length : 0
  const added = draft?.manual.length ?? 0
  const total = accepted + added
  const possible = draft ? detections.filter((_, i) => !draft.accepted[i]).length : 0
  const toCheck = draft
    ? detections.filter((d, i) => draft.accepted[i] && d.score < CHECK_BELOW).length
    : 0
  const verified = people?.verifiedCount !== null && people?.verifiedCount !== undefined && !dirty
  const busy = phase !== 'idle'
  const frameHeight = peopleOpen ? '(100dvh - 330px)' : '(100dvh - 190px)'

  return (
    <div
      className="dark-shell fixed inset-0 z-[60] grid grid-cols-[minmax(0,1fr)] place-items-center bg-[var(--shot-viewer-bg)] p-5 until-stack:p-3"
      role="dialog"
      aria-modal="true"
      aria-label={`Screenshot ${shot.filename}`}
      onClick={requestClose}
      data-testid="screenshot-viewer"
    >
      <div
        className="flex max-h-full w-[min(1180px,100%)] flex-col gap-2.5 overflow-y-auto text-dark-text"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium">{title}</span>
            <span className="mt-px block truncate font-mono text-[8.5px] tracking-[0.04em] text-dark-faint">
              {shot.filename}
            </span>
          </div>
          <Button
            variant="dark"
            type="button"
            aria-pressed={peopleOpen}
            onClick={() => setPeopleOpen((open) => !open)}
            data-testid="people-toggle"
          >
            <Icon name="users" />
            <span>People</span>
          </Button>
          <ButtonLink
            variant="dark"
            href={screenshotImageUrl(shot.id, true)}
            download={shot.filename}
          >
            <Icon name="download" />
            <span className="until-phone-lg:hidden">Download</span>
          </ButtonLink>
          {canDelete && (
            <Button
              variant="dark"
              type="button"
              onClick={() => void deleteThis()}
              disabled={phase !== 'idle'}
              data-testid="delete-screenshot"
            >
              <Icon name="trash" />
              <span className="until-phone-lg:hidden">Delete</span>
            </Button>
          )}
          <Button
            ref={closeRef}
            variant="dark"
            type="button"
            onClick={requestClose}
            aria-label="Close"
          >
            <Icon name="x" />
          </Button>
        </div>

        {peopleOpen && (
          <section
            className="flex shrink-0 flex-col gap-2 rounded-md border border-dark-line bg-dark-surface px-3 py-2.5"
            aria-label="People count"
            data-testid="people-panel"
          >
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <div className="flex items-baseline gap-2" aria-live="polite">
                <span
                  className="text-[28px] font-semibold leading-none tabular-nums"
                  data-testid="people-total"
                >
                  {people ? total : '–'}
                </span>
                <span className="text-[12px] text-dark-muted">
                  {total === 1 ? 'person' : 'people'}
                </span>
              </div>

              <div className="min-w-[180px] flex-1 text-[11.5px] leading-[1.5]">
                {phase === 'loading' && <span className="text-dark-muted">Loading the count…</span>}
                {phase === 'counting' && (
                  <span className="text-dark-muted">Counting with AI… about two seconds.</span>
                )}
                {phase === 'saving' && <span className="text-dark-muted">Saving…</span>}
                {phase === 'idle' && people && (
                  <>
                    {verified ? (
                      <span
                        className="font-medium text-[var(--capture-ok)]"
                        data-testid="people-verified"
                      >
                        Verified
                        {people.verifiedBy ? ` by ${people.verifiedBy}` : ''}
                        {people.verifiedAt ? `, ${capturedLabel(people.verifiedAt)}` : ''}
                      </span>
                    ) : dirty ? (
                      <span className="font-medium text-gold">Changed — save to verify</span>
                    ) : people.stage === 'quick' && result?.counting ? (
                      <span className="font-medium text-gold">
                        Quick estimate · thorough scan running…
                      </span>
                    ) : (
                      <span className="font-medium text-gold">AI estimate, not verified yet</span>
                    )}
                    <span className="block text-dark-muted">
                      AI counted {people.aiCount}
                      {possible > 0 ? ` · ${possible} possible` : ''}
                      {toCheck > 0 ? ` · ${toCheck} to check` : ''}
                      {added > 0 ? ` · ${added} added by hand` : ''}
                    </span>
                  </>
                )}
                {phase === 'idle' && result && !result.available && !people && (
                  <span className="text-dark-muted">
                    People counting is not installed on this server. An administrator can add it
                    with <code className="font-mono">pnpm models:fetch</code>.
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="dark"
                  type="button"
                  onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)] ?? 1)}
                  disabled={zoom === ZOOMS[0]}
                  aria-label="Zoom out"
                >
                  <Icon name="minus" />
                </Button>
                <span className="w-[42px] text-center font-mono text-[10px] tabular-nums text-dark-muted">
                  {Math.round(zoom * 100)}%
                </span>
                <Button
                  variant="dark"
                  type="button"
                  onClick={() =>
                    setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)] ?? z)
                  }
                  disabled={zoom === ZOOMS[ZOOMS.length - 1]}
                  aria-label="Zoom in"
                >
                  <Icon name="plus" />
                </Button>
                <Button
                  variant="dark"
                  type="button"
                  aria-pressed={showBoxes}
                  onClick={() => setShowBoxes((value) => !value)}
                  disabled={!people}
                >
                  Boxes
                </Button>
              </div>
            </div>

            {people && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10.5px] text-dark-muted">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-[11px] rounded-[50%] border-2 border-on-gold bg-gold" />
                  Counted
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-[11px] rounded-[50%] border-2 border-dark-live bg-gold" />
                  Counted, check it
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-[11px] rounded-[50%] border-2 border-dashed border-white" />
                  Possible, not counted
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-[11px] rounded-[50%] border-2 border-white bg-pine" />
                  Added by hand
                </span>
              </div>
            )}

            {canEdit && (
              <p className="m-0 text-[11px] leading-[1.5] text-dark-muted">
                The AI count is an estimate. Click a mark to remove it or to count a possible
                person, click anyone without a mark to add them, then save. Every person should end
                up with exactly one filled mark.
              </p>
            )}

            {notice && (
              <p className="m-0 text-[11.5px] text-[var(--capture-ok)]" role="status">
                {notice}
              </p>
            )}

            {newer && (
              <div
                className="flex flex-wrap items-center gap-2 rounded-sm border border-gold px-2.5 py-1.5 text-[11.5px]"
                role="status"
              >
                <span className="min-w-0 flex-1">
                  The thorough scan finished: {newer.people?.aiCount ?? 0} counted. Your changes are
                  not saved yet.
                </span>
                <Button
                  variant="darkGold"
                  type="button"
                  onClick={() => {
                    apply(newer)
                    setNewer(null)
                    setNotice('Updated with the thorough scan.')
                  }}
                >
                  Use thorough result
                </Button>
                <Button variant="dark" type="button" onClick={() => setNewer(null)}>
                  Keep mine
                </Button>
              </div>
            )}

            {error && (
              <p className="m-0 text-[11.5px] text-dark-live" role="alert">
                {error}
              </p>
            )}

            {people && (
              <div className="flex flex-wrap items-center gap-1.5">
                {result?.canVerify && (
                  <>
                    <Button
                      variant="dark"
                      type="button"
                      onClick={() => {
                        const previous = history[history.length - 1]
                        if (!previous) return
                        setHistory(history.slice(0, -1))
                        setDraft(previous)
                      }}
                      disabled={!canEdit || history.length === 0}
                    >
                      Undo
                    </Button>
                    <Button
                      variant="dark"
                      type="button"
                      onClick={() =>
                        edit(() => ({
                          accepted: detections.map((detection) => detection.counted),
                          manual: [],
                        }))
                      }
                      disabled={!canEdit}
                    >
                      Reset to AI
                    </Button>
                  </>
                )}
                <Button variant="dark" type="button" onClick={rerun} disabled={busy}>
                  <Icon name="refresh" />
                  Count again
                </Button>
                {result?.canVerify && (
                  <Button
                    variant="darkGold"
                    type="button"
                    className="ml-auto"
                    onClick={() => void save()}
                    disabled={!canEdit || (verified && !dirty)}
                    data-testid="people-save"
                  >
                    <Icon name="check" />
                    {verified ? 'Verified' : `Save verified count (${total})`}
                  </Button>
                )}
              </div>
            )}
          </section>
        )}

        <div
          className="shrink-0 overflow-auto overscroll-contain rounded-sm border border-dark-line bg-[var(--focus-frame-bg)]"
          style={{ maxHeight: `calc${frameHeight}` }}
        >
          <div
            ref={frameRef}
            className={`relative mx-auto ${canEdit ? 'cursor-crosshair' : ''}`}
            style={{
              width: `calc(min(100%, ${frameHeight} * ${ratio}) * ${zoom})`,
              aspectRatio: String(ratio),
            }}
            onClick={canEdit ? addAt : undefined}
            data-testid="people-frame"
          >
            {!fullReady && !thumbFailed && (
              <img
                className="absolute inset-0 block size-full select-none"
                src={screenshotThumbUrl(shot.id)}
                alt=""
                aria-hidden="true"
                draggable={false}
                data-testid="people-frame-preview"
                onError={() => setThumbFailed(true)}
              />
            )}
            <img
              className="block size-full select-none"
              src={screenshotImageUrl(shot.id)}
              alt={shot.filename}
              draggable={false}
              data-testid="people-frame-full"
              onLoad={(event) => {
                const image = event.currentTarget
                if (image.naturalWidth && image.naturalHeight) {
                  setRatio(image.naturalWidth / image.naturalHeight)
                }
                setFullReady(true)
              }}
            />

            {peopleOpen && draft && (
              <div className="absolute inset-0" data-testid="people-marks">
                {showBoxes &&
                  detections.map((detection, index) =>
                    draft.accepted[index] ? (
                      <span
                        key={`box-${index}`}
                        className="pointer-events-none absolute border border-gold"
                        style={{
                          left: `${detection.x * 100}%`,
                          top: `${detection.y * 100}%`,
                          width: `${detection.w * 100}%`,
                          height: `${detection.h * 100}%`,
                        }}
                      />
                    ) : null,
                  )}
                {detections.map((detection, index) => {
                  const { x, y } = centre(detection)
                  const on = draft.accepted[index] ?? false
                  const style = on
                    ? detection.score < CHECK_BELOW
                      ? 'border-dark-live bg-gold'
                      : 'border-on-gold bg-gold'
                    : 'border-dashed border-white bg-transparent opacity-80'
                  return (
                    <button
                      key={`ai-${index}`}
                      type="button"
                      className={`absolute size-[14px] rounded-[50%] border-2 p-0 [transform:translate(-50%,-50%)] ${style} ${
                        canEdit ? 'cursor-pointer hover:scale-125' : 'cursor-default'
                      }`}
                      style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
                      title={`${on ? 'Counted' : 'Possible person'} · AI confidence ${Math.round(
                        detection.score * 100,
                      )}%`}
                      aria-label={`${on ? 'Counted' : 'Possible'} person ${index + 1}, confidence ${Math.round(detection.score * 100)}%`}
                      aria-pressed={on}
                      data-people-mark={on ? 'counted' : 'possible'}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleDetection(index)
                      }}
                    />
                  )
                })}
                {draft.manual.map((mark, index) => (
                  <button
                    key={`manual-${index}`}
                    type="button"
                    className={`absolute size-[14px] rounded-[50%] border-2 border-white bg-pine p-0 [transform:translate(-50%,-50%)] ${
                      canEdit ? 'cursor-pointer hover:scale-125' : 'cursor-default'
                    }`}
                    style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%` }}
                    title="Added by hand · click to remove"
                    aria-label={`Person added by hand ${index + 1}`}
                    data-people-mark="manual"
                    onClick={(event) => {
                      event.stopPropagation()
                      edit((current) => ({
                        ...current,
                        manual: current.manual.filter((_, i) => i !== index),
                      }))
                    }}
                  />
                ))}
              </div>
            )}

            {peopleOpen && (phase === 'counting' || phase === 'loading') && (
              <div className="absolute inset-0 grid place-items-center bg-[var(--tile-notice-bg)]">
                <div className="flex items-center gap-2.5 text-[12px] text-dark-text">
                  <Spinner tone="dark" />
                  {phase === 'counting' ? 'Counting people…' : 'Loading…'}
                </div>
              </div>
            )}
          </div>
        </div>

        <Metadata shot={shot} />
      </div>
    </div>
  )
}
