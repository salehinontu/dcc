import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FlightSummary } from '@dji/protocol'
import { api } from '../api'
import ColorDot from '../components/ColorDot'
import StageBar from '../components/StageBar'
import { deviceLabel } from '../deviceSearch'
import {
  altitudeLabel,
  batteryLabel,
  distanceLabel,
  durationLabel,
  formatDateTime,
  speedLabel,
} from '../flightFormat'
import { withBase } from '../base'
import { followLink } from '../routes'
import { useFleet } from '../store'
import Badge from '../ui/Badge'
import Button from '../ui/Button'
import Notice from '../ui/Notice'
import { emptyPanel, filterControl, filterLabel, screenBody, td, th } from '../ui/surface'

const PAGE = 30

/** Midnight at the start of a `YYYY-MM-DD` day in the browser's time zone, as an ISO string. */
function dayStart(day: string, endOfDay = false): string | undefined {
  if (!day) return undefined
  const [year, month, date] = day.split('-').map(Number)
  if (!year || !month || !date) return undefined
  const value = endOfDay
    ? new Date(year, month - 1, date, 23, 59, 59, 999)
    : new Date(year, month - 1, date, 0, 0, 0, 0)
  return value.toISOString()
}

/** Every recorded flight: who flew, which aircraft, how long, how far and how high. */
export default function Flights({
  railOpen,
  onOpenRail,
}: {
  railOpen: boolean
  onOpenRail: (trigger: HTMLButtonElement) => void
}) {
  const devices = useFleet((state) => state.devices)
  const [deviceSn, setDeviceSn] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [flights, setFlights] = useState<FlightSummary[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const filter = useMemo(
    () => ({
      deviceSn: deviceSn || undefined,
      from: dayStart(from),
      to: dayStart(to, true),
    }),
    [deviceSn, from, to],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    api
      .flights(filter)
      .then((result) => {
        if (cancelled) return
        setFlights(result.flights)
        setMore(result.flights.length === PAGE)
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [filter])

  // A flight in progress changes while it is open; refresh the list gently.
  const hasActive = flights.some((flight) => flight.status === 'active')
  useEffect(() => {
    if (!hasActive) return undefined
    const timer = window.setInterval(() => {
      api
        .flights(filter)
        .then((result) => {
          setFlights((current) => {
            const fresh = new Map(result.flights.map((flight) => [flight.id, flight]))
            const known = new Set(current.map((flight) => flight.id))
            return [
              ...result.flights.filter((flight) => !known.has(flight.id)),
              ...current.map((flight) => fresh.get(flight.id) ?? flight),
            ]
          })
        })
        .catch(() => undefined)
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [filter, hasActive])

  const loadMore = useCallback(async () => {
    const last = flights[flights.length - 1]
    if (!last) return
    setLoading(true)
    try {
      const result = await api.flights({ ...filter, before: last.startedAt })
      setFlights((current) => [...current, ...result.flights])
      setMore(result.flights.length === PAGE)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [filter, flights])

  const totals = useMemo(
    () => ({
      distance: flights.reduce((sum, flight) => sum + flight.distanceM, 0),
      seconds: flights.reduce((sum, flight) => sum + flight.durationS, 0),
    }),
    [flights],
  )

  const filtered = Boolean(deviceSn || from || to)

  return (
    <>
      <StageBar
        bar="flights"
        title="Flight history"
        summary={`${flights.length}${more ? '+' : ''} flights / ${distanceLabel(totals.distance)} / ${durationLabel(totals.seconds)}`}
        railOpen={railOpen}
        onOpenRail={onOpenRail}
      />
      <div className={screenBody} data-testid="flights-screen">
        <div
          className="mb-4 flex flex-wrap items-end gap-2.5"
          role="group"
          aria-label="Filter flights"
        >
          <label className={filterLabel}>
            <span>Drone</span>
            <select
              className={filterControl}
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
            <span>From</span>
            <input
              className={filterControl}
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className={filterLabel}>
            <span>To</span>
            <input
              className={filterControl}
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          {filtered && (
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setDeviceSn('')
                setFrom('')
                setTo('')
              }}
            >
              Clear filters
            </Button>
          )}
        </div>

        {error && (
          <Notice tone="error" className="mb-3.5" onDismiss={() => setError('')}>
            {error}
          </Notice>
        )}

        {!loading && flights.length === 0 ? (
          <div className={emptyPanel}>
            <div>
              <h2 className="mb-1.5 mt-0 text-[15px] font-semibold">
                {filtered ? 'No flights match' : 'No flights recorded yet'}
              </h2>
              <p className="m-0 max-w-[46ch] text-[12.5px] leading-[1.6] text-ink-3">
                {filtered
                  ? 'Try a wider date range or another drone or operator.'
                  : 'A flight is recorded automatically when a drone takes off and ends when it lands. Its path, height and speed are kept here.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-white [box-shadow:var(--shadow-card)]">
            <table className="w-full border-collapse" data-testid="flights-table">
              <thead>
                <tr>
                  <th className={th}>Started</th>
                  <th className={th}>Drone</th>
                  <th className={th}>Duration</th>
                  <th className={th}>Distance</th>
                  <th className={th}>Max height</th>
                  <th className={th}>Max speed</th>
                  <th className={th}>Battery low</th>
                  <th className={th}>Alerts</th>
                </tr>
              </thead>
              <tbody>
                {flights.map((flight) => {
                  const to = `/flights/${encodeURIComponent(flight.id)}`
                  return (
                    <tr
                      key={flight.id}
                      className="hover:bg-pine-wash"
                      data-testid="flight-row"
                      data-status={flight.status}
                    >
                      <td className={`${td} whitespace-nowrap`}>
                        <a
                          className="font-medium text-pine-strong no-underline hover:underline"
                          href={withBase(to)}
                          onClick={(event) => followLink(event, to)}
                        >
                          {formatDateTime(flight.startedAt)}
                        </a>
                        {flight.status === 'active' && (
                          <Badge tone="ok" className="ml-2">
                            In flight
                          </Badge>
                        )}
                      </td>
                      <td className={td}>
                        <span className="flex items-center gap-2">
                          <ColorDot
                            color={
                              flight.deviceColor ?? devices[flight.deviceSn]?.color ?? 'transparent'
                            }
                          />
                          <span className="font-medium">
                            {devices[flight.deviceSn]
                              ? deviceLabel(devices[flight.deviceSn]!)
                              : (flight.deviceLabel ?? flight.deviceSn)}
                          </span>
                        </span>
                      </td>
                      <td className={`${td} whitespace-nowrap font-mono text-[11px]`}>
                        {durationLabel(flight.durationS)}
                      </td>
                      <td className={`${td} whitespace-nowrap font-mono text-[11px]`}>
                        {distanceLabel(flight.distanceM)}
                      </td>
                      <td className={`${td} whitespace-nowrap font-mono text-[11px]`}>
                        {altitudeLabel(flight.maxAltM)}
                      </td>
                      <td className={`${td} whitespace-nowrap font-mono text-[11px]`}>
                        {speedLabel(flight.maxSpeedMs)}
                      </td>
                      <td className={`${td} whitespace-nowrap font-mono text-[11px]`}>
                        {batteryLabel(flight.minBatteryPct)}
                      </td>
                      <td className={td}>
                        {flight.alertCount > 0 ? (
                          <Badge tone="danger">{flight.alertCount}</Badge>
                        ) : (
                          <span className="text-ink-3">0</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {loading && <p className="mt-4 text-center text-[12px] text-ink-3">Loading flights…</p>}
        {more && !loading && (
          <div className="flex justify-center pt-[18px]">
            <Button variant="secondary" type="button" onClick={() => void loadMore()}>
              Load older flights
            </Button>
          </div>
        )}
      </div>
    </>
  )
}
