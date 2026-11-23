import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { alertIcon, alertKindLabel } from '../alertFormat'
import { beep } from '../alertSound'
import { useFleetData } from '../fleetData'
import { navigate } from '../routes'
import { useFleet } from '../store'
import Button from '../ui/Button'
import ColorDot from './ColorDot'
import Icon from './Icon'

const MAX_TOASTS = 3

/**
 * New alerts (zone, contact lost, battery), announced where the operator is looking: a banner that stays until it is
 * acknowledged or dismissed, and a beep. A warning is a single soft tone, a critical alert (a breach,
 * an exit, contact lost, a critical battery) a double, so they can be told apart without looking.
 */
export default function AlertToasts() {
  const alerts = useFleetData((state) => state.alerts)
  const fresh = useFleetData((state) => state.fresh)
  const markSeen = useFleetData((state) => state.markSeen)
  const setFocus = useFleetData((state) => state.setFocus)
  const devices = useFleet((state) => state.devices)
  const select = useFleet((state) => state.select)
  const [busy, setBusy] = useState<string | null>(null)
  const sounded = useRef(new Set<string>())

  const shown = useMemo(
    () =>
      alerts.filter((alert) => fresh[alert.id] && alert.clearedAt === null).slice(0, MAX_TOASTS),
    [alerts, fresh],
  )

  useEffect(() => {
    for (const alert of shown) {
      if (sounded.current.has(alert.id)) continue
      sounded.current.add(alert.id)
      beep(alert.severity === 'critical')
    }
  }, [shown])

  // An alert that has cleared on its own no longer needs a banner.
  useEffect(() => {
    for (const alert of alerts) if (alert.clearedAt && fresh[alert.id]) markSeen(alert.id)
  }, [alerts, fresh, markSeen])

  if (shown.length === 0) return null

  async function acknowledge(id: string) {
    setBusy(id)
    try {
      await api.acknowledgeAlert(id)
      markSeen(id)
    } catch {
      // the banner stays so it can be tried again
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="pointer-events-none fixed right-4 top-[calc(var(--bar-h)+10px)] z-[75] flex w-[min(400px,calc(100vw-32px))] flex-col gap-2 until-phone-lg:inset-x-3 until-phone-lg:right-auto until-phone-lg:w-auto"
      aria-live="assertive"
      data-testid="alert-toasts"
    >
      {shown.map((alert) => {
        const device = devices[alert.deviceSn]
        const critical = alert.severity === 'critical'
        return (
          <div
            key={alert.id}
            role="alert"
            className={`pointer-events-auto flex w-full items-start gap-3 rounded-[12px] border bg-surface-2 p-3 [box-shadow:var(--shadow-float)] ${
              critical ? 'border-zone-nofly' : 'border-warn-edge'
            }`}
            data-testid="alert-toast"
            data-kind={alert.kind}
          >
            <span
              className={`mt-px grid size-8 flex-none place-items-center rounded-[50%] [&_svg]:size-[17px] ${
                critical ? 'bg-zone-nofly text-white' : 'bg-warn-soft text-warn-text'
              }`}
            >
              <Icon name={alertIcon(alert.kind)} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.07em] text-ink-3">
                {device && <ColorDot color={device.color} />}
                {alertKindLabel[alert.kind]}
              </div>
              <p className="m-0 mt-0.5 text-[13px] font-medium leading-[1.4] text-ink">
                {alert.message}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    select(alert.deviceSn)
                    setFocus(alert.deviceSn)
                    markSeen(alert.id)
                    navigate('/')
                  }}
                >
                  <Icon name="crosshair" />
                  Show on map
                </Button>
                <Button
                  variant="secondary"
                  type="button"
                  disabled={busy === alert.id}
                  onClick={() => void acknowledge(alert.id)}
                >
                  <Icon name="check" />
                  Acknowledge
                </Button>
              </div>
            </div>
            <button
              type="button"
              className="-mr-1 -mt-1 grid size-7 flex-none place-items-center rounded-sm text-ink-3 hover:bg-sunken hover:text-ink [&_svg]:size-3.5"
              aria-label="Dismiss"
              onClick={() => markSeen(alert.id)}
            >
              <Icon name="x" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
