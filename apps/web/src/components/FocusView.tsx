import { can } from '@dji/protocol'
import type { ScreenshotRecord } from '@dji/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type User } from '../api'
import { deviceLabel } from '../deviceSearch'
import { flightTimeLabel, formatCoord, metric, streamMeta } from '../format'
import { useRecordings } from '../recorder'
import { retry } from '../socket'
import { streamForDevice } from '../streamSelect'
import { useFleet } from '../store'
import { cn } from '../ui/cn'
import { useWatch } from '../useWatch'
import Button from '../ui/Button'
import Spinner from '../ui/Spinner'
import StatusPill from '../ui/StatusPill'
import Icon from './Icon'
import { FocusRecordButton } from './RecordControls'
import { ServerRecordButton } from './ServerRecordButton'
import ScreenshotViewer from './ScreenshotViewer'
import WhepPlayer from './WhepPlayer'

const QUALITY = [
  { value: 0, label: 'Auto' },
  { value: 1, label: 'Smooth' },
  { value: 2, label: 'SD' },
  { value: 3, label: 'HD' },
  { value: 4, label: 'UHD' },
]

type Mode = 'live' | 'starting' | 'offline' | 'error' | 'held' | 'no-camera'
type CaptureNotice = { kind: 'ok' | 'error'; text: string; shot?: ScreenshotRecord }

// Matches the server's SCREENSHOT_MAX_BYTES default; a JPEG frame is normally well under 2 MB.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

/** The current decoded frame of a playing <video> as a JPEG, at its native resolution. */
async function grabFrame(video: HTMLVideoElement): Promise<Blob> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
    throw new Error('No video frame yet. Wait for the picture to appear.')
  }
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot capture frames.')
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.92),
  )
  if (!blob) throw new Error('The frame could not be encoded.')
  return blob
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : ''
  try {
    const parsed = JSON.parse(raw) as { error?: string }
    if (parsed.error) return `Screenshot not saved: ${parsed.error}`
  } catch {
    // Not a JSON error body; fall through.
  }
  return raw ? `Screenshot not saved: ${raw}` : 'Screenshot not saved.'
}

function placeholderCopy(
  mode: Mode,
  error: string | null | undefined,
  reconnecting: boolean,
  isAdmin: boolean,
): { title: string; note: string } {
  if (mode === 'offline') {
    return {
      title: 'Drone offline',
      note: 'There is no live feed while the drone is offline. It starts when the drone reconnects.',
    }
  }
  if (mode === 'held') {
    return {
      title: 'Stopped by an administrator',
      note: isAdmin
        ? 'Resume the feed to start it for everyone watching this drone.'
        : 'An administrator stopped this feed. It starts again when they resume it.',
    }
  }
  if (mode === 'no-camera') {
    return {
      title: 'Waiting for camera information',
      note: 'The drone is online but has not reported a camera yet. Video starts as soon as it does.',
    }
  }
  if (mode === 'error') {
    return {
      title: 'Stream failed',
      note: error ?? 'The media server could not start this feed. Try again.',
    }
  }
  if (reconnecting) {
    return {
      title: 'Reconnecting',
      note: 'The media server lost the feed. Video returns as soon as the drone publishes again.',
    }
  }
  return {
    title: 'Waiting for video',
    note: 'The stream is starting. Video appears when the media server connects.',
  }
}

