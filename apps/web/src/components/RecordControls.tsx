import { useEffect, useState } from 'react'
import {
  chooseRecordingFolder,
  folderSupported,
  loadRecordingFolder,
  recordingSupported,
  startRecording,
  stopRecording,
  useRecordings,
  type RecordingSession,
} from '../recorder'
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

/** Time since `since`, ticking once a second while there is one. */
function useElapsed(since: number | undefined): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === undefined) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [since])
  return since === undefined ? '' : formatElapsed(Math.max(0, now - since))
}

const recDot = 'size-2 flex-none rounded-full animate-rec motion-reduce:animate-none'

/**
 * The "record on this computer" control on a wall tile, beside the server's REC button: shown on hover while the
 * feed is live, and kept on screen with the running time while it records. Clicking it again stops and saves the
 * file on this computer; nothing is uploaded.
 */
export function TileRecordButton({
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
  const session = useRecordings((state) => state.sessions[sn])
  const elapsed = useElapsed(session?.startedAt)
  if (!recordingSupported || !allowed || (!session && !live)) return null

  if (session) {
    return (
      <button
        className="inline-flex h-[30px] items-center gap-1.5 rounded-sm bg-[var(--rec-bg)] px-2 font-mono text-[10.5px] font-medium tabular-nums text-[var(--rec-text)] focus-visible:outline-2 focus-visible:outline-dark-pine [&_svg]:size-3"
        data-parity={`tile-record-${sn}`}
        data-testid="tile-record"
        data-recording="true"
        type="button"
        onClick={() => stopRecording(sn)}
        aria-label={`Stop recording ${label}`}
        title="Stop recording and save the file"
      >
        <span className={cn(recDot, 'bg-[var(--rec-text)]')} aria-hidden="true" />
        <span>{session.waiting ? 'Waiting' : elapsed}</span>
        <Icon name="laptop" />
        <Icon name="stop" />
      </button>
    )
  }

  return (
    <button
      className="inline-flex h-[30px] items-center gap-1.5 rounded-sm bg-[var(--tile-control-bg)] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--tile-control-text)] opacity-0 backdrop-blur-[8px] transition-opacity focus-visible:outline-2 focus-visible:outline-dark-pine group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100 [&_svg]:size-3.5"
      data-parity={`tile-record-${sn}`}
      data-testid="tile-record"
      type="button"
      onClick={() => void startRecording(sn, label)}
      aria-label={`Record ${label} on this computer`}
      title="Record on this computer: saves a file here, uploads nothing"
    >
      <Icon name="laptop" />
    </button>
  )
}

/** Record and Stop in the focus view's top bar, beside Capture. */
export function FocusRecordButton({
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
  const session = useRecordings((state) => state.sessions[sn])
  const elapsed = useElapsed(session?.startedAt)
  if (!recordingSupported || !allowed) return null

  const shape =
    'inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-[11px] text-[11px] font-medium transition-[background] [&_svg]:size-[13px] until-phone-lg:px-2'

  if (session) {
    return (
      <button
        className={cn(
          shape,
          'border-[var(--rec)] bg-[var(--rec-bg)] font-mono tabular-nums text-[var(--rec-text)]',
        )}
        data-parity="focus-record"
        data-testid="focus-record"
        data-recording="true"
        type="button"
        onClick={() => stopRecording(sn)}
        title="Stop recording and save the file"
      >
        <span className={cn(recDot, 'bg-[var(--rec-text)]')} aria-hidden="true" />
        <span>{session.waiting ? 'Waiting' : elapsed}</span>
        <Icon name="stop" />
        <span className="font-sans until-narrow:hidden">Stop</span>
      </button>
    )
  }

  return (
    <button
      className={cn(
        shape,
        'border-dark-line bg-dark-raised text-dark-text hover:border-[var(--dark-btn-hover-border)] hover:bg-[var(--dark-btn-hover-bg)] disabled:cursor-not-allowed disabled:opacity-[0.42]',
      )}
      data-parity="focus-record"
      data-testid="focus-record"
      type="button"
      disabled={!live}
      onClick={() => void startRecording(sn, label)}
      title="Record this feed on this computer: saves a file here, uploads nothing"
    >
      <Icon name="laptop" />
      <span className="until-narrow:hidden">On this computer</span>
    </button>
  )
}

function RecordingChip({ sn, session }: { sn: string; session: RecordingSession }) {
  const elapsed = useElapsed(session.startedAt)
  return (
    <button
      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-[999px] border border-[var(--rec)] bg-white px-2.5 text-[11.5px] font-medium text-ink transition-colors hover:bg-live-soft [&_svg]:size-[11px]"
      data-testid="recording-chip"
      type="button"
      onClick={() => stopRecording(sn)}
      aria-label={`Stop recording ${session.label}`}
      title="Stop recording and save the file"
    >
      <span className={cn(recDot, 'bg-[var(--rec)]')} aria-hidden="true" />
      <span className="max-w-[18ch] truncate">{session.label}</span>
      <span className="font-mono text-[10.5px] tabular-nums text-ink-2">
        {session.waiting ? 'waiting' : elapsed}
      </span>
      <Icon name="stop" />
    </button>
  )
}

/**
 * Wall toolbar: every recording in progress (also those whose tile is not on screen), the
 * folder recordings go to, and the last file saved.
 */
export function RecordingBar() {
  const sessions = useRecordings((state) => state.sessions)
  const folder = useRecordings((state) => state.folder)
  const notice = useRecordings((state) => state.notice)
  // Only notices raised while this toolbar is on screen are shown here.
  const [firstId] = useState(() => useRecordings.getState().notice?.id ?? 0)
  const [hiddenId, setHiddenId] = useState(0)

  useEffect(() => {
    void loadRecordingFolder()
  }, [])

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setHiddenId(notice.id), 8000)
    return () => window.clearTimeout(timer)
  }, [notice])

  if (!recordingSupported) return null
  const active = Object.entries(sessions)
  const shown = notice && notice.id > firstId && notice.id !== hiddenId ? notice : null

  return (
    <div
      className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5"
      data-parity="wall-recording"
    >
      {active.map(([sn, session]) => (
        <RecordingChip key={sn} sn={sn} session={session} />
      ))}
      {folderSupported && (
        <button
          className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-[999px] border border-line bg-white px-2.5 text-[11.5px] text-ink-2 transition-colors hover:border-pine hover:text-pine-strong [&_svg]:size-[13px]"
          data-testid="recording-folder"
          type="button"
          onClick={() => void chooseRecordingFolder()}
          title={
            folder
              ? 'Change the folder recordings are saved in'
              : 'Choose where recordings are saved'
          }
        >
          <Icon name="folder" />
          {folder ? (
            <span className="truncate">
              On this computer: <span className="font-medium text-ink">{folder}</span>
            </span>
          ) : (
            <span>Choose folder for recordings on this computer</span>
          )}
        </button>
      )}
      {shown && (
        <span
          className={cn(
            'w-full text-right text-[11.5px] [overflow-wrap:anywhere]',
            shown.kind === 'error' ? 'text-live' : 'text-ink-2',
          )}
          data-testid="recording-notice"
          role={shown.kind === 'error' ? 'alert' : 'status'}
        >
          {shown.text}
        </span>
      )}
    </div>
  )
}
