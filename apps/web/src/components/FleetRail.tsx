import { useEffect, useRef } from 'react'
import { can } from '@dji/protocol'
import type { User } from '../api'
import { openAlerts, useFleetData } from '../fleetData'
import { initials, roleLabel } from '../format'
import { withBase } from '../base'
import { followLink, type View } from '../routes'
import BrandLockup from '../ui/BrandLockup'
import ControllerApprovals from './ControllerApprovals'
import DeviceList from './DeviceList'
import Icon, { type IconName } from './Icon'
import TimeAgo from './TimeAgo'

const iconButton =
  'grid size-8 flex-none place-items-center rounded-sm border border-transparent text-ink-3 transition-colors hover:bg-sunken hover:text-ink [&_svg]:size-4'

export default function FleetRail({
  user,
  connected,
  onlineCount,
  view,
  lastUpdate,
  open,
  canRename,
  onNavigate,
  onLogout,
  onChangePassword,
  onClose,
  onDeviceSelected,
}: {
  user: User
  connected: boolean
  onlineCount: number
  view: View
  lastUpdate: string | null
  open: boolean
  canRename: boolean
  onNavigate: () => void
  onLogout: () => void
  onChangePassword: () => void
  onClose: () => void
  onDeviceSelected: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const openAlertCount = useFleetData((state) => openAlerts(state.alerts).length)

  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])

  const navClass = (active: boolean) =>
    [
      'flex h-[38px] w-full items-center gap-2.5 rounded-[12px] border px-2.5 text-left text-[12.5px] font-medium no-underline transition-colors [&_svg]:size-[17px]',
      active
        ? 'border-line-soft [background-image:linear-gradient(135deg,var(--pine-soft),var(--pine-tint))] font-semibold text-pine-strong [box-shadow:inset_3px_0_0_var(--gold)]'
        : 'border-transparent text-ink-2 hover:bg-pine-wash hover:text-ink',
    ].join(' ')

  const navItems: { view: View; to: string; icon: IconName; label: string; show: boolean }[] = [
    {
      view: 'map',
      to: '/',
      icon: 'map',
      label: 'Operations map',
      show: can(user, 'map.view'),
    },
    {
      view: 'wall',
      to: '/live',
      icon: 'wall',
      label: 'Live wall',
      show: can(user, 'wall.view'),
    },
    {
      view: 'shots',
      to: '/screenshots',
      icon: 'image',
      label: 'Screenshots',
      show: can(user, 'shots.view'),
    },
    {
      view: 'recordings',
      to: '/recordings',
      icon: 'play',
      label: 'Recordings',
      show: can(user, 'recs.view'),
    },
    {
      view: 'flights',
      to: '/flights',
      icon: 'route',
      label: 'Flight history',
      show: can(user, 'history.view'),
    },
    {
      view: 'zones',
      to: '/zones',
      icon: 'zone',
      label: 'Zones and geofences',
      show: can(user, 'zones.view'),
    },
    {
      view: 'alerts',
      to: '/alerts',
      icon: 'bell',
      label: 'Alerts',
      show: can(user, 'alerts.view'),
    },
    {
      view: 'drones',
      to: '/drones',
      icon: 'drone',
      label: 'Drones',
      show: can(user, 'fleet.view'),
    },
    {
      view: 'users',
      to: '/users',
      icon: 'users',
      label: 'Users and permissions',
      show: can(user, 'users.manage'),
    },
    {
      view: 'inventory',
      to: '/inventory/controllers',
      icon: 'server',
      label: 'Controllers and drones',
      show: can(user, 'inventory.manage'),
    },
    {
      view: 'audit',
      to: '/audit',
      icon: 'list',
      label: 'Audit log',
      show: can(user, 'audit.view'),
    },
    {
      view: 'api-access',
      to: '/integrations',
      icon: 'link',
      label: 'API access',
      show: can(user, 'api.manage'),
    },
  ]

  return (
    <aside
      className={`flex min-h-0 flex-col border-r border-r-line [background-image:linear-gradient(180deg,var(--surface-2)_0%,var(--surface)_100%)] [box-shadow:var(--rail-shadow)] until-drawer:absolute until-drawer:inset-y-0 until-drawer:left-0 until-drawer:z-30 until-drawer:w-[300px] until-drawer:max-w-[86%] until-drawer:transition-[transform,translate] until-drawer:duration-200 ${
        open ? 'until-drawer:translate-x-0' : 'until-drawer:-translate-x-full'
      }`}
      id="fleet-rail"
      data-parity="rail"
      aria-label="Fleet"
    >
      <div
        className="h-[3px] flex-none [background-image:linear-gradient(90deg,var(--pine-strong),var(--pine)_62%,var(--gold))]"
        aria-hidden="true"
      />
      <div className="flex items-center gap-2.5 px-4 pb-3.5 pt-[14px]" data-parity="rail-head">
        <BrandLockup variant="rail" />
        <button
          ref={closeRef}
          className={`${iconButton} ml-auto hidden until-drawer:grid`}
          data-parity="rail-close"
          type="button"
          aria-label="Close fleet panel"
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </div>

      <div
        className="flex items-center gap-2 border-b border-b-line px-4 pb-3.5 text-[11px] text-ink-2"
        data-parity="rail-link"
      >
        <span
          className={`size-1.5 flex-none rounded-[50%] ${
            connected
              ? 'bg-ok [box-shadow:0_0_0_3px_var(--ok-soft)]'
              : 'bg-warn [box-shadow:0_0_0_3px_var(--warn-soft)]'
          }`}
          aria-hidden="true"
        />
        <span>{connected ? 'Telemetry live' : 'Reconnecting'}</span>
        <span
          className="ml-auto font-mono text-[9px] tracking-[0.04em] text-ink-3"
          data-parity="rail-sync"
        >
          {connected ? (
            <TimeAgo
              iso={lastUpdate}
              prefix={lastUpdate ? 'synced' : undefined}
              fallback="waiting for telemetry"
            />
          ) : (
            'link offline'
          )}
        </span>
      </div>

      <nav
        className="flex max-h-[52%] flex-none flex-col gap-0.5 overflow-y-auto px-2.5 pb-2 pt-2.5 [scrollbar-width:thin]"
        data-parity="rail-nav"
        aria-label="Views"
      >
        {navItems.map((item) =>
          item.show ? (
            <a
              key={item.view}
              className={navClass(view === item.view)}
              data-parity={`nav-${item.view}`}
              href={withBase(item.to)}
              data-view={item.view}
              aria-current={view === item.view ? 'page' : undefined}
              onClick={(event) => {
                if (followLink(event, item.to)) onNavigate()
              }}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.view === 'alerts' && openAlertCount > 0 && (
                <span
                  className="ml-auto rounded-[999px] bg-zone-nofly px-1.5 py-px font-mono text-[9px] font-semibold leading-[1.5] tabular-nums text-white"
                  data-testid="alert-count"
                  aria-label={`${openAlertCount} open alerts`}
                >
                  {openAlertCount}
                </span>
              )}
              {item.view === 'wall' && (
                <span
                  className={`ml-auto rounded-[999px] border bg-surface-2 px-1.5 py-px font-mono text-[9px] leading-[1.5] tabular-nums ${
                    view === 'wall' ? 'border-line-rose text-pine-strong' : 'border-line text-ink-3'
                  }`}
                  data-parity="nav-count"
                >
                  {onlineCount}
                </span>
              )}
            </a>
          ) : null,
        )}
      </nav>

      <ControllerApprovals canApprove={can(user, 'inventory.manage')} />

      <DeviceList user={user} canRename={canRename} onSelected={onDeviceSelected} />

      <div
        className="flex items-center gap-[9px] border-t border-t-line px-3 py-[11px]"
        data-parity="rail-foot"
      >
        <span
          className="grid size-7 flex-none place-items-center rounded-[50%] bg-pine-soft text-[9.5px] font-semibold tracking-[0.02em] text-pine-strong"
          data-parity="rail-avatar"
          aria-hidden="true"
        >
          {initials(user.email)}
        </span>
        <div className="min-w-0 flex-1" data-parity="rail-user">
          <strong className="block overflow-hidden whitespace-nowrap text-[11px] font-medium text-ellipsis">
            {user.email}
          </strong>
          <span className="mt-px block font-mono text-[8.5px] uppercase tracking-[0.06em] text-ink-3">
            {roleLabel(user.role)}
          </span>
        </div>
        <button
          className={iconButton}
          data-parity="rail-password"
          data-testid="change-password-open"
          type="button"
          aria-label="Change your email or password"
          title="Change your email or password"
          onClick={onChangePassword}
        >
          <Icon name="lock" />
        </button>
        <button
          className={iconButton}
          data-parity="rail-logout"
          type="button"
          aria-label="Sign out"
          title="Sign out"
          onClick={onLogout}
        >
          <Icon name="logout" />
        </button>
      </div>
    </aside>
  )
}
