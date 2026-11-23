import type { TrailPoint } from '../api'
import { deviceLabel } from '../deviceSearch'
import { flightTimeLabel, metric } from '../format'
import { useFleet } from '../store'
import Button from '../ui/Button'
import ColorDot from './ColorDot'
import Icon from './Icon'
import TimeAgo from './TimeAgo'

const CHART_WIDTH = 308
const CHART_HEIGHT = 34

interface Spark {
  line: string
  area: string
  endX: number
  endY: number
  min: number
  max: number
}

function buildSpark(values: number[]): Spark | null {
  if (values.length < 2) return null

  const lo = Math.min(...values) - 4
  const hi = Math.max(...values) + 4
  const span = hi - lo || 1

  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * CHART_WIDTH
    const y = 30 - ((value - lo) / span) * 26
    return [x, y] as const
  })

  const line = points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join('')
  const last = points[points.length - 1]
  if (!last) return null
  const [endX, endY] = last

  return {
    line,
    area: `${line}L${CHART_WIDTH} ${CHART_HEIGHT}L0 ${CHART_HEIGHT}Z`,
    endX,
    endY,
    min: Math.min(...values),
    max: Math.max(...values),
  }
}

export default function MapCard({
  trail,
  onViewLive,
  canViewLive,
}: {
  canViewLive: boolean
  trail: TrailPoint[]
  onViewLive: (sn: string) => void
}) {
  const devices = useFleet((state) => state.devices)
  const selected = useFleet((state) => state.selected)
  const device = selected ? devices[selected] : undefined

  if (!device) return null

  const telemetry = device.telemetry
  const online = device.online
  const hasTelemetry = telemetry != null
  // Offline cards keep the last sample so an operator can see where and how the aircraft
  // was lost, but the values must read as history, not as live instruments.
  const valueTone = online ? undefined : 'text-ink-3'
  const ordered = [...trail].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''))
  const altitudes = ordered
    .map((point) => point.alt)
    .filter((alt): alt is number => alt != null && Number.isFinite(alt))
  const spark = buildSpark(altitudes)
  const lastAltitude = altitudes[altitudes.length - 1]
  const chartTitle =
    spark && lastAltitude != null
      ? `Altitude over the last ten minutes, ending at ${Math.round(lastAltitude)} metres.`
      : 'No recent altitude data for this drone.'

  return (
    <div
      className="absolute bottom-[18px] left-[18px] z-[4] w-[336px] overflow-hidden rounded-[16px] border border-line bg-surface-2 [box-shadow:var(--shadow-float)] until-wide-lg:w-[324px] until-drawer:inset-x-4 until-drawer:bottom-3 until-drawer:w-auto until-drawer:max-w-[360px] until-phone-lg:bottom-2.5"
      data-parity="detail"
    >
      <div className="flex items-start gap-2.5 px-[15px] pb-3 pt-[15px]" data-parity="detail-head">
        <div>
          <h2
            className="m-0 flex items-center gap-2 text-[15.5px] font-semibold leading-[1.2] tracking-[-0.02em]"
            data-parity="detail-name"
          >
            <ColorDot color={device.color} className="size-3" />
            {deviceLabel(device)}
          </h2>
          <div
            className="mt-[3px] break-all font-mono text-[9px] tracking-[0.04em] text-ink-3"
            data-parity="detail-sn"
          >
            {device.model ?? 'Drone'} / {device.sn}
          </div>
        </div>
        <span
          className={`ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-[999px] border px-[7px] py-0.5 text-[9.5px] font-medium ${
            online
              ? 'border-line-soft bg-pine-wash text-pine-strong'
              : 'border-line bg-sunken text-ink-2'
          }`}
          data-parity="detail-status"
        >
          <span
            className={`size-[5px] rounded-[50%] ${online ? 'bg-ok' : 'bg-ink-3'}`}
            aria-hidden="true"
          />
          {online ? 'Online' : 'Offline'}
        </span>
      </div>

      {!online && (
        <div
          className="flex items-center justify-between gap-3 border-t border-t-line bg-sunken px-3 py-[6px] font-mono text-[8px] tracking-[0.07em] text-ink-3"
          data-parity="detail-stale"
        >
          <span className="uppercase">{hasTelemetry ? 'Last known' : 'No telemetry'}</span>
          {hasTelemetry && (
            <span>
              <TimeAgo iso={device.lastSeenAt} fallback="—" />
            </span>
          )}
        </div>
      )}

      <div
        className="grid grid-cols-4 border-y border-y-line [&>*+*]:border-l [&>*+*]:border-l-line"
        data-parity="detail-metrics"
      >
        <div
          className="min-w-0 px-2.5 pb-2.5 pt-[9px] until-phone-lg:px-2 until-phone-lg:pb-[9px] until-phone-lg:pt-2"
          data-parity="detail-metric-altitude"
        >
          <div className="font-mono text-[8px] uppercase tracking-[0.08em] text-ink-3">
            Altitude
          </div>
          <div className="mt-0.5 flex items-baseline gap-[3px] font-mono text-[14.5px] font-medium tabular-nums tracking-[-0.02em] until-phone-lg:text-[13px]">
            <span className={valueTone}>{metric(telemetry?.altRel)}</span>
            <small className="text-[8.5px] font-normal tracking-normal text-ink-3">m</small>
          </div>
        </div>
        <div
          className="min-w-0 px-2.5 pb-2.5 pt-[9px] until-phone-lg:px-2 until-phone-lg:pb-[9px] until-phone-lg:pt-2"
          data-parity="detail-metric-speed"
        >
          <div className="font-mono text-[8px] uppercase tracking-[0.08em] text-ink-3">Speed</div>
          <div className="mt-0.5 flex items-baseline gap-[3px] font-mono text-[14.5px] font-medium tabular-nums tracking-[-0.02em] until-phone-lg:text-[13px]">
            <span className={valueTone}>{metric(telemetry?.speedH, 1)}</span>
            <small className="text-[8.5px] font-normal tracking-normal text-ink-3">m/s</small>
          </div>
        </div>
        <div
          className="min-w-0 px-2.5 pb-2.5 pt-[9px] until-phone-lg:px-2 until-phone-lg:pb-[9px] until-phone-lg:pt-2"
          data-parity="detail-metric-battery"
        >
          <div className="font-mono text-[8px] uppercase tracking-[0.08em] text-ink-3">Battery</div>
          <div className="mt-0.5 flex items-baseline gap-[3px] font-mono text-[14.5px] font-medium tabular-nums tracking-[-0.02em] until-phone-lg:text-[13px]">
            <span className={valueTone}>{metric(telemetry?.batteryPct)}</span>
            <small className="text-[8.5px] font-normal tracking-normal text-ink-3">%</small>
          </div>
          <div
            className="mt-px truncate font-mono text-[8.5px] text-ink-3"
            data-testid="detail-flight-time"
          >
            {telemetry?.remainFlightS != null
              ? `${flightTimeLabel(telemetry.remainFlightS)} left`
              : 'time left —'}
          </div>
        </div>
        <div
          className="min-w-0 px-2.5 pb-2.5 pt-[9px] until-phone-lg:px-2 until-phone-lg:pb-[9px] until-phone-lg:pt-2"
          data-parity="detail-metric-heading"
        >
          <div className="font-mono text-[8px] uppercase tracking-[0.08em] text-ink-3">Heading</div>
          <div className="mt-0.5 flex items-baseline gap-[3px] font-mono text-[14.5px] font-medium tabular-nums tracking-[-0.02em] until-phone-lg:text-[13px]">
            <span className={valueTone}>{metric(telemetry?.heading)}</span>
            <small className="text-[8.5px] font-normal tracking-normal text-ink-3">°</small>
          </div>
        </div>
      </div>

      <div
        className={`border-b border-b-line px-3 pb-1 pt-[9px] until-narrow:hidden ${
          online ? (spark ? '' : 'opacity-[0.55]') : 'opacity-[0.42]'
        }`}
        data-parity="detail-spark"
      >
        <div
          className="flex items-center justify-between gap-3 font-mono text-[8px] uppercase tracking-[0.07em] text-ink-3"
          data-parity="detail-spark-head"
        >
          <span>Altitude / last 10 min</span>
          <span>{spark ? `${Math.round(spark.min)}–${Math.round(spark.max)} m` : 'No data'}</span>
        </div>
        <svg
          className="mt-1 h-[34px] w-full overflow-visible"
          data-parity="detail-spark-svg"
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={chartTitle}
        >
          <line
            className="stroke-line stroke-1"
            data-parity="spark-base"
            x1="0"
            y1="32"
            x2={CHART_WIDTH}
            y2="32"
          />
          {spark && (
            <>
              <path className="fill-pine opacity-[0.08]" data-parity="spark-area" d={spark.area} />
              <path
                className="fill-none stroke-pine stroke-[1.4] [stroke-linecap:round] [stroke-linejoin:round]"
                data-parity="spark-line"
                d={spark.line}
              />
              <circle
                className="fill-pine"
                data-parity="spark-end"
                cx={spark.endX}
                cy={spark.endY}
                r="2.4"
              />
            </>
          )}
        </svg>
      </div>

      <div
        className="flex items-center gap-2 px-3 py-[11px] until-narrow:p-2.5"
        data-parity="detail-foot"
      >
        <Button
          variant="mapPrimary"
          data-parity="open-live"
          data-testid="open-live"
          type="button"
          disabled={!online || !canViewLive}
          onClick={() => onViewLive(device.sn)}
        >
          <Icon name="play" />
          <span>
            {!canViewLive
              ? 'Video access unavailable'
              : online
                ? 'Open live feed'
                : 'Drone offline'}
          </span>
        </Button>
        <div
          className="ml-auto text-right font-mono text-[8.5px] leading-[1.5] tracking-[0.02em] text-ink-3 until-phone-lg:text-[8px] until-narrow:hidden"
          data-parity="detail-meta"
        >
          {telemetry && (
            <strong className="block font-medium text-ink-2">
              {telemetry.gnss != null ? `${telemetry.gnss} satellites` : 'GNSS —'}
            </strong>
          )}
          {online && (
            <TimeAgo
              iso={device.lastSeenAt}
              prefix={device.lastSeenAt ? 'Telemetry' : undefined}
              fallback="Telemetry pending"
            />
          )}
        </div>
      </div>
    </div>
  )
}
