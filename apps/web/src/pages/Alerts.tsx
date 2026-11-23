import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AlertRecord } from '@dji/protocol'
import { api } from '../api'
import { alertKindLabel, alertStatus, alertSubject, distanceLabel } from '../alertFormat'
import { setSoundEnabled, soundEnabled } from '../alertSound'
import ColorDot from '../components/ColorDot'
import Icon from '../components/Icon'
import StageBar from '../components/StageBar'
import { useFleetData } from '../fleetData'
import { deviceLabel } from '../deviceSearch'
import { navigate } from '../routes'
import { useFleet } from '../store'
import Badge from '../ui/Badge'
import Button from '../ui/Button'
import Notice from '../ui/Notice'
import { emptyPanel, filterControl, filterLabel, screenBody, td, th } from '../ui/surface'

const stamp = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export default function Alerts({
  railOpen,
  onOpenRail,
}: {
  railOpen: boolean
  onOpenRail: (trigger: HTMLButtonElement) => void
}) {
  const live = useFleetData((state) => state.alerts)
  const loadAlerts = useFleetData((state) => state.loadAlerts)
  const markSeen = useFleetData((state) => state.markSeen)
  const setFocus = useFleetData((state) => state.setFocus)
  const applyAlert = useFleetData((state) => state.applyAlert)
  const devices = useFleet((state) => state.devices)
  const select = useFleet((state) => state.select)
  const [deviceSn, setDeviceSn] = useState('')
  const [openOnly, setOpenOnly] = useState(false)
  const [older, setOlder] = useState<AlertRecord[]>([])
  const [more, setMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sound, setSound] = useState(soundEnabled)

  useEffect(() => {
    void loadAlerts()
    markSeen()
  }, [loadAlerts, markSeen])

  const combined = useMemo(
    () => [...live, ...older.filter((o) => !live.some((l) => l.id === o.id))],
    [live, older],
  )
  const rows = combined.filter(
    (alert) =>
      (!deviceSn || alert.deviceSn === deviceSn) && (!openOnly || alert.clearedAt === null),
  )
  const open = combined.filter((alert) => alert.clearedAt === null).length

  const loadOlder = useCallback(async () => {
    const last = combined[combined.length - 1]
    if (!last) return
    setLoading(true)
    try {
      const { alerts } = await api.alerts({ before: last.raisedAt, limit: 50 })
      setOlder((current) => [...current, ...alerts])
      setMore(alerts.length === 50)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [combined])

  async function acknowledge(alert: AlertRecord) {
    try {
      const { alert: updated } = await api.acknowledgeAlert(alert.id)
      applyAlert(updated)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <>
      <StageBar
        bar="alerts"
        title="Alerts"
        summary={
          open > 0
            ? `${open} open / ${combined.length} recent`
            : `${combined.length} recent, none open`
        }
        actions={
          <Button
            variant="secondary"
            type="button"
            aria-pressed={sound}
            onClick={() => {
              setSoundEnabled(!sound)
              setSound(!sound)
            }}
          >
            <Icon name="bell" />
            Sound {sound ? 'on' : 'off'}
          </Button>
        }
        railOpen={railOpen}
        onOpenRail={onOpenRail}
      />
      <div className={screenBody} data-testid="alerts-screen">
        <div
          className="mb-4 flex flex-wrap items-end gap-2.5"
          role="group"
          aria-label="Filter alerts"
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
          <label className="flex h-8 cursor-pointer items-center gap-2 text-[12px] text-ink-2">
            <input
              type="checkbox"
              className="size-3.5"
              checked={openOnly}
              onChange={(event) => setOpenOnly(event.target.checked)}
            />
            Open alerts only
          </label>
        </div>

        {error && (
          <Notice tone="error" className="mb-3.5" onDismiss={() => setError('')}>
            {error}
          </Notice>
        )}

        {rows.length === 0 ? (
          <div className={emptyPanel}>
            <div>
              <h2 className="mb-1.5 mt-0 text-[15px] font-semibold">No alerts</h2>
              <p className="m-0 max-w-[46ch] text-[12.5px] leading-[1.6] text-ink-3">
                An alert appears here when a drone that is flying comes near or enters a no-fly
                zone, leaves a geofence, loses contact, or runs low on battery. Draw zones on the
                Zones screen.
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-white [box-shadow:var(--shadow-card)]">
            <table className="w-full border-collapse" data-testid="alerts-table">
              <thead>
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>Drone</th>
                  <th className={th}>Alert</th>
                  <th className={th}>Details</th>
                  <th className={th}>Status</th>
                  <th className={th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((alert) => {
                  const device = devices[alert.deviceSn]
                  return (
                    <tr key={alert.id} data-testid="alert-row" data-status={alertStatus(alert)}>
                      <td className={`${td} whitespace-nowrap font-mono text-[11px] text-ink-2`}>
                        {stamp.format(new Date(alert.raisedAt))}
                      </td>
                      <td className={td}>
                        <span className="flex items-center gap-2">
                          {device && <ColorDot color={device.color} />}
                          <span className="font-medium">
                            {device ? deviceLabel(device) : (alert.deviceLabel ?? alert.deviceSn)}
                          </span>
                        </span>
                      </td>
                      <td className={td}>
                        <Badge tone={alert.severity === 'critical' ? 'danger' : 'pending'}>
                          {alertKindLabel[alert.kind]}
                        </Badge>
                      </td>
                      <td className={`${td} max-w-[420px]`}>
                        <span className="block">{alertSubject(alert)}</span>
                        {distanceLabel(alert) && (
                          <span className="block font-mono text-[11px] text-ink-3">
                            {distanceLabel(alert)}
                          </span>
                        )}
                      </td>
                      <td className={td}>
                        {alert.clearedAt ? (
                          <Badge tone="neutral">
                            Cleared {stamp.format(new Date(alert.clearedAt))}
                          </Badge>
                        ) : (
                          <Badge tone="danger">Active</Badge>
                        )}
                        {alert.acknowledgedAt && (
                          <span className="ml-1.5 text-[11px] text-ink-3">acknowledged</span>
                        )}
                      </td>
                      <td className={`${td} text-right`}>
                        <div className="flex min-w-[112px] flex-wrap justify-end gap-1.5">
                          {alert.lat != null && (
                            <Button
                              variant="secondary"
                              type="button"
                              onClick={() => {
                                select(alert.deviceSn)
                                setFocus(alert.deviceSn)
                                navigate('/')
                              }}
                            >
                              Show on map
                            </Button>
                          )}
                          {!alert.acknowledgedAt && alert.clearedAt === null && (
                            <Button
                              variant="secondary"
                              type="button"
                              onClick={() => void acknowledge(alert)}
                            >
                              Acknowledge
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {more && combined.length >= 100 && (
          <div className="flex justify-center pt-[18px]">
            <Button
              variant="secondary"
              type="button"
              disabled={loading}
              onClick={() => void loadOlder()}
            >
              {loading ? 'Loading…' : 'Load older'}
            </Button>
          </div>
        )}
      </div>
    </>
  )
}
