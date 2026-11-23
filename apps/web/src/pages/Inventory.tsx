import { useCallback, useEffect, useMemo, useState } from 'react'
import { can } from '@dji/protocol'
import { api, type ControllerEnrolment, type InventoryDevice, type User } from '../api'
import { withBase } from '../base'
import Icon from '../components/Icon'
import StageBar from '../components/StageBar'
import TimeAgo from '../components/TimeAgo'
import { followLink, type AppRoute } from '../routes'
import Badge, { type BadgeTone } from '../ui/Badge'
import Button from '../ui/Button'
import Notice from '../ui/Notice'
import { cn } from '../ui/cn'
import { card, emptyPanel, eyebrow, screenBody, segment, td, th, tileFoot } from '../ui/surface'

const controllerTone: Record<ControllerEnrolment['status'], BadgeTone> = {
  approved: 'ok',
  pending: 'pending',
  rejected: 'danger',
}

type ControllerAction = 'approve' | 'reject' | 'unbind'

/**
 * The two admin inventories. Both answer "what does the system know about, and what state is
 * it in" — questions the fleet rail deliberately does not answer, because it shows only what
 * is live.
 *
 * Deleted aircraft are read-only here on purpose. Restoring one requires the controller that
 * owned it, since holding that handset is the only proof the aircraft is in your custody;
 * there is no admin override, and that is a decision, not a missing button.
 */