export default function FocusView({
  sn,
  user,
  backLabel,
  onClose,
}: {
  sn: string
  user: User
  backLabel: string
  onClose: () => void
}) {
  const device = useFleet((state) => state.devices[sn])
  const streams = useFleet((state) => state.streams)
  const [pendingQuality, setPendingQuality] = useState<number | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [notice, setNotice] = useState<CaptureNotice | null>(null)
  // A still opened from the capture notice to count the people in it.
  const [viewerShot, setViewerShot] = useState<ScreenshotRecord | null>(null)
  const [flash, setFlash] = useState(0)
  const recordingNotice = useRecordings((state) => state.notice)
  // Only recording notices raised while this view is open are shown in it.
  const [firstRecordingNotice] = useState(() => useRecordings.getState().notice?.id ?? 0)

  const rootRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const noticeTimer = useRef<number | undefined>(undefined)

  useWatch(can(user, 'streams.view', sn) ? [sn] : [])

  const videoOnly = device?.videoOnly ?? false
  // Quality, lens and stop belong to the controller; a video-only drone has none.
  const isAdmin = can(user, 'streams.control', sn) && !videoOnly
  const stream = streamForDevice(streams, sn)
  const telemetry = device?.telemetry
  const online = device?.online ?? false
  const held = stream?.phase === 'stopped' && stream.error === 'stopped by an administrator'
  const reconnecting = stream?.phase === 'starting' && stream.error === 'reconnecting'
  const noCamera = online && !stream && (device?.cameras.length ?? 0) === 0

  const mode: Mode = !online
    ? 'offline'
    : held
      ? 'held'
      : stream?.phase === 'live'
        ? 'live'
        : stream?.phase === 'error'
          ? 'error'
          : noCamera
            ? 'no-camera'
            : 'starting'

  const meta = streamMeta(device, stream)
  const quality = pendingQuality ?? stream?.quality ?? 2
  const copy = placeholderCopy(mode, stream?.error, reconnecting, isAdmin)
  const label = device ? deviceLabel(device) : 'Drone'
  const canRetry = mode === 'error'
  const canResume = mode === 'held' && isAdmin

  const close = useCallback(() => {
    onClose()
  }, [onClose])

  useEffect(() => {
    backRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The screenshot viewer on top handles its own keys, Escape included.
      if (viewerShot) return
      if (event.key === 'Escape') {
        close()
        return
      }

      if (event.key !== 'Tab') return
      const root = rootRef.current
      if (!root) return

      const items = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null)

      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [close, viewerShot])

  async function changeQuality(value: number) {
    if (!stream || !isAdmin) return
    setPendingQuality(value)
    try {
      await api.updateStream(stream.id, { quality: value })
      // The server broadcast carries the new value; failure simply reverts below.
    } catch {
      // keep the server's value
    } finally {
      setPendingQuality(null)
    }
  }

  function resumeFeed() {
    void api.adminResume(sn).catch(() => undefined)
  }

  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])

  const showNotice = useCallback((next: CaptureNotice) => {
    setNotice(next)
    window.clearTimeout(noticeTimer.current)
    // A notice that offers the people count stays long enough to reach the button.
    const ms = next.shot ? 12000 : next.kind === 'ok' ? 4000 : 7000
    noticeTimer.current = window.setTimeout(() => setNotice(null), ms)
  }, [])

  useEffect(() => {
    if (!recordingNotice || recordingNotice.sn !== sn || recordingNotice.id <= firstRecordingNotice)
      return
    showNotice({
      kind: recordingNotice.kind === 'saved' ? 'ok' : 'error',
      text: recordingNotice.text,
    })
  }, [recordingNotice, sn, firstRecordingNotice, showNotice])

  // Draw the frame on screen at the moment of the click, then upload it. The player keeps
  // running throughout; success is only reported once the server has stored the image.
  async function capture() {
    const video = videoRef.current
    if (!video || mode !== 'live' || capturing) return
    const capturedAt = new Date().toISOString()
    setCapturing(true)
    try {
      const frame = await grabFrame(video)
      setFlash((count) => count + 1)
      if (frame.size > MAX_UPLOAD_BYTES) throw new Error('the frame is larger than 8 MB')
      const { screenshot } = await api.uploadScreenshot(sn, frame, capturedAt)
      showNotice({ kind: 'ok', text: `Screenshot saved: ${screenshot.filename}`, shot: screenshot })
    } catch (error) {
      showNotice({ kind: 'error', text: errorText(error) })
    } finally {
      setCapturing(false)
    }
  }

  return (
    <div
      ref={rootRef}
      className="dark-shell fixed inset-0 z-50 flex h-full flex-col bg-dark-bg text-dark-text"
      data-parity="focus"
      data-testid="focus"
      role="dialog"
      aria-modal="true"
      aria-label={`${label} live feed`}
    >
      <div
        className="flex h-[60px] flex-none items-center gap-3 border-b border-b-dark-line bg-dark-surface px-[18px] until-stack:h-14 until-stack:gap-2 until-stack:px-4"
        data-parity="focus-bar"
      >
        <button
          ref={backRef}
          className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-transparent px-[9px] text-[11.5px] text-dark-muted transition-colors hover:bg-dark-raised hover:text-dark-text until-phone-lg:px-[7px]"
          data-parity="focus-back"
          data-testid="focus-back"
          type="button"
          aria-label={backLabel}
          onClick={close}
        >
          <Icon name="back" className="size-[15px]" />
          <span className="until-narrow:hidden">{backLabel}</span>
        </button>

        <div
          className="min-w-0 border-l border-l-dark-line pl-3 until-stack:pl-2"
          data-parity="focus-id"
        >
          <span
            className="block truncate text-[12.5px] font-medium until-phone-lg:text-[11.5px]"
            data-parity="focus-name"
          >
            {label}
          </span>
          <span
            className="mt-px block truncate font-mono text-[8.5px] tracking-[0.04em] text-dark-faint"
            data-parity="focus-sn"
          >
            {sn}
          </span>
        </div>

        <div
          className="ml-auto flex items-center gap-2.5 until-narrow:gap-[7px]"
          data-parity="focus-actions"
        >
          <ServerRecordButton
            sn={sn}
            live={mode === 'live'}
            allowed={can(user, 'recordings.record', sn)}
            onError={(text) => showNotice({ kind: 'error', text })}
          />

          <FocusRecordButton
            sn={sn}
            label={label}
            live={mode === 'live'}
            allowed={can(user, 'screenshots.capture', sn)}
          />

          <Button
            variant="dark"
            type="button"
            onClick={() => void capture()}
            disabled={mode !== 'live' || capturing || !can(user, 'screenshots.capture', sn)}
            title="Save the current frame to the server"
          >
            <Icon name="camera" />
            <span>{capturing ? 'Saving…' : 'Capture'}</span>
          </Button>

          {isAdmin && (
            <label
              className="inline-flex items-center gap-[7px] font-mono text-[8.5px] uppercase tracking-[0.07em] text-dark-faint"
              data-parity="quality-label"
            >
              <span className="until-stack:hidden">Quality</span>
              <select
                className="h-[30px] rounded-sm border border-dark-line bg-dark-raised py-0 pl-2 pr-6 font-mono text-[10px] text-dark-text outline-none disabled:cursor-not-allowed disabled:opacity-45 until-narrow:pr-[18px]"
                data-parity="quality-select"
                aria-label="Stream quality"
                value={quality}
                onChange={(event) => void changeQuality(Number(event.target.value))}
                disabled={!stream || mode !== 'live'}
              >
                {QUALITY.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <div
        className="grid min-h-0 flex-1 place-items-center p-[18px] until-stack:p-2.5"
        data-parity="focus-stage"
      >
        <div
          className="relative aspect-video w-[min(1180px,calc((100dvh_-_200px)_*_16_/_9),100%)] overflow-hidden border border-dark-line bg-[var(--focus-frame-bg)]"
          data-parity="focus-frame"
        >
          {mode === 'live' && stream ? (
            <div className="absolute inset-0" data-parity="focus-media">
              <WhepPlayer
                streamId={stream.id}
                className="absolute inset-0 size-full object-contain"
                variant="focus"
                videoRef={videoRef}
              />
              {flash > 0 && <div key={flash} data-decor="capture-flash" aria-hidden="true" />}
              <div data-decor="focus-scrim" data-parity="focus-scrim" aria-hidden="true" />
              <div
                className="pointer-events-none absolute inset-x-3 top-3 flex items-center justify-between gap-3"
                data-parity="focus-overlay-top"
              >
                <StatusPill tone="live" label="Live" data-parity="focus-live-pill" />
                <span
                  className="font-mono text-[8px] uppercase tracking-[0.09em] text-[var(--tile-quality-text)]"
                  data-parity="focus-quality"
                >
                  {meta.quality} / {meta.lens}
                </span>
              </div>
              <div
                className="pointer-events-none absolute bottom-3 left-[13px] font-mono text-[9px] tabular-nums tracking-[0.03em] text-[var(--tile-coord-text)]"
                data-parity="focus-coord"
              >
                {videoOnly ? 'Controlled in DJI Fly' : formatCoord(telemetry?.lat, telemetry?.lon)}
              </div>
              <div
                className="pointer-events-none absolute bottom-3 right-[13px] font-mono text-[8.5px] uppercase tracking-[0.08em] text-[var(--focus-camera-text)]"
                data-parity="focus-camera"
              >
                {meta.camera} / {meta.lens}
              </div>
            </div>
          ) : (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-6 text-center text-[12px] text-dark-muted"
              data-parity="focus-placeholder"
            >
              {mode === 'starting' && <Spinner />}
              <p
                className="m-0 text-[13px] font-medium text-dark-text"
                data-parity="focus-placeholder-title"
              >
                {copy.title}
              </p>
              <p className="m-0 max-w-[46ch] text-[10.5px] leading-[1.55] text-dark-faint">
                {copy.note}
              </p>
              {canRetry && (
                <Button
                  variant="dark"
                  className="mt-1.5"
                  data-parity="focus-retry"
                  type="button"
                  onClick={() => retry(sn)}
                >
                  <Icon name="refresh" />
                  Retry stream
                </Button>
              )}
              {canResume && (
                <Button
                  variant="dark"
                  className="mt-1.5"
                  data-parity="focus-resume"
                  type="button"
                  onClick={resumeFeed}
                >
                  <Icon name="play" />
                  Resume stream
                </Button>
              )}
            </div>
          )}
          {notice && (
            <div
              className={`absolute bottom-[14px] left-1/2 z-[7] inline-flex max-w-[calc(100%-28px)] items-center gap-2 rounded-md border bg-[var(--capture-notice-bg)] px-3 py-2 text-[12px] text-dark-text [overflow-wrap:anywhere] [transform:translateX(-50%)] ${
                notice.kind === 'ok' ? 'border-dark-line' : 'border-[var(--capture-error-border)]'
              }`}
              role={notice.kind === 'ok' ? 'status' : 'alert'}
            >
              <Icon
                name={notice.kind === 'ok' ? 'check' : 'alert'}
                className={`size-[15px] ${
                  notice.kind === 'ok' ? 'text-[var(--capture-ok)]' : 'text-dark-live'
                }`}
              />
              <span>{notice.text}</span>
              {notice.shot && can(user, 'screenshots.view', sn) && (
                <Button
                  variant="darkGold"
                  type="button"
                  className="ml-1 flex-none"
                  onClick={() => {
                    setViewerShot(notice.shot ?? null)
                    setNotice(null)
                  }}
                  data-testid="capture-people"
                >
                  <Icon name="users" />
                  Count people
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <div
        className="flex min-h-[72px] flex-none items-stretch gap-5 border-t border-t-dark-line bg-dark-surface px-[18px] until-stack:min-h-0 until-stack:flex-wrap until-stack:gap-2.5 until-stack:px-4 until-stack:py-2.5"
        data-parity="focus-foot"
      >
        <div
          className={cn(
            'flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*+*]:border-l [&>*+*]:border-l-dark-line until-stack:w-full until-stack:overflow-visible',
            videoOnly && 'hidden',
          )}
          data-parity="focus-metrics"
        >
          <div
            className="flex min-w-[84px] flex-col justify-center px-4 first:pl-0 until-stack:min-w-0 until-stack:flex-1 until-stack:px-[9px]"
            data-parity="focus-metric-battery"
          >
            <span className="whitespace-nowrap font-mono text-[8px] uppercase tracking-[0.08em] text-dark-faint until-stack:tracking-[0.04em]">
              Battery
            </span>
            <span className="mt-0.5 whitespace-nowrap font-mono text-[15px] font-medium tabular-nums tracking-[-0.02em] text-dark-text until-stack:text-[14px]">
              <span>{metric(telemetry?.batteryPct)}</span>
              <small className="text-[9px] font-normal tracking-normal text-dark-faint">%</small>
            </span>
          </div>
          <div
            className="flex min-w-[84px] flex-col justify-center px-4 first:pl-0 until-stack:min-w-0 until-stack:flex-1 until-stack:px-[9px]"
            data-parity="focus-metric-flight-time"
            data-testid="focus-flight-time"
          >
            <span className="whitespace-nowrap font-mono text-[8px] uppercase tracking-[0.08em] text-dark-faint until-stack:tracking-[0.04em]">
              Time left
            </span>
            <span className="mt-0.5 whitespace-nowrap font-mono text-[15px] font-medium tabular-nums tracking-[-0.02em] text-dark-text until-stack:text-[14px]">
              {flightTimeLabel(telemetry?.remainFlightS)}
            </span>
          </div>
          <div
            className="flex min-w-[84px] flex-col justify-center px-4 first:pl-0 until-stack:min-w-0 until-stack:flex-1 until-stack:px-[9px]"
            data-parity="focus-metric-altitude"
          >
            <span className="whitespace-nowrap font-mono text-[8px] uppercase tracking-[0.08em] text-dark-faint until-stack:tracking-[0.04em]">
              Altitude
            </span>
            <span className="mt-0.5 whitespace-nowrap font-mono text-[15px] font-medium tabular-nums tracking-[-0.02em] text-dark-text until-stack:text-[14px]">
              <span>{metric(telemetry?.altRel)}</span>
              <small className="text-[9px] font-normal tracking-normal text-dark-faint">m</small>
            </span>
          </div>
          <div
            className="flex min-w-[84px] flex-col justify-center px-4 first:pl-0 until-stack:min-w-0 until-stack:flex-1 until-stack:px-[9px]"
            data-parity="focus-metric-speed"
          >
            <span className="whitespace-nowrap font-mono text-[8px] uppercase tracking-[0.08em] text-dark-faint until-stack:tracking-[0.04em]">
              Speed
            </span>
            <span className="mt-0.5 whitespace-nowrap font-mono text-[15px] font-medium tabular-nums tracking-[-0.02em] text-dark-text until-stack:text-[14px]">
              <span>{metric(telemetry?.speedH, 1)}</span>
              <small className="text-[9px] font-normal tracking-normal text-dark-faint">m/s</small>
            </span>
          </div>
          <div
            className="flex min-w-[84px] flex-col justify-center px-4 first:pl-0 until-stack:min-w-0 until-stack:flex-1 until-stack:px-[9px]"
            data-parity="focus-metric-heading"
          >
            <span className="whitespace-nowrap font-mono text-[8px] uppercase tracking-[0.08em] text-dark-faint until-stack:tracking-[0.04em]">
              Heading
            </span>
            <span className="mt-0.5 whitespace-nowrap font-mono text-[15px] font-medium tabular-nums tracking-[-0.02em] text-dark-text until-stack:text-[14px]">
              <span>{metric(telemetry?.heading)}</span>
              <small className="text-[9px] font-normal tracking-normal text-dark-faint">°</small>
            </span>
          </div>
          <div
            className="flex min-w-[84px] flex-col justify-center px-4 first:pl-0 until-stack:min-w-0 until-stack:flex-1 until-stack:px-[9px]"
            data-parity="focus-metric-satellites"
          >
            <span className="whitespace-nowrap font-mono text-[8px] uppercase tracking-[0.08em] text-dark-faint until-stack:tracking-[0.04em]">
              Satellites
            </span>
            <span className="mt-0.5 whitespace-nowrap font-mono text-[15px] font-medium tabular-nums tracking-[-0.02em] text-dark-text until-stack:text-[14px]">
              <span>{metric(telemetry?.gnss)}</span>
              <small className="text-[9px] font-normal tracking-normal text-dark-faint">gnss</small>
            </span>
          </div>
        </div>
        <div
          className="ml-auto flex items-center gap-3.5 border-l border-l-dark-line pl-[18px] until-stack:ml-0 until-stack:w-full until-stack:justify-between until-stack:border-l-0 until-stack:pl-0 until-phone-lg:hidden"
          data-parity="focus-foot-end"
        >
          <span
            className="inline-flex items-center gap-[5px] whitespace-nowrap font-mono text-[8.5px] tracking-[0.04em] text-dark-faint"
            data-parity="focus-esc-hint"
          >
            <kbd className="rounded-[3px] border border-dark-line bg-dark-raised px-[5px] py-px font-mono text-[8px] text-dark-muted">
              Esc
            </kbd>{' '}
            to return
          </span>
        </div>
      </div>
      {viewerShot && (
        <ScreenshotViewer
          shot={viewerShot}
          title={device ? deviceLabel(device) : (viewerShot.deviceLabel ?? 'Drone')}
          startWithPeople
          onClose={() => {
            setViewerShot(null)
            backRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}
