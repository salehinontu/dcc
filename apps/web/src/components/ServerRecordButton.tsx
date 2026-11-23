import { useEffect, useState } from 'react'
import { api } from '../api'
import { useServerRecordings, useServerRecordingsWatch } from '../serverRecordings'
import { cn } from '../ui/cn'
import Icon from './Icon'

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}

/** Time since the ISO instant `since`, ticking once a second. */
function useElapsedSince(since: string | undefined): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!since) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [since])
  return since ? formatElapsed(Math.max(0, now - Date.parse(since))) : ''
}

/** Start or stop this drone's recording on the server; the one place that does it. */
function useServerRecord(sn: string, onError: (text: string) => void) {
  const mine = useServerRecordings((state) => state.bySn[sn])
  const refresh = useServerRecordings((state) => state.refresh)
  const [busy, setBusy] = useState(false)

  async function toggle() {
    setBusy(true)
    try {
      if (mine) await api.stopServerRecording(sn)
      else await api.startServerRecording(sn)
      await refresh()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return { mine, busy, toggle, auto: mine?.mode === 'continuous' }
}

/**
 * Record this drone's feed on the server, for the Recordings screen. It is separate from the
 * "On this computer" button beside it, which saves a file on this computer and uploads nothing: this one
 * keeps going when the tab is closed, and everyone allowed to see recordings can find it later.
 */
export function ServerRecordButton({
  sn,
  live,
  allowed,
  onError,
}: {
  sn: string
  live: boolean
  allowed: boolean
  onError: (text: string) => void
}) {
  useServerRecordingsWatch(allowed)
  const { mine, busy, toggle, auto } = useServerRecord(sn, onError)
  const recording = mine !== undefined

  if (!allowed) return null

  const shape =
    'inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-[11px] text-[11px] font-medium transition-[background] [&_svg]:size-[13px] disabled:cursor-not-allowed disabled:opacity-[0.42] until-phone-lg:px-2'

  return (
    <button
      className={cn(
        shape,
        recording
          ? 'border-[var(--rec)] bg-[var(--rec-bg)] text-[var(--rec-text)]'
          : 'border-dark-line bg-dark-raised text-dark-text hover:border-[var(--dark-btn-hover-border)] hover:bg-[var(--dark-btn-hover-bg)]',
      )}
      data-parity="focus-server-record"
      data-testid="focus-server-record"
      data-recording={recording ? 'true' : undefined}
      type="button"
      disabled={busy || auto || (!recording && !live)}
      onClick={() => void toggle()}
      title={
        auto
          ? 'This drone records automatically. Turn that off under Recordings to stop it.'
          : recording
            ? 'Stop recording on the server'
            : 'Record this feed on the server; find it later under Recordings'
      }
    >
      <Icon
        name={recording ? 'stop' : 'record'}
        className={recording ? undefined : 'text-[var(--rec)]'}
      />
      <span className="until-narrow:hidden">
        {auto ? 'Recording automatically' : recording ? 'Stop server rec' : 'Record to server'}
      </span>
    </button>
  )
}

const recDot = 'size-2 flex-none rounded-full animate-rec motion-reduce:animate-none'

/**
 * The record control on a wall tile. REC records on the SERVER (kept under Recordings, it carries on when the
 * tab is closed); the button beside it, from RecordControls, records on this computer. While recording it stays
 * on screen with the running time; pressing it again stops. A drone set to record automatically shows "Auto"
 * and cannot be stopped from here.
 */
export function TileServerRecordButton({
  sn,
  label,
  live,
  allowed,
}: {
  sn: string
  label: string
  live: boolean
  allowed: boolean
}) {
  const [error, setError] = useState('')
  const { mine, busy, toggle, auto } = useServerRecord(sn, (text) => {
    setError(text)
    window.setTimeout(() => setError(''), 6000)
  })
  const elapsed = useElapsedSince(mine?.startedAt)
  if (!allowed || (!mine && !live)) return null

  const problem = error ? (
    <span
      className="pointer-events-none absolute bottom-full right-0 z-[6] mb-1.5 w-max max-w-[240px] rounded-sm bg-[var(--tile-notice-bg)] px-2 py-1 text-[11px] text-[var(--tile-text)]"
      role="alert"
    >
      {error}
    </span>
  ) : null

  if (mine) {
    const chip =
      'inline-flex h-[30px] items-center gap-1.5 rounded-sm bg-[var(--rec-bg)] px-2 font-mono text-[10.5px] font-medium tabular-nums text-[var(--rec-text)] focus-visible:outline-2 focus-visible:outline-dark-pine [&_svg]:size-3'
    const body = (
      <>
        <span className={cn(recDot, 'bg-[var(--rec-text)]')} aria-hidden="true" />
        <span>
          {auto
            ? 'Auto'
            : mine.state === 'waiting'
              ? 'Waiting'
              : mine.state === 'paused'
                ? 'Paused'
                : elapsed}
        </span>
        <span className="font-sans text-[9px] uppercase tracking-[0.08em] opacity-80">Server</span>
        {!auto && <Icon name="stop" />}
      </>
    )
    return (
      <span className="relative" data-testid="tile-server-record-wrap">
        {problem}
        {auto ? (
          <span
            className={chip}
            data-testid="tile-server-record"
            data-recording="true"
            title="This drone records automatically on the server. Turn that off under Recordings to stop it."
          >
            {body}
          </span>
        ) : (
          <button
            className={chip}
            data-parity={`tile-server-record-${sn}`}
            data-testid="tile-server-record"
            data-recording="true"
            type="button"
            disabled={busy}
            onClick={() => void toggle()}
            aria-label={`Stop the server recording of ${label}`}
            title="Stop recording on the server"
          >
            {body}
          </button>
        )}
      </span>
    )
  }

  return (
    <span className="relative" data-testid="tile-server-record-wrap">
      {problem}
      <button
        className="inline-flex h-[30px] items-center gap-1.5 rounded-sm bg-[var(--tile-control-bg)] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--tile-control-text)] opacity-0 backdrop-blur-[8px] transition-opacity focus-visible:outline-2 focus-visible:outline-dark-pine group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100 disabled:cursor-wait [&_svg]:size-3"
        data-parity={`tile-server-record-${sn}`}
        data-testid="tile-server-record"
        type="button"
        disabled={busy}
        onClick={() => void toggle()}
        aria-label={`Record ${label} on the server`}
        title="Record on the server. You will find it under Recordings."
      >
        <Icon name="record" className="text-[var(--rec)]" />
        <span>Rec</span>
      </button>
    </span>
  )
}
