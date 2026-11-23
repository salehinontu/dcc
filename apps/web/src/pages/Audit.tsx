import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  AUDIT_OUTCOMES,
  auditActionLabel,
  type AuditEvent,
  type AuditFilter,
  type AuditOutcome,
} from '@dji/protocol'
import { api, auditExportUrl, type User } from '../api'
import Icon from '../components/Icon'
import StageBar from '../components/StageBar'
import Badge, { type BadgeTone } from '../ui/Badge'
import Button, { ButtonLink } from '../ui/Button'
import Notice from '../ui/Notice'
import { cn } from '../ui/cn'
import { emptyPanel, filterControl, filterLabel, screenBody, td, th } from '../ui/surface'

const PAGE = 50

const stamp = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

const CATEGORY_LABELS: Record<string, string> = {
  auth: 'Sign-in and passwords',
  pilot: 'Controller sign-in',
  user: 'Accounts',
  controller: 'Controllers',
  drone: 'Drones',
  video_source: 'Video-only drones',
  stream: 'Live feeds',
  screenshot: 'Screenshots',
  recording: 'Recordings',
  zone: 'Zones and geofences',
  alert: 'Alerts',
  audit: 'The audit log itself',
  cli: 'Server console',
  request: 'Other changes',
}

const OUTCOME_TONES: Record<AuditOutcome, BadgeTone> = {
  success: 'ok',
  failure: 'pending',
  denied: 'danger',
}
const OUTCOME_LABELS: Record<AuditOutcome, string> = {
  success: 'Done',
  failure: 'Failed',
  denied: 'Refused',
}

