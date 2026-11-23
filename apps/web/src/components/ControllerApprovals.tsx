import { useCallback, useEffect, useState } from 'react'
import { api, type ControllerEnrolment } from '../api'
import Icon from './Icon'
import TimeAgo from './TimeAgo'

const actionClass =
  'grid size-7 flex-none place-items-center rounded-sm border border-line bg-surface-2 text-ink-2 transition-colors hover:bg-sunken hover:text-ink disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5'

/**
 * Controllers waiting for an admin. A row here means some RC presented a valid pilot account
 * and asked to join the fleet: it holds no MQTT credentials until it is approved. The list
 * doubles as the fleet's intrusion signal, which is why it lives in the rail rather than
 * behind an admin page.
 */
export default function ControllerApprovals({ canApprove }: { canApprove: boolean }) {
  const [rows, setRows] = useState<ControllerEnrolment[]>([])
  const [busySn, setBusySn] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const result = await api.controllers()
      setRows(result.controllers.filter((row) => row.status === 'pending'))
    } catch {
      // The rest of the rail keeps working if the list cannot be fetched.
    }
  }, [])

  useEffect(() => {
    if (!canApprove) return undefined
    void refresh()
    const poll = window.setInterval(() => void refresh(), 15_000)
    return () => clearInterval(poll)
  }, [canApprove, refresh])

  async function decide(sn: string, action: 'approve' | 'reject') {
    setBusySn(sn)
    setError(null)
    try {
      if (action === 'approve') await api.approveController(sn)
      else await api.rejectController(sn)
      await refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'the request failed')
    } finally {
      setBusySn(null)
    }
  }

  if (!canApprove || rows.length === 0) return null

  return (
    <section
      className="border-b border-b-line px-3 py-3"
      data-parity="approvals"
      data-testid="pending-controllers"
      aria-label="Controllers awaiting approval"
    >
      <div className="flex items-center gap-2 font-mono text-[8.5px] uppercase tracking-[0.08em] text-warn-text">
        <span className="size-1.5 flex-none rounded-[50%] bg-warn" aria-hidden="true" />
        <span>Awaiting approval</span>
        <span className="ml-auto tabular-nums">{rows.length}</span>
      </div>

      <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
        {rows.map((row) => (
          <li
            className="rounded-md border border-warn-edge bg-warn-soft px-2 py-1.5"
            data-parity="pending-controller"
            data-testid="pending-controller"
            key={row.controllerSn}
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <strong className="block overflow-hidden whitespace-nowrap font-mono text-[9.5px] font-medium text-ink-2 text-ellipsis">
                  {row.controllerSn}
                </strong>
                <span className="mt-px block font-mono text-[8px] text-ink-3">
                  <TimeAgo iso={row.requestedAt} fallback="just now" />
                  {row.aircraftSns.length > 0
                    ? ` · ${row.aircraftSns.length} drone${row.aircraftSns.length === 1 ? '' : 's'}`
                    : ' · no drones yet'}
                </span>
              </div>
              <button
                className={actionClass}
                type="button"
                data-testid="approve-controller"
                aria-label={`Approve ${row.controllerSn}`}
                title="Approve"
                disabled={busySn === row.controllerSn}
                onClick={() => void decide(row.controllerSn, 'approve')}
              >
                <Icon name="check" />
              </button>
              <button
                className={actionClass}
                type="button"
                data-testid="reject-controller"
                aria-label={`Reject ${row.controllerSn}`}
                title="Reject"
                disabled={busySn === row.controllerSn}
                onClick={() => void decide(row.controllerSn, 'reject')}
              >
                <Icon name="x" />
              </button>
            </div>
          </li>
        ))}
      </ul>

      {error && <p className="m-0 mt-2 text-[9.5px] leading-[1.4] text-danger-text">{error}</p>}
    </section>
  )
}
