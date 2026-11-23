import { can } from '@dji/protocol'
import { useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react'
import type { DeviceSummary, StreamState } from '@dji/protocol'
import { api, type User } from '../api'
import { deviceLabel, deviceName, matchesSearch } from '../deviceSearch'
import { formatCoord, metric, serialTail, streamMeta } from '../format'
import { retry } from '../socket'
import { streamForDevice } from '../streamSelect'
import { useFleet } from '../store'
import { useWatch } from '../useWatch'
import Spinner from '../ui/Spinner'
import StatusPill, { type StatusTone } from '../ui/StatusPill'
import { cn } from '../ui/cn'
import Icon from './Icon'
import { RecordingBar, TileRecordButton } from './RecordControls'
import { useServerRecordingsWatch } from '../serverRecordings'
import { TileServerRecordButton } from './ServerRecordButton'
import WhepPlayer from './WhepPlayer'

type FullscreenFrame = HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void }
type FullscreenDoc = Document & {
  webkitFullscreenElement?: Element | null
  webkitFullscreenEnabled?: boolean
  webkitExitFullscreen?: () => Promise<void> | void
}

const OPEN_DELAY_MS = 250
const placeholderClass =
  'absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-5 text-center text-[11.5px] leading-[1.5] text-dark-muted [overflow-wrap:anywhere]'
const placeholderIcon = 'size-[18px] text-dark-faint'
const tileVideoClass = 'absolute inset-0 size-full object-cover'

