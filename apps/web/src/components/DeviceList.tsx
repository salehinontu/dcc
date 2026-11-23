import { can } from '@dji/protocol'
import type { User } from '../api'
import { useMemo, useState } from 'react'
import { api } from '../api'
import { deviceLabel, deviceName, matchesSearch } from '../deviceSearch'
import { batteryIsLow, metric, serialTail } from '../format'
import { useFleet } from '../store'
import { cn } from '../ui/cn'
import ColorDot from './ColorDot'
import Icon from './Icon'
import TimeAgo from './TimeAgo'

export default function DeviceList({
  user,
  canRename,
  onSelected,
}: {
  user: User
  canRename: boolean
  onSelected?: () => void
}) {
  const devices = useFleet((state) => state.devices)
  const selected = useFleet((state) => state.selected)
  const select = useFleet((state) => state.select)
  const search = useFleet((state) => state.search)
  const setSearch = useFleet((state) => state.setSearch)
  const setDisplayName = useFleet((state) => state.setDisplayName)

  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const list = useMemo(
    () =>
      Object.values(devices)
        .filter((device) => matchesSearch(device, search))
        .sort((a, b) => deviceName(a).localeCompare(deviceName(b))),
    [devices, search],
  )

  const groups = [
    { key: 'online', label: 'Online', items: list.filter((device) => device.online) },
    { key: 'offline', label: 'Offline', items: list.filter((device) => !device.online) },
  ].filter((group) => group.items.length > 0)

  function choose(sn: string) {
    select(sn)
    onSelected?.()
  }

  function startEdit(sn: string, displayName: string | null) {
    setDraft(displayName ?? '')
    setEditing(sn)
  }

  async function save(sn: string) {
    if (saving) return
    setSaving(true)
    const name = draft.trim()

    try {
      const result = await api.renameDevice(sn, name || null)
      setDisplayName(sn, result.displayName)
    } catch {
      // Keep the previous name; the next refresh will reconcile.
    } finally {
      setSaving(false)
      setEditing(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-parity="device-list">
      <div className="relative px-2.5 py-2" data-parity="fleet-search">
        <Icon
          name="search"
          className="pointer-events-none absolute left-[21px] top-1/2 size-[15px] text-ink-3 [transform:translateY(-50%)]"
        />
        <input
          data-parity="fleet-search-input"
          data-testid="fleet-search-input"
          className="h-[34px] w-full rounded-md border border-line bg-surface-2 py-0 pl-[34px] pr-8 text-[12px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-pine focus:[box-shadow:0_0_0_3px_var(--search-focus-ring)] focus-visible:outline-none"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search fleet"
          aria-label="Search fleet by name, serial or model"
          autoComplete="off"
          spellCheck={false}
        />
        {search && (
          <button
            className="absolute right-4 top-1/2 grid size-[22px] place-items-center rounded-[3px] text-ink-3 [transform:translateY(-50%)] hover:bg-sunken hover:text-ink [&_svg]:size-[13px]"
            data-parity="search-clear"
            data-testid="search-clear"
            type="button"
            onClick={() => setSearch('')}
            aria-label="Clear search"
          >
            <Icon name="x" />
          </button>
        )}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3 [scrollbar-color:var(--line-strong)_transparent] [scrollbar-width:thin]"
        data-parity="fleet-scroll"
      >
        {list.length === 0 ? (
          <div
            className="px-4 py-[26px] text-center text-[12px] leading-[1.6] text-ink-3"
            data-parity="fleet-empty"
          >
            {search
              ? 'No drones match this search.'
              : 'No drones yet. Drones appear here once their controller signs in through Pilot 2.'}
          </div>
        ) : (
          groups.map((group, groupIndex) => (
            <div
              className={groupIndex > 0 ? 'mt-3.5' : undefined}
              key={group.key}
              data-parity={`fleet-group-${group.key}`}
            >
              <div
                className="flex items-center justify-between gap-2 px-[7px] pb-[5px] font-mono text-[9px] uppercase tracking-[0.09em] text-ink-3"
                data-parity={`fleet-group-head-${group.key}`}
              >
                <span>{group.label}</span>
                <span>{group.items.length}</span>
              </div>

              {group.items.map((device, deviceIndex) => {
                const telemetry = device.telemetry
                const battery = telemetry?.batteryPct ?? null
                const active = device.sn === selected
                const label = deviceLabel(device)
                const tail = serialTail(device.sn)
                const editingThis = editing === device.sn

                return (
                  <div
                    key={device.sn}
                    className={cn(
                      'group relative rounded-md border transition-colors',
                      deviceIndex > 0 && 'mt-0.5',
                      active
                        ? 'border-line bg-surface-2 [box-shadow:var(--shadow-card)] before:absolute before:bottom-2 before:left-[-1px] before:top-2 before:w-0.5 before:rounded-[2px] before:bg-gold before:content-[""]'
                        : 'border-transparent hover:bg-pine-wash',
                    )}
                    data-parity={`aircraft-${device.sn}`}
                    data-testid="aircraft"
                  >
                    {editingThis ? (
                      <div
                        className="flex items-center gap-[5px] py-2 pl-[9px] pr-2"
                        data-parity={`aircraft-edit-${device.sn}`}
                      >
                        <input
                          data-parity={`aircraft-rename-input-${device.sn}`}
                          data-testid="aircraft-edit-input"
                          className="h-8 min-w-0 flex-1 rounded-sm border border-pine bg-surface-2 px-2 text-[12px] outline-none"
                          autoFocus
                          value={draft}
                          maxLength={40}
                          placeholder="Display name"
                          aria-label={`Display name for ${label} (${tail})`}
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void save(device.sn)
                            if (event.key === 'Escape') setEditing(null)
                          }}
                        />
                        <button
                          className="grid size-7 flex-none place-items-center rounded-sm border border-line bg-surface-2 text-ink-3 transition-colors hover:bg-sunken hover:text-ink disabled:opacity-40 [&_svg]:size-3.5"
                          data-parity={`aircraft-save-${device.sn}`}
                          type="button"
                          onClick={() => void save(device.sn)}
                          disabled={saving}
                          aria-label="Save display name"
                        >
                          <Icon name="check" />
                        </button>
                        <button
                          className="grid size-7 flex-none place-items-center rounded-sm border border-line bg-surface-2 text-ink-3 transition-colors hover:bg-sunken hover:text-ink [&_svg]:size-3.5"
                          data-parity={`aircraft-cancel-${device.sn}`}
                          type="button"
                          onClick={() => setEditing(null)}
                          aria-label="Cancel rename"
                        >
                          <Icon name="x" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          className="flex w-full items-start gap-[9px] rounded-[inherit] px-[9px] pb-2 pt-[9px] text-left text-inherit focus-visible:outline-offset-[-2px]"
                          data-parity={`aircraft-select-${device.sn}`}
                          type="button"
                          aria-current={active ? 'true' : undefined}
                          aria-label={`Select ${label} (${tail}), ${
                            device.online ? 'online' : 'offline'
                          }${battery != null ? `, ${Math.round(battery)} percent battery` : ''}`}
                          onClick={() => choose(device.sn)}
                        >
                          <span
                            className={cn(
                              'mt-1.5 size-[7px] flex-none rounded-[50%]',
                              device.online ? 'bg-ok' : 'bg-line-strong',
                            )}
                            data-parity={`aircraft-dot-${device.sn}`}
                            aria-hidden="true"
                          />
                          <span
                            className="block min-w-0 flex-1"
                            data-parity={`aircraft-main-${device.sn}`}
                          >
                            <span
                              className="flex items-baseline gap-2"
                              data-parity={`aircraft-line-${device.sn}`}
                            >
                              <ColorDot color={device.color} className="mt-px self-center" />
                              <span
                                className={cn(
                                  'overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium tracking-[-0.005em]',
                                  !device.online && 'text-ink-2',
                                )}
                                data-parity={`aircraft-name-${device.sn}`}
                                data-testid="aircraft-name"
                              >
                                {label}
                              </span>
                              <span
                                className="ml-auto pr-4 font-mono text-[9px] tabular-nums tracking-[0.03em] text-ink-3"
                                data-parity={`aircraft-sn-${device.sn}`}
                              >
                                {tail}
                              </span>
                            </span>

                            {device.videoOnly ? (
                              <span
                                className="mt-[3px] block font-mono text-[10px] text-ink-2"
                                data-parity={`aircraft-stats-${device.sn}`}
                              >
                                Video only · {device.online ? 'streaming' : 'waiting for DJI Fly'}
                              </span>
                            ) : device.online ? (
                              <span
                                className="mt-[3px] flex gap-[11px] font-mono text-[10px] tabular-nums text-ink-2 [&_small]:text-[8.5px] [&_small]:text-ink-3 [&_span]:whitespace-nowrap"
                                data-parity={`aircraft-stats-${device.sn}`}
                              >
                                <span>
                                  {metric(battery)}
                                  <small>%</small>
                                </span>
                                <span>
                                  {metric(telemetry?.altRel)}
                                  <small>m</small>
                                </span>
                                <span>
                                  {metric(telemetry?.speedH, 1)}
                                  <small>m/s</small>
                                </span>
                              </span>
                            ) : (
                              <span
                                className="mt-[3px] flex gap-[11px] font-mono text-[10px] tabular-nums text-ink-2 [&_span]:whitespace-nowrap"
                                data-parity={`aircraft-stats-${device.sn}`}
                              >
                                <TimeAgo
                                  iso={device.lastSeenAt}
                                  prefix={device.lastSeenAt ? 'Last seen' : undefined}
                                  fallback="No telemetry yet"
                                />
                              </span>
                            )}

                            {device.online && battery != null && (
                              <span
                                className="mt-[7px] block h-0.5 overflow-hidden rounded-[1px] bg-sunken"
                                data-parity={`battery-track-${device.sn}`}
                                aria-hidden="true"
                              >
                                <span
                                  className={cn(
                                    'block h-full rounded-[1px]',
                                    batteryIsLow(battery) ? 'bg-warn' : 'bg-ok',
                                  )}
                                  data-parity={`battery-fill-${device.sn}`}
                                  style={{ width: `${Math.max(0, Math.min(100, battery))}%` }}
                                />
                              </span>
                            )}
                          </span>
                        </button>

                        {can(user, 'drones.delete', device.sn) && !device.videoOnly && (
                          <button
                            type="button"
                            className="absolute right-[34px] top-1/2 grid size-[26px] place-items-center rounded-sm bg-surface-2 text-ink-3 opacity-0 transition-opacity [transform:translateY(-50%)] hover:text-danger group-focus-within:opacity-100 group-hover:opacity-100 [&_svg]:size-3.5"
                            title="Delete drone"
                            aria-label={`Delete ${label}`}
                            onClick={() => {
                              if (
                                !window.confirm(
                                  `Delete ${label}? History and screenshots are kept. Future telemetry and video stay blocked until this drone is explicitly rebound from Pilot 2.`,
                                )
                              )
                                return
                              void api
                                .deleteDevice(device.sn)
                                .then(() => useFleet.getState().removeDevice(device.sn))
                                .catch((error: Error) => window.alert(error.message))
                            }}
                          >
                            <Icon name="trash" />
                          </button>
                        )}
                        {canRename && can(user, 'drones.rename', device.sn) && (
                          <button
                            className="absolute right-1 top-1/2 grid size-[26px] place-items-center rounded-sm bg-surface-2 text-ink-3 opacity-0 transition-opacity [transform:translateY(-50%)] hover:text-ink group-focus-within:opacity-100 group-hover:opacity-100 [&_svg]:size-3.5"
                            data-parity={`aircraft-rename-${device.sn}`}
                            data-testid="aircraft-rename"
                            type="button"
                            title="Rename drone"
                            aria-label={`Rename ${label} (${tail})`}
                            onClick={() => startEdit(device.sn, device.displayName)}
                          >
                            <Icon name="edit" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