export default function Inventory({
  user,
  route,
  railOpen,
  onOpenRail,
}: {
  user: User
  route: Extract<AppRoute, { name: 'controllers' | 'aircraft' }>
  railOpen: boolean
  onOpenRail: (trigger: HTMLButtonElement) => void
}) {
  const tab = route.name
  const [controllers, setControllers] = useState<ControllerEnrolment[]>([])
  const [devices, setDevices] = useState<InventoryDevice[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const [c, d] = await Promise.all([api.controllers(), api.inventory()])
      setControllers(c.controllers)
      setDevices(d.devices)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
    const poll = window.setInterval(() => void load(), 20_000)
    return () => clearInterval(poll)
  }, [load])

  async function controllerAction(sn: string, action: ControllerAction) {
    if (
      action !== 'approve' &&
      !window.confirm(
        action === 'reject'
          ? `Reject ${sn}? It loses MQTT credentials and its drones stop reporting until you approve it again.`
          : `Unbind ${sn}? Its drones stop reporting until it is approved again.`,
      )
    )
      return
    setBusy(sn)
    setError('')
    setNotice('')
    try {
      if (action === 'approve') await api.approveController(sn)
      else if (action === 'reject') await api.rejectController(sn)
      else await api.unbindController(sn)
      setNotice(
        `${sn} ${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'unbound'}.`,
      )
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function toggleDevice(device: InventoryDevice) {
    const enabling = device.disabledAt !== null
    if (
      !enabling &&
      !window.confirm(
        `Disable ${device.displayName ?? device.sn}? It disappears from the map and wall, its streams stop, and its telemetry is refused at the broker.`,
      )
    )
      return
    setBusy(device.sn)
    setError('')
    setNotice('')
    try {
      await api.setDeviceEnabled(device.sn, enabling)
      setNotice(
        `${device.displayName ?? device.sn} ${enabling ? 'enabled' : 'disabled'}${
          enabling ? '. It stays offline until it reports again.' : '.'
        }`,
      )
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const grouped = useMemo(() => {
    const deleted = devices.filter((d) => d.deletedAt !== null)
    const disabled = devices.filter((d) => d.deletedAt === null && d.disabledAt !== null)
    const active = devices.filter((d) => d.deletedAt === null && d.disabledAt === null)
    return { active, disabled, deleted }
  }, [devices])

  const mayManage = can(user, 'inventory.manage')
  const mayDisable = can(user, 'drones.delete')
  const pendingCount = controllers.filter((c) => c.status === 'pending').length
  const onlineCount = grouped.active.filter((d) => d.online).length

  const summary = !loaded
    ? 'Loading inventory'
    : tab === 'controllers'
      ? [
          `${controllers.length} ${controllers.length === 1 ? 'controller' : 'controllers'}`,
          pendingCount > 0 ? `${pendingCount} awaiting approval` : null,
          `${controllers.filter((c) => c.status === 'approved').length} approved`,
        ]
          .filter(Boolean)
          .join(' / ')
      : [
          `${devices.length} drone${devices.length === 1 ? '' : 's'}`,
          `${onlineCount} online`,
          grouped.disabled.length > 0 ? `${grouped.disabled.length} disabled` : null,
          grouped.deleted.length > 0 ? `${grouped.deleted.length} deleted` : null,
        ]
          .filter(Boolean)
          .join(' / ')

  const tabs = [
    {
      name: 'controllers',
      label: 'Controllers',
      count: controllers.length,
      to: '/inventory/controllers',
    },
    { name: 'aircraft', label: 'Drones', count: devices.length, to: '/inventory/aircraft' },
  ] as const

  return (
    <>
      <StageBar
        bar="inventory"
        title="Controllers and drones"
        summary={summary}
        actions={
          <Button variant="secondary" onClick={() => void load()} aria-label="Refresh inventory">
            <Icon name="refresh" />
            <span className="until-phone-lg:hidden">Refresh</span>
          </Button>
        }
        railOpen={railOpen}
        onOpenRail={onOpenRail}
      />
      <section className={screenBody} data-testid="admin-inventory">
        <div className="grid gap-3.5">
          <nav className="flex flex-wrap items-center gap-1.5" aria-label="Inventory">
            <span className="mr-1 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-3">
              Show
            </span>
            {tabs.map((entry) => (
              <a
                key={entry.name}
                href={withBase(entry.to)}
                aria-current={tab === entry.name ? 'page' : undefined}
                data-testid={`inventory-tab-${entry.name}`}
                className={segment(tab === entry.name)}
                onClick={(event) => followLink(event, entry.to)}
              >
                {entry.label}
                <span className="font-mono text-[10px] tabular-nums opacity-80">{entry.count}</span>
              </a>
            ))}
          </nav>

          {error && (
            <Notice tone="error" onDismiss={() => setError('')}>
              {error}
            </Notice>
          )}
          {notice && (
            <Notice tone="success" onDismiss={() => setNotice('')}>
              {notice}
            </Notice>
          )}

          {tab === 'controllers' ? (
            !loaded ? (
              <p className="m-0 text-[12.5px] text-ink-3">Loading controllers…</p>
            ) : controllers.length === 0 ? (
              <div className={emptyPanel}>
                <div>
                  <h2 className="mb-1.5 mt-0 text-[15px] font-semibold">No controllers yet</h2>
                  <p className="m-0 max-w-[44ch] text-[12.5px] leading-[1.6] text-ink-3">
                    A controller appears here the first time a drone operator signs in on it. It
                    holds no credentials until you approve it.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className={cn(card, 'overflow-x-auto until-stack:hidden')}>
                  <table
                    className="w-full min-w-[720px] border-collapse"
                    data-testid="controller-table"
                  >
                    <thead>
                      <tr>
                        <th className={th}>Controller</th>
                        <th className={th}>Status</th>
                        <th className={th}>Drones</th>
                        <th className={th}>Requested</th>
                        <th className={th}>Decided by</th>
                        <th className={cn(th, 'text-right')}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {controllers.map((row) => (
                        <tr
                          key={row.controllerSn}
                          className="transition-colors hover:bg-pine-wash"
                          data-testid="controller-row"
                        >
                          <td className={td}>
                            <strong className="font-mono text-[11.5px] font-medium">
                              {row.controllerSn}
                            </strong>
                          </td>
                          <td className={td}>
                            <Badge tone={controllerTone[row.status]} className="capitalize">
                              {row.status}
                            </Badge>
                          </td>
                          <td className={td}>
                            {row.aircraftSns.length === 0 ? (
                              <span className="text-ink-3">None listed</span>
                            ) : (
                              <span className="font-mono text-[11px]">
                                {row.aircraftSns.join(', ')}
                              </span>
                            )}
                          </td>
                          <td className={cn(td, 'text-ink-3')}>
                            <TimeAgo iso={row.requestedAt} fallback="just now" />
                          </td>
                          <td className={cn(td, 'text-ink-3')}>{decidedBy(row)}</td>
                          <td className={cn(td, 'text-right')}>
                            {mayManage && (
                              <ControllerActions
                                row={row}
                                busy={busy === row.controllerSn}
                                onAction={controllerAction}
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <ul
                  className="m-0 hidden list-none gap-2.5 p-0 until-stack:grid"
                  aria-label="Controllers"
                >
                  {controllers.map((row) => (
                    <li
                      key={row.controllerSn}
                      className={cn(card, 'overflow-hidden')}
                      data-testid="controller-card"
                    >
                      <div className="grid gap-2 px-3.5 pb-3 pt-3">
                        <div className="flex items-center gap-2">
                          <strong className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium">
                            {row.controllerSn}
                          </strong>
                          <Badge tone={controllerTone[row.status]} className="capitalize">
                            {row.status}
                          </Badge>
                        </div>
                        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11.5px]">
                          <dt className={eyebrow}>Drones</dt>
                          <dd className="m-0 break-all font-mono text-[11px] text-ink-2">
                            {row.aircraftSns.length ? row.aircraftSns.join(', ') : 'None listed'}
                          </dd>
                          <dt className={eyebrow}>Requested</dt>
                          <dd className="m-0 text-ink-2">
                            <TimeAgo iso={row.requestedAt} fallback="just now" />
                          </dd>
                          <dt className={eyebrow}>Decided</dt>
                          <dd className="m-0 truncate text-ink-2">{decidedBy(row)}</dd>
                        </dl>
                      </div>
                      {mayManage && (
                        <div className={cn('border-t border-line-soft px-3.5 py-2.5', tileFoot)}>
                          <ControllerActions
                            row={row}
                            busy={busy === row.controllerSn}
                            onAction={controllerAction}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )
          ) : !loaded ? (
            <p className="m-0 text-[12.5px] text-ink-3">Loading drones…</p>
          ) : devices.length === 0 ? (
            <div className={emptyPanel}>
              <div>
                <h2 className="mb-1.5 mt-0 text-[15px] font-semibold">No drones yet</h2>
                <p className="m-0 max-w-[44ch] text-[12.5px] leading-[1.6] text-ink-3">
                  Drones are added automatically when an approved controller reports them.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid gap-3.5">
              <AircraftTable
                title="Active"
                rows={grouped.active}
                busy={busy}
                mayDisable={mayDisable}
                onToggle={toggleDevice}
                testId="aircraft-active"
              />
              <AircraftTable
                title="Disabled"
                note="Hidden from the map and wall, refused at the broker. Re-enable at any time — no controller needed."
                rows={grouped.disabled}
                busy={busy}
                mayDisable={mayDisable}
                onToggle={toggleDevice}
                testId="aircraft-disabled"
              />
              <AircraftTable
                title="Deleted"
                note="Kept with their history. Only the controller that owned a drone can restore it — holding that handset is the proof of custody, so there is no admin override."
                rows={grouped.deleted}
                busy={busy}
                mayDisable={false}
                onToggle={toggleDevice}
                testId="aircraft-deleted"
              />
            </div>
          )}
        </div>
      </section>
    </>
  )
}

function decidedBy(row: ControllerEnrolment) {
  if (row.approvedBy) return <span title={row.approvedAt ?? undefined}>{row.approvedBy}</span>
  return row.note ?? '—'
}

function ControllerActions({
  row,
  busy,
  onAction,
}: {
  row: ControllerEnrolment
  busy: boolean
  onAction: (sn: string, action: ControllerAction) => Promise<void>
}) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      {row.status !== 'approved' && (
        <Button
          variant="secondary"
          disabled={busy}
          aria-label={`Approve ${row.controllerSn}`}
          onClick={() => void onAction(row.controllerSn, 'approve')}
        >
          <Icon name="check" />
          Approve
        </Button>
      )}
      {row.status === 'approved' && (
        <Button
          variant="secondary"
          disabled={busy}
          aria-label={`Unbind ${row.controllerSn}`}
          onClick={() => void onAction(row.controllerSn, 'unbind')}
        >
          <Icon name="lock" />
          Unbind
        </Button>
      )}
      {row.status !== 'rejected' && (
        <Button
          variant="secondary"
          disabled={busy}
          aria-label={`Reject ${row.controllerSn}`}
          onClick={() => void onAction(row.controllerSn, 'reject')}
        >
          <Icon name="x" />
          Reject
        </Button>
      )}
    </span>
  )
}

function lastSeen(device: InventoryDevice) {
  if (device.deletedAt)
    return <TimeAgo iso={device.deletedAt} prefix="Deleted" fallback="deleted" />
  if (device.disabledAt)
    return <TimeAgo iso={device.disabledAt} prefix="Disabled" fallback="disabled" />
  return (
    <TimeAgo
      iso={device.lastSeenAt}
      prefix={device.online ? 'Online' : 'Last seen'}
      fallback={device.online ? 'Online' : 'Never seen'}
    />
  )
}

function AircraftTable({
  title,
  note,
  rows,
  busy,
  mayDisable,
  onToggle,
  testId,
}: {
  title: string
  note?: string
  rows: InventoryDevice[]
  busy: string | null
  mayDisable: boolean
  onToggle: (device: InventoryDevice) => Promise<void>
  testId: string
}) {
  if (rows.length === 0) return null

  const action = (device: InventoryDevice) =>
    device.deletedAt !== null ? (
      <span className="text-[11.5px] text-ink-3">Restore from the controller</span>
    ) : mayDisable ? (
      <Button
        variant="secondary"
        disabled={busy === device.sn}
        aria-label={`${device.disabledAt ? 'Enable' : 'Disable'} ${device.displayName ?? device.sn}`}
        onClick={() => void onToggle(device)}
      >
        <Icon name={device.disabledAt ? 'check' : 'lock'} />
        {device.disabledAt ? 'Enable' : 'Disable'}
      </Button>
    ) : null

  return (
    <div className={cn(card, 'overflow-hidden')} data-testid={testId}>
      <div className={cn('border-b border-line-soft px-3.5 py-2.5', tileFoot)}>
        <span className={eyebrow}>
          {title} · {rows.length}
        </span>
        {note && <p className="m-0 mt-1 text-[11.5px] leading-[1.5] text-ink-3">{note}</p>}
      </div>
      <div className="overflow-x-auto until-stack:hidden">
        <table className="w-full min-w-[620px] border-collapse">
          <thead>
            <tr>
              <th className={th}>Drone</th>
              <th className={th}>Controller</th>
              <th className={th}>Last seen</th>
              <th className={cn(th, 'text-right')}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((device) => (
              <tr
                key={device.sn}
                className="transition-colors hover:bg-pine-wash"
                data-testid="aircraft-row"
              >
                <td className={td}>
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        'size-1.5 flex-none rounded-[50%]',
                        device.online && !device.disabledAt && !device.deletedAt
                          ? 'bg-ok'
                          : 'bg-line-strong',
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <strong className="font-medium">{device.displayName ?? device.sn}</strong>
                      {device.label && (
                        <span className="ml-1.5 text-[11px] text-ink-3">· {device.label}</span>
                      )}
                      {device.displayName && (
                        <span className="mt-px block font-mono text-[10px] text-ink-3">
                          {device.sn}
                        </span>
                      )}
                    </span>
                  </span>
                </td>
                <td className={cn(td, 'font-mono text-[11px] text-ink-2')}>
                  {device.gatewaySn ?? '—'}
                </td>
                <td className={cn(td, 'text-ink-3')}>{lastSeen(device)}</td>
                <td className={cn(td, 'text-right')}>{action(device)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="m-0 hidden list-none p-0 until-stack:block">
        {rows.map((device) => (
          <li
            key={device.sn}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-soft px-3.5 py-3 last:border-b-0"
            data-testid="aircraft-card"
          >
            <div className="min-w-0 flex-1">
              <strong className="block truncate text-[12.5px] font-medium">
                {device.displayName ?? device.sn}
                {device.label && (
                  <span className="ml-1.5 font-normal text-ink-3">· {device.label}</span>
                )}
              </strong>
              <span className="mt-0.5 block truncate font-mono text-[9.5px] tracking-[0.04em] text-ink-3">
                {device.displayName ? `${device.sn} · ` : ''}RC {device.gatewaySn ?? '—'}
              </span>
              <span className="mt-0.5 block text-[11px] text-ink-3">{lastSeen(device)}</span>
            </div>
            {action(device)}
          </li>
        ))}
      </ul>
    </div>
  )
}