function fullscreenElement() {
  const doc = document as FullscreenDoc
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

function fullscreenSupported() {
  const doc = document as FullscreenDoc
  return Boolean(document.fullscreenEnabled || doc.webkitFullscreenEnabled)
}

function WallTile({
  device,
  stream,
  position,
  drag,
  suspended,
  isAdmin,
  canRecord,
  canServerRecord,
  onExpand,
  onRetry,
  onAdminStop,
  onAdminResume,
}: {
  device: DeviceSummary
  stream: StreamState | undefined
  position: number
  drag: SlotDrag
  suspended: boolean
  isAdmin: boolean
  canRecord: boolean
  canServerRecord: boolean
  onExpand: () => void
  onRetry: () => void
  onAdminStop: () => void
  onAdminResume: () => void
}) {
  const telemetry = device.telemetry
  const label = deviceLabel(device)
  const tail = serialTail(device.sn)
  const meta = streamMeta(device, stream)
  const live = stream?.phase === 'live'
  const starting = stream?.phase === 'starting'
  const reconnecting = starting && stream?.error === 'reconnecting'
  const failed = stream?.phase === 'error'
  const held = stream?.phase === 'stopped' && stream?.error === 'stopped by an administrator'
  const active = starting || live
  const badge = live
    ? 'Live'
    : reconnecting
      ? 'Reconnecting'
      : starting
        ? 'Connecting'
        : failed
          ? 'Error'
          : 'Idle'

  // Full screen is requested on the frame that already holds the <video>, so the player is
  // never remounted and the stream keeps playing.
  const frameRef = useRef<FullscreenFrame>(null)
  const openTimer = useRef<number | undefined>(undefined)
  const noticeTimer = useRef<number | undefined>(undefined)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const canFullscreen = useMemo(fullscreenSupported, [])

  useEffect(() => {
    const sync = () => setIsFullscreen(fullscreenElement() === frameRef.current)
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
      window.clearTimeout(openTimer.current)
      window.clearTimeout(noticeTimer.current)
    }
  }, [])

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3500)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    const frame = frameRef.current
    if (!frame) return
    try {
      if (fullscreenElement() === frame) {
        const doc = document as FullscreenDoc
        await (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.())
        return
      }
      if (!fullscreenSupported()) throw new Error('unsupported')
      const request =
        frame.requestFullscreen?.bind(frame) ?? frame.webkitRequestFullscreen?.bind(frame)
      if (!request) throw new Error('unsupported')
      await request()
    } catch {
      showNotice('Full screen is not available here')
    }
  }, [showNotice])

  // A single click opens the focus view, a double click goes full screen. The short delay
  // lets a double click cancel the open that its first click would otherwise trigger.
  const handleOpenClick = () => {
    if (fullscreenElement() === frameRef.current) return
    window.clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(onExpand, OPEN_DELAY_MS)
  }

  const handleOpenDoubleClick = () => {
    window.clearTimeout(openTimer.current)
    void toggleFullscreen()
  }

  const hasActions = failed || (isAdmin && (active || held))
  const tone: StatusTone = live ? 'live' : starting ? 'pending' : failed ? 'error' : 'idle'
  const dragState = drag.dragging
    ? 'cursor-grabbing border-ink opacity-[0.45] [transform:none]'
    : drag.over
      ? 'border-ink [box-shadow:0_0_0_2px_var(--ink),var(--shadow-card)] [transform:none]'
      : 'cursor-grab hover:border-[var(--tile-hover-border)] hover:[box-shadow:var(--shadow-float)] hover:[transform:translateY(-2px)] motion-reduce:hover:[transform:none]'

  return (
    <article
      className={cn(
        'group overflow-hidden rounded-lg border border-line bg-white transition-[transform,border-color,box-shadow] [box-shadow:var(--shadow-card)]',
        dragState,
      )}
      data-device={device.sn}
      data-parity={`tile-${device.sn}`}
      data-testid="tile"
      data-drop-target={drag.over ? 'true' : undefined}
      style={{ order: position }}
      draggable
      {...drag.handlers}
    >
      <div
        className="relative aspect-video overflow-hidden bg-dark-bg"
        data-decor="tile-frame"
        data-parity={`tile-frame-${device.sn}`}
        ref={frameRef}
      >
        {live ? (
          suspended ? (
            <div className={placeholderClass} data-parity={`tile-placeholder-${device.sn}`}>
              <Icon name="expand" className={placeholderIcon} />
              <span>Showing in full view</span>
            </div>
          ) : (
            <WhepPlayer streamId={stream.id} className={tileVideoClass} />
          )
        ) : (
          <div className={placeholderClass} data-parity={`tile-placeholder-${device.sn}`}>
            {starting ? (
              <>
                <Spinner />
                <span>{reconnecting ? 'Reconnecting' : 'Waiting for video'}</span>
              </>
            ) : failed ? (
              <>
                <Icon name="alert" className={placeholderIcon} />
                <span>{stream?.error ?? 'Stream failed'}</span>
              </>
            ) : held ? (
              <>
                <Icon name="stop" className={placeholderIcon} />
                <span>Stopped by an administrator</span>
              </>
            ) : (
              <>
                <Icon name="play" className={placeholderIcon} />
                <span>No active feed</span>
              </>
            )}
          </div>
        )}

        {starting && (
          <span
            className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-[var(--progress-track)]"
            data-parity={`tile-progress-${device.sn}`}
            aria-hidden="true"
          >
            <span className="absolute inset-y-0 left-0 w-[38%] animate-indeterminate bg-dark-pine motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-35" />
          </span>
        )}
        <span data-decor="tile-scrim" data-parity={`tile-scrim-${device.sn}`} aria-hidden="true" />

        <StatusPill
          tone={tone}
          label={badge}
          className="absolute left-2.5 top-2.5"
          data-parity={`tile-live-${device.sn}`}
          data-testid="live-pill"
        />

        <span
          className="pointer-events-none absolute left-2.5 top-[38px] max-w-[calc(100%-20px)] overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-semibold text-[var(--tile-text)] [text-shadow:var(--shadow-tile-text)]"
          data-decor="tile-name"
          data-parity={`tile-name-overlay-${device.sn}`}
          title={label}
        >
          {label}
        </span>

        {stream && (
          <span
            className="pointer-events-none absolute right-2.5 top-2.5 font-mono text-[8px] uppercase tracking-[0.09em] text-[var(--tile-quality-text)]"
            data-parity={`tile-quality-${device.sn}`}
          >
            {meta.quality} / {meta.lens}
          </span>
        )}
        {stream && !device.videoOnly && (
          <span
            className="pointer-events-none absolute bottom-2.5 left-2.5 font-mono text-[8.5px] tabular-nums tracking-[0.03em] text-[var(--tile-coord-text)]"
            data-parity={`tile-coord-${device.sn}`}
          >
            {formatCoord(telemetry?.lat, telemetry?.lon)}
          </span>
        )}

        <span
          className="pointer-events-none absolute bottom-2 right-2 grid size-[30px] place-items-center rounded-sm bg-[var(--tile-control-bg)] text-[var(--tile-control-text)] opacity-0 backdrop-blur-[8px] transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
          data-decor="tile-expand"
          data-parity={`tile-expand-${device.sn}`}
          aria-hidden="true"
        >
          <Icon name="expand" className="size-3.5" />
        </span>

        <button
          className="absolute inset-0 z-[4] size-full rounded-none bg-transparent focus-visible:outline-2 focus-visible:outline-dark-pine focus-visible:-outline-offset-[3px]"
          data-parity={`tile-open-${device.sn}`}
          data-testid="tile-open"
          type="button"
          onClick={handleOpenClick}
          onDoubleClick={handleOpenDoubleClick}
          aria-label={`Open ${label} (${tail}) live feed`}
        />

        {canFullscreen && (
          <button
            className={cn(
              'absolute bottom-2 right-11 z-[5] grid size-[30px] place-items-center rounded-sm bg-[var(--tile-control-bg)] text-[var(--tile-control-text)] backdrop-blur-[8px] transition-opacity focus-visible:outline-2 focus-visible:outline-dark-pine',
              isFullscreen
                ? 'opacity-100'
                : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
            )}
            data-decor="tile-fullscreen"
            data-parity={`tile-fullscreen-${device.sn}`}
            type="button"
            onClick={() => void toggleFullscreen()}
            aria-label={`${isFullscreen ? 'Exit full screen for' : 'Full screen'} ${label} (${tail})`}
            aria-pressed={isFullscreen}
            title={isFullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
          >
            <Icon name={isFullscreen ? 'fullscreenExit' : 'fullscreen'} className="size-3.5" />
          </button>
        )}

        {/* REC records on the server; the laptop button beside it records on this computer. */}
        <div className="absolute bottom-2 right-20 z-[5] flex items-center gap-1.5">
          <TileServerRecordButton
            sn={device.sn}
            label={label}
            live={live}
            allowed={canServerRecord}
          />
          <TileRecordButton sn={device.sn} label={label} live={live} allowed={canRecord} />
        </div>

        {notice && (
          <span
            className="pointer-events-none absolute bottom-11 right-2 z-[5] rounded-sm bg-[var(--tile-notice-bg)] px-2 py-1 text-[11px] text-[var(--tile-text)]"
            data-parity={`tile-notice-${device.sn}`}
            role="status"
          >
            {notice}
          </span>
        )}
      </div>

      <div
        className="flex min-h-11 items-center gap-2.5 border-t border-t-line px-2.5 py-[7px] pl-3 [background-image:linear-gradient(180deg,var(--surface-2),var(--tile-foot-end))]"
        data-parity={`tile-foot-${device.sn}`}
      >
        <div className="min-w-0" data-parity={`tile-id-${device.sn}`}>
          <span className="block truncate text-[12px] font-medium tracking-[-0.005em]">
            {label}
          </span>
          <span className="mt-px block font-mono text-[8.5px] tracking-[0.04em] text-ink-3">
            {tail}
          </span>
        </div>

        <div
          className="ml-auto flex gap-2.5 whitespace-nowrap font-mono text-[9.5px] tabular-nums text-ink-2"
          data-parity={`tile-metrics-${device.sn}`}
        >
          <span>
            {metric(telemetry?.batteryPct)}
            <small className="text-[8px] text-ink-3">%</small>
          </span>
          <span>
            {metric(telemetry?.altRel)}
            <small className="text-[8px] text-ink-3">m</small>
          </span>
          <span>
            {metric(telemetry?.speedH, 1)}
            <small className="text-[8px] text-ink-3">m/s</small>
          </span>
        </div>

        {hasActions && (
          <div
            className="flex flex-none items-center gap-0.5"
            data-parity={`tile-actions-${device.sn}`}
          >
            {failed && (
              <button
                className="grid size-[26px] flex-none place-items-center rounded-sm text-ink-3 transition-colors hover:bg-sunken hover:text-ink [&_svg]:size-[13px]"
                type="button"
                onClick={onRetry}
                aria-label={`Retry ${label} (${tail}) stream`}
                title="Retry stream"
              >
                <Icon name="refresh" />
              </button>
            )}
            {isAdmin && active && (
              <button
                className="grid size-[26px] flex-none place-items-center rounded-sm text-ink-3 transition-colors hover:bg-sunken hover:text-ink [&_svg]:size-[13px]"
                type="button"
                onClick={onAdminStop}
                aria-label={`Stop ${label} (${tail}) for everyone`}
                title="Stop for everyone"
              >
                <Icon name="stop" />
              </button>
            )}
            {isAdmin && held && (
              <button
                className="grid size-[26px] flex-none place-items-center rounded-sm text-ink-3 transition-colors hover:bg-sunken hover:text-ink [&_svg]:size-[13px]"
                type="button"
                onClick={onAdminResume}
                aria-label={`Resume ${label} (${tail}) stream`}
                title="Resume stream"
              >
                <Icon name="play" />
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

const LAYOUTS = [2, 4, 6, 8, 12, 16] as const
type Layout = (typeof LAYOUTS)[number] | 'auto'

const LAYOUT_CLASSES: Record<(typeof LAYOUTS)[number], string> = {
  2: 'grid-cols-2',
  4: 'grid-cols-2',
  6: 'grid-cols-3',
  8: 'grid-cols-4',
  12: 'grid-cols-4',
  16: 'grid-cols-4',
}

const LAYOUT_KEY = 'wall-layout'
const ORDER_KEY = 'wall-order'
const EMPTY_PREFIX = 'empty:'

function readOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(ORDER_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((sn): sn is string => typeof sn === 'string') : []
  } catch {
    return []
  }
}

function readLayout(): Layout {
  try {
    const stored = window.localStorage.getItem(LAYOUT_KEY)
    const count = Number(stored)
    return LAYOUTS.find((value) => value === count) ?? 'auto'
  } catch {
    return 'auto'
  }
}

// Tiles stay in a fixed DOM order and are placed with CSS `order`, so rearranging never
// detaches a <video> element and the streams keep playing.
interface SlotDrag {
  dragging: boolean
  over: boolean
  handlers: Pick<
    HTMLAttributes<HTMLElement>,
    'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDragLeave' | 'onDrop'
  >
}

function EmptySlot({ index, position, drag }: { index: number; position: number; drag: SlotDrag }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-dashed border-line bg-white transition-[transform,border-color,box-shadow] [box-shadow:var(--shadow-card)]',
        drag.over
          ? 'border-ink [box-shadow:0_0_0_2px_var(--ink),var(--shadow-card)] [transform:none]'
          : 'hover:border-[var(--tile-hover-border)] hover:[box-shadow:var(--shadow-float)] hover:[transform:translateY(-2px)] motion-reduce:hover:[transform:none]',
      )}
      data-parity={`empty-${index}`}
      data-testid="tile"
      data-drop-target={drag.over ? 'true' : undefined}
      aria-label={`Empty slot ${index}`}
      style={{ order: position }}
      {...drag.handlers}
    >
      <div
        className="relative aspect-video overflow-hidden bg-dark-bg"
        data-decor="tile-frame"
        data-parity={`empty-frame-${index}`}
      >
        <div className={placeholderClass} data-parity={`empty-placeholder-${index}`}>
          <Icon name="play" className={placeholderIcon} />
          <span>No drone assigned</span>
        </div>
      </div>
      <div
        className="flex min-h-11 items-center gap-2.5 border-t border-t-line px-2.5 py-[7px] pl-3 [background-image:linear-gradient(180deg,var(--surface-2),var(--tile-foot-end))]"
        data-parity={`empty-foot-${index}`}
      >
        <div className="min-w-0" data-parity={`empty-id-${index}`}>
          <span className="block truncate text-[12px] font-medium tracking-[-0.005em]">
            Slot {index}
          </span>
        </div>
      </div>
    </div>
  )
}

export default function LiveWall({
  onExpand,
  suspendedSn,
  user,
}: {
  onExpand: (sn: string) => void
  suspendedSn: string | null
  user: User
}) {
  const devices = useFleet((state) => state.devices)
  const streams = useFleet((state) => state.streams)
  const search = useFleet((state) => state.search)
  // One look for every tile's REC button: what the server is recording now.
  useServerRecordingsWatch(can(user, 'recordings.record'))
  const [layout, setLayout] = useState<Layout>(readLayout)
  const [order, setOrder] = useState<string[]>(readOrder)
  const [dragSn, setDragSn] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)

  const chooseLayout = (next: Layout) => {
    setLayout(next)
    try {
      window.localStorage.setItem(LAYOUT_KEY, String(next))
    } catch {
      // The choice only lasts for this session when storage is unavailable.
    }
  }

  const list = useMemo(
    () => Object.values(devices).sort((a, b) => deviceName(a).localeCompare(deviceName(b))),
    [devices],
  )
  const visible = list.filter((device) => matchesSearch(device, search))
  const online = visible.filter((device) => device.online && can(user, 'streams.view', device.sn))

  // The user's arrangement ranks aircraft; anyone not yet placed follows in name order.
  const arranged = useMemo(() => {
    const rank = (sn: string) => {
      const at = order.indexOf(sn)
      return at === -1 ? order.length : at
    }
    return [...online].sort((a, b) => rank(a.sn) - rank(b.sn))
  }, [online, order])

  const slots = layout === 'auto' ? online.length : layout
  const placed = arranged.slice(0, slots)
  const position = new Map(placed.map((device, index) => [device.sn, index]))
  // Render in name order, not arrangement order: React then never moves a tile's DOM node,
  // and the grid position comes from CSS `order` alone.
  const shown = online.filter((device) => position.has(device.sn))

  // Only visible tiles are watched. This hook must run before the empty-state return.
  useWatch(shown.map((device) => device.sn))

  const saveOrder = (next: string[]) => {
    setOrder(next)
    try {
      window.localStorage.setItem(ORDER_KEY, JSON.stringify(next))
    } catch {
      // The arrangement only lasts for this session when storage is unavailable.
    }
  }

  const endDrag = () => {
    setDragSn(null)
    setOverKey(null)
  }

  // Dropping on another feed swaps the two; dropping on an empty slot moves the feed to the
  // last occupied position.
  const dropOn = (target: string) => {
    const from = dragSn
    endDrag()
    if (!from) return
    const sequence = arranged.map((device) => device.sn)
    const fromAt = sequence.indexOf(from)
    if (fromAt === -1) return
    const limit = layout === 'auto' ? sequence.length : layout

    if (target.startsWith(EMPTY_PREFIX)) {
      sequence.splice(fromAt, 1)
      sequence.splice(Math.min(limit, sequence.length + 1) - 1, 0, from)
    } else {
      const toAt = sequence.indexOf(target)
      if (toAt === -1 || toAt === fromAt) return
      ;[sequence[fromAt], sequence[toAt]] = [sequence[toAt]!, sequence[fromAt]!]
    }
    saveOrder(sequence)
  }

  const slotDrag = (key: string, sn?: string): SlotDrag => ({
    dragging: sn !== undefined && dragSn === sn,
    over: overKey === key && dragSn !== null && dragSn !== sn,
    handlers: {
      onDragStart: (event) => {
        if (sn === undefined) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', sn)
        setDragSn(sn)
      },
      onDragEnd: endDrag,
      onDragOver: (event) => {
        if (dragSn === null) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        if (overKey !== key) setOverKey(key)
      },
      onDragLeave: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOverKey((current) => (current === key ? null : current))
        }
      },
      onDrop: (event) => {
        event.preventDefault()
        dropOn(key)
      },
    },
  })

  if (online.length === 0) {
    const noMatches = Boolean(search) && visible.length === 0
    const noOnlineForSearch = Boolean(search) && visible.length > 0

    return (
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[22px] pb-[26px] pt-[18px] [scrollbar-color:var(--line-strong)_transparent] [scrollbar-width:thin] until-drawer:p-4 until-stack:px-4 until-stack:pb-[22px] until-stack:pt-3.5"
        data-parity="wall-screen"
      >
        <div className="mb-3.5 flex empty:hidden">
          <RecordingBar />
        </div>
        <div
          className="grid min-h-[340px] place-items-center rounded-lg border border-dashed border-line-strong bg-[var(--wall-empty-bg)] px-5 py-10 text-center"
          data-parity="wall-empty"
        >
          <div>
            <h2 className="mb-1.5 mt-0 text-[15px] font-semibold">
              {noMatches
                ? 'No drones match this search'
                : noOnlineForSearch
                  ? 'No online drones for this search'
                  : 'No drones online'}
            </h2>
            <p className="m-0 max-w-[42ch] text-[12.5px] leading-[1.6] text-ink-3">
              {noMatches
                ? 'Clear the search to see every active feed.'
                : noOnlineForSearch
                  ? 'Clear the search, or wait for a drone to come online.'
                  : 'Sign a controller in through Pilot 2. The wall opens feeds automatically when a drone is online.'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  const hidden = online.length - shown.length
  const empty = layout === 'auto' ? 0 : Math.max(0, layout - shown.length)
  const layoutButton = (active: boolean) =>
    cn(
      'h-7 min-w-[34px] rounded-[999px] border px-2.5 text-[12px] font-medium transition-colors',
      active
        ? 'border-transparent text-white [background-image:linear-gradient(180deg,var(--pine),var(--pine-strong))] [box-shadow:var(--shadow-layout-active)]'
        : 'border-line bg-white text-ink-2 hover:border-pine hover:text-pine-strong',
    )

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[22px] pb-[26px] pt-[18px] [scrollbar-color:var(--line-strong)_transparent] [scrollbar-width:thin] until-drawer:p-4 until-stack:px-4 until-stack:pb-[22px] until-stack:pt-3.5"
      data-parity="wall-screen"
    >
      <div
        className="mb-3.5 flex flex-wrap items-center gap-1.5"
        data-parity="wall-toolbar"
        role="group"
        aria-label="Wall layout and recordings"
      >
        <span className="mr-1 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-3">
          Layout
        </span>
        {(['auto', ...LAYOUTS] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={layoutButton(layout === option)}
            data-parity={`wall-layout-${option}`}
            aria-pressed={layout === option}
            onClick={() => chooseLayout(option)}
          >
            {option === 'auto' ? 'Auto' : option}
          </button>
        ))}
        {hidden > 0 && (
          <span className="ml-2 text-[11.5px] text-ink-3" data-parity="wall-toolbar-note">
            {hidden} more online, not shown. Choose a larger layout.
          </span>
        )}
        <RecordingBar />
      </div>

      <div
        className={cn(
          'grid content-start gap-4',
          layout === 'auto'
            ? 'grid-cols-[repeat(auto-fit,minmax(300px,1fr))]'
            : LAYOUT_CLASSES[layout],
          'until-stack:grid-cols-1',
        )}
        data-parity="wall-grid"
      >
        {shown.map((device) => {
          const stream = streamForDevice(streams, device.sn)

          return (
            <WallTile
              key={device.sn}
              device={device}
              stream={stream}
              position={position.get(device.sn) ?? 0}
              drag={slotDrag(device.sn, device.sn)}
              suspended={device.sn === suspendedSn}
              isAdmin={can(user, 'streams.control', device.sn) && !device.videoOnly}
              canRecord={can(user, 'screenshots.capture', device.sn)}
              canServerRecord={can(user, 'recordings.record', device.sn)}
              onExpand={() => onExpand(device.sn)}
              onRetry={() => retry(device.sn)}
              onAdminStop={() => {
                void api.adminStop(device.sn).catch(() => undefined)
              }}
              onAdminResume={() => {
                void api.adminResume(device.sn).catch(() => undefined)
              }}
            />
          )
        })}
        {Array.from({ length: empty }, (_, i) => (
          <EmptySlot
            key={`empty-${i}`}
            index={shown.length + i + 1}
            position={shown.length + i}
            drag={slotDrag(`${EMPTY_PREFIX}${i}`)}
          />
        ))}
      </div>
    </div>
  )
}