/** A `datetime-local` value is in the browser's own time zone; the server wants an instant. */
function toIso(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** What an event did in plain lines, for the shapes people ask about; anything else is shown as it was recorded. */
function describe(event: AuditEvent): string[] {
  const details = event.details as Record<string, unknown> | null
  if (!details) return []
  const lines: string[] = []
  const changes = details.changes as Record<string, unknown> | undefined
  if (changes) {
    for (const [key, value] of Object.entries(changes)) {
      if (key === 'permissionsAdded') lines.push(`Gained: ${(value as string[]).join(', ')}`)
      else if (key === 'permissionsRemoved') lines.push(`Lost: ${(value as string[]).join(', ')}`)
      else if (key === 'droneAccessChanged') lines.push('The drones it may use were changed')
      else if (key === 'passwordReset') lines.push('Its password was reset')
      else if (Array.isArray(value)) lines.push(`${key}: ${String(value[0])} → ${String(value[1])}`)
    }
  }
  return lines
}

export default function Audit({
  user,
  railOpen,
  onOpenRail,
}: {
  user: User
  railOpen: boolean
  onOpenRail: (trigger: HTMLButtonElement) => void
}) {
  // The Users screen opens this one for a single account with ?actor=<email>.
  const initial = useMemo(() => new URLSearchParams(window.location.search), [])
  const [actor, setActor] = useState(initial.get('actor') ?? '')
  const [category, setCategory] = useState(initial.get('category') ?? '')
  const [outcome, setOutcome] = useState<AuditOutcome | ''>(
    (AUDIT_OUTCOMES as readonly string[]).includes(initial.get('outcome') ?? '')
      ? (initial.get('outcome') as AuditOutcome)
      : '',
  )
  const [search, setSearch] = useState(initial.get('q') ?? '')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [typed, setTyped] = useState({
    actor: initial.get('actor') ?? '',
    q: initial.get('q') ?? '',
  })
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [total, setTotal] = useState(0)
  const [categories, setCategories] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  // Deleting lines is the Developer's alone (the server refuses anyone else).
  const mayDelete = user.role === 'developer'
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  // Every line the filter matches, not only the ones on the screen.
  const [allMatching, setAllMatching] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState('')

  // The words typed in the two text boxes are applied a moment after typing stops.
  useEffect(() => {
    const timer = window.setTimeout(() => setTyped({ actor: actor.trim(), q: search.trim() }), 300)
    return () => window.clearTimeout(timer)
  }, [actor, search])

  const filter: AuditFilter = useMemo(
    () => ({
      actor: typed.actor || undefined,
      q: typed.q || undefined,
      category: category || undefined,
      outcome: outcome || undefined,
      from: toIso(from),
      to: toIso(to),
    }),
    [typed, category, outcome, from, to],
  )
  const filtered = Boolean(typed.actor || typed.q || category || outcome || from || to)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    api
      .audit({ ...filter, limit: PAGE, offset: 0 })
      .then((page) => {
        if (cancelled) return
        setEvents(page.events)
        setTotal(page.total)
        setCategories(page.categories)
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [filter, tick])

  const loadMore = useCallback(async () => {
    setLoading(true)
    try {
      const page = await api.audit({ ...filter, limit: PAGE, offset: events.length })
      setEvents((current) => [...current, ...page.events])
      setTotal(page.total)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [filter, events.length])

  const more = events.length < total
  // The record of an earlier deletion stays: a deletion always leaves its trace.
  const pickable = useCallback((event: AuditEvent) => event.action !== 'audit.deleted', [])
  const deletable = useMemo(() => events.filter(pickable), [events, pickable])
  const chosen = useMemo(() => events.filter((event) => picked.has(event.seq)), [events, picked])
  const everyShownPicked = deletable.length > 0 && chosen.length === deletable.length
  const count = allMatching ? total : chosen.length

  function toggle(seq: number) {
    setAllMatching(false)
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }

  function endSelecting() {
    setSelecting(false)
    setPicked(new Set())
    setAllMatching(false)
  }

  async function deletePicked() {
    if (count === 0) return
    const what = allMatching
      ? `all ${total.toLocaleString()} lines that match the filter (not only the ones shown)`
      : `${count.toLocaleString()} line${count === 1 ? '' : 's'}`
    const sure = window.confirm(
      `Delete ${what} for good?\nWho, what and where from are removed and cannot be restored. A note that lines were deleted stays in the log, visible to Developers only.`,
    )
    if (!sure) return
    setDeleting(true)
    setError('')
    setNotice('')
    try {
      const result = await api.auditDelete(
        allMatching ? { all: true, filter } : { seqs: chosen.map((event) => event.seq) },
      )
      setNotice(
        `Deleted ${result.deleted.toLocaleString()} line${result.deleted === 1 ? '' : 's'}.`,
      )
      endSelecting()
      setTick((n) => n + 1)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <StageBar
        bar="audit"
        title="Audit log"
        summary={`${total.toLocaleString()} event${total === 1 ? '' : 's'}${filtered ? ' match' : ''}`}
        actions={
          <>
            <ButtonLink
              variant="secondary"
              href={auditExportUrl(filter, 'csv')}
              download
              data-testid="audit-export-csv"
              title="Download the events on this screen's filter as a spreadsheet file"
            >
              <Icon name="download" />
              <span>Export CSV</span>
            </ButtonLink>
            <ButtonLink
              variant="secondary"
              href={auditExportUrl(filter, 'json')}
              download
              data-testid="audit-export-json"
              title="Download the same events as JSON, with the chain's head hash"
            >
              <Icon name="download" />
              <span>JSON</span>
            </ButtonLink>
          </>
        }
        railOpen={railOpen}
        onOpenRail={onOpenRail}
      />
      <div className={screenBody} data-testid="audit-screen">
        <div className="mb-4" role="group" aria-label="Filter the audit log">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] items-end gap-2.5">
            <label className={filterLabel}>
              <span>Account</span>
              <input
                className={cn(filterControl, 'w-full')}
                type="search"
                value={actor}
                placeholder="Email: its actions and what was done to it"
                data-testid="audit-actor"
                onChange={(event) => setActor(event.target.value)}
              />
            </label>
            <label className={filterLabel}>
              <span>What</span>
              <select
                className={cn(filterControl, 'w-full')}
                value={category}
                data-testid="audit-category"
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">Everything</option>
                {[...new Set([...categories, ...(category ? [category] : [])])].map((code) => (
                  <option key={code} value={code}>
                    {CATEGORY_LABELS[code] ?? code}
                  </option>
                ))}
              </select>
            </label>
            <label className={filterLabel}>
              <span>Result</span>
              <select
                className={cn(filterControl, 'w-full')}
                value={outcome}
                data-testid="audit-outcome"
                onChange={(event) => setOutcome(event.target.value as AuditOutcome | '')}
              >
                <option value="">Any</option>
                {AUDIT_OUTCOMES.map((code) => (
                  <option key={code} value={code}>
                    {OUTCOME_LABELS[code]}
                  </option>
                ))}
              </select>
            </label>
            <label className={filterLabel}>
              <span>Search</span>
              <input
                className={cn(filterControl, 'w-full')}
                type="search"
                value={search}
                placeholder="Name, address, anything"
                data-testid="audit-search"
                onChange={(event) => setSearch(event.target.value)}
              />
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
                data-testid="audit-from"
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
                data-testid="audit-to"
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
            {filtered && (
              <Button
                variant="secondary"
                type="button"
                onClick={() => {
                  setActor('')
                  setSearch('')
                  setTyped({ actor: '', q: '' })
                  setCategory('')
                  setOutcome('')
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
              onClick={() => setTick((n) => n + 1)}
              data-testid="audit-refresh"
            >
              <Icon name="refresh" />
              <span>Refresh</span>
            </Button>
            {mayDelete && !selecting && deletable.length > 0 && (
              <Button
                variant="secondary"
                type="button"
                onClick={() => setSelecting(true)}
                data-testid="audit-select"
              >
                <Icon name="check" />
                <span>Select</span>
              </Button>
            )}
          </div>
        </div>

        {selecting && (
          <div
            className="mb-3.5 flex flex-wrap items-center gap-2.5 rounded-md border border-line bg-pine-wash px-3 py-2"
            data-testid="audit-select-bar"
          >
            <span className="text-[12px] font-medium text-ink-2">
              {count === 0
                ? 'Tick the lines to delete'
                : allMatching
                  ? `All ${total.toLocaleString()} lines that match the filter`
                  : `${count.toLocaleString()} selected`}
            </span>
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setAllMatching(false)
                setPicked(everyShownPicked ? new Set() : new Set(deletable.map((e) => e.seq)))
              }}
            >
              {everyShownPicked ? 'Clear' : `Select all ${deletable.length.toLocaleString()} shown`}
            </Button>
            {everyShownPicked && more && !allMatching && (
              <Button
                variant="secondary"
                type="button"
                onClick={() => setAllMatching(true)}
                data-testid="audit-select-all-matching"
              >
                {`Select all ${total.toLocaleString()} that match`}
              </Button>
            )}
            <Button
              variant="secondary"
              type="button"
              disabled={count === 0 || deleting}
              onClick={() => void deletePicked()}
              data-testid="audit-delete-selected"
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
          <div data-testid="audit-notice">
            <Notice tone="success" className="mb-3.5" onDismiss={() => setNotice('')}>
              {notice}
            </Notice>
          </div>
        )}

        {error && (
          <Notice tone="error" className="mb-3.5" onDismiss={() => setError('')}>
            {error}
          </Notice>
        )}

        {!loading && events.length === 0 ? (
          <div className={emptyPanel}>
            <div>
              <h2 className="mb-1.5 mt-0 text-[15px] font-semibold">
                {filtered ? 'No events match' : 'Nothing has been recorded yet'}
              </h2>
              <p className="m-0 max-w-[48ch] text-[12.5px] leading-[1.6] text-ink-3">
                {filtered
                  ? 'Try a wider date range, fewer filters, or a different word.'
                  : 'Events appear here as people sign in and change things.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-white [box-shadow:var(--shadow-card)]">
            <table className="w-full min-w-[820px] border-collapse" data-testid="audit-table">
              <thead>
                <tr>
                  {selecting && (
                    <th className={th}>
                      <span className="sr-only">Select</span>
                    </th>
                  )}
                  <th className={th}>Time</th>
                  <th className={th}>Account</th>
                  <th className={th}>What</th>
                  <th className={th}>Done to</th>
                  <th className={th}>Result</th>
                  <th className={th}>From</th>
                  <th className={th}>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => {
                  const lines = describe(event)
                  const shown = open === event.seq
                  return (
                    <Fragment key={event.seq}>
                      <tr
                        className={cn(
                          'hover:bg-pine-wash',
                          (shown || picked.has(event.seq) || allMatching) && 'bg-pine-wash',
                        )}
                        data-testid="audit-row"
                        data-action={event.action}
                        data-outcome={event.outcome}
                      >
                        {selecting && (
                          <td className={td}>
                            {pickable(event) && (
                              <input
                                type="checkbox"
                                className="size-4 cursor-pointer accent-[var(--pine)]"
                                checked={allMatching || picked.has(event.seq)}
                                onChange={() => toggle(event.seq)}
                                aria-label={`Select event no. ${event.seq}`}
                                data-testid="audit-check"
                              />
                            )}
                          </td>
                        )}
                        <td className={cn(td, 'whitespace-nowrap font-mono text-[11px]')}>
                          {stamp.format(new Date(event.time))}
                        </td>
                        <td className={td}>
                          <span
                            className="block max-w-[26ch] truncate font-medium"
                            title={event.actorEmail ?? ''}
                          >
                            {event.actorEmail ?? 'Not signed in'}
                          </span>
                          {event.actorRole && (
                            <span className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-3">
                              {event.actorRole}
                            </span>
                          )}
                        </td>
                        <td className={td}>
                          <span className="block">{auditActionLabel(event.action)}</span>
                          <span className="font-mono text-[10px] text-ink-3">{event.action}</span>
                        </td>
                        <td className={td}>
                          {event.targetLabel || event.targetId ? (
                            <>
                              <span
                                className="block max-w-[26ch] truncate"
                                title={event.targetLabel ?? event.targetId ?? ''}
                              >
                                {event.targetLabel ?? event.targetId}
                              </span>
                              {event.targetType && (
                                <span className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-3">
                                  {event.targetType}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                        <td className={td}>
                          <Badge tone={OUTCOME_TONES[event.outcome]}>
                            {OUTCOME_LABELS[event.outcome]}
                            {event.status ? ` · ${event.status}` : ''}
                          </Badge>
                        </td>
                        <td
                          className={cn(td, 'whitespace-nowrap font-mono text-[11px] text-ink-2')}
                        >
                          {event.ip ?? '—'}
                        </td>
                        <td className={cn(td, 'text-right')}>
                          <button
                            type="button"
                            className="cursor-pointer rounded-sm border-0 bg-transparent px-1.5 py-1 text-[11.5px] font-medium text-pine-strong hover:underline"
                            aria-expanded={shown}
                            data-testid="audit-details"
                            onClick={() => setOpen(shown ? null : event.seq)}
                          >
                            {shown ? 'Hide' : 'Details'}
                          </button>
                        </td>
                      </tr>
                      {shown && (
                        <tr data-testid="audit-detail-row">
                          <td
                            colSpan={selecting ? 8 : 7}
                            className="border-b border-line-soft bg-surface-2 px-4 py-3"
                          >
                            {lines.length > 0 && (
                              <ul className="m-0 mb-2 list-disc pl-5 text-[12.5px]">
                                {lines.map((line) => (
                                  <li key={line}>{line}</li>
                                ))}
                              </ul>
                            )}
                            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
                              <dt className="text-ink-3">Event no.</dt>
                              <dd className="m-0 font-mono">{event.seq}</dd>
                              <dt className="text-ink-3">Target id</dt>
                              <dd className="m-0 break-all font-mono">{event.targetId ?? '—'}</dd>
                              <dt className="text-ink-3">Browser</dt>
                              <dd className="m-0 break-all">{event.userAgent ?? '—'}</dd>
                              <dt className="text-ink-3">Hash</dt>
                              <dd className="m-0 break-all font-mono text-[10.5px]">
                                {event.hash}
                              </dd>
                            </dl>
                            {event.details && (
                              <pre className="m-0 mt-2 overflow-x-auto rounded-md border border-line bg-white p-2.5 font-mono text-[11px] leading-[1.5]">
                                {JSON.stringify(event.details, null, 2)}
                              </pre>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {loading && <p className="mt-4 text-center text-[12px] text-ink-3">Loading events…</p>}
        {more && !loading && (
          <div className="flex justify-center pt-[18px]">
            <Button variant="secondary" type="button" onClick={() => void loadMore()}>
              Load more events
            </Button>
          </div>
        )}
      </div>
    </>
  )
}
