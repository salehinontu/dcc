import { useCallback, useEffect, useState } from 'react'
import {
  can,
  type RecordingAutoDrone,
  type RecordingLocation,
  type RecordingStorage,
} from '@dji/protocol'
import { api, type User } from '../api'
import { deviceLabel } from '../deviceSearch'
import { useFleet } from '../store'
import Button from '../ui/Button'
import Notice from '../ui/Notice'
import { cn } from '../ui/cn'
import { card, eyebrow } from '../ui/surface'
import Icon from './Icon'
import StorageFolderDialog from './StorageFolderDialog'

const STATE_TEXT: Record<RecordingAutoDrone['state'], string> = {
  off: 'Off',
  waiting: 'Waiting for the drone',
  recording: 'Recording now',
  paused: 'Paused: disk full',
}

/** The storage area a folder is in, as the install names it. */
function areaOf(location: RecordingLocation): string | null {
  const area = location.roots.find(
    (root) => location.dir === root.path || location.dir.startsWith(`${root.path}/`),
  )
  return area ? `In: ${area.label}` : null
}

/**
 * Automatic recording, for whoever may record, and (for a Developer) the folder the videos are kept in. A drone
 * switched on here is recorded every time it connects, with nobody at a screen, for as long as it stays on.
 * Disk figures are not shown on purpose: the server clears old automatic footage and pauses recording before the
 * disk is full by itself (`Janitor`), and the only thing worth interrupting an operator for is that pause.
 */
export default function RecordingStoragePanel({
  user,
  refresh = 0,
}: {
  user: User
  refresh?: number
}) {
  const devices = useFleet((state) => state.devices)
  const [storage, setStorage] = useState<RecordingStorage | null>(null)
  const [drones, setDrones] = useState<RecordingAutoDrone[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [location, setLocation] = useState<RecordingLocation | null>(null)
  const [picking, setPicking] = useState(false)
  const allowed = can(user, 'recordings.record')
  // Where the videos are kept is the Developer's choice: the vendor installs the server and picks its disk.
  const mayPlace = user.role === 'developer'

  const loadStorage = useCallback(
    () =>
      api
        .recordingStorage()
        .then(setStorage)
        .catch(() => undefined),
    [],
  )
  const loadDrones = useCallback(
    () =>
      api
        .recordingAuto()
        .then((result) => setDrones(result.drones))
        .catch(() => undefined),
    [],
  )

  const loadLocation = useCallback(
    () =>
      mayPlace
        ? api
            .recordingLocation()
            .then((result) => setLocation(result.location))
            .catch(() => undefined)
        : Promise.resolve(),
    [mayPlace],
  )

  useEffect(() => {
    if (!allowed) return undefined
    void loadStorage()
    void loadLocation()
    void loadDrones()
    const slow = window.setInterval(() => void loadStorage(), 30_000)
    const fast = window.setInterval(() => void loadDrones(), 8_000)
    return () => {
      window.clearInterval(slow)
      window.clearInterval(fast)
    }
  }, [allowed, loadStorage, loadLocation, loadDrones])

  // The page asks for fresh figures after an upload or a delete, so the numbers do not wait for the next look.
  useEffect(() => {
    if (!allowed || refresh === 0) return
    void loadStorage()
    void loadLocation()
    void loadDrones()
  }, [refresh, allowed, loadStorage, loadLocation, loadDrones])

  if (!allowed) return null

  async function change(targets: RecordingAutoDrone[], enabled: boolean) {
    setBusy(true)
    setError('')
    try {
      for (const drone of targets) await api.setRecordingAuto(drone.deviceSn, enabled)
      await Promise.all([loadDrones(), loadStorage()])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const nameOf = (drone: RecordingAutoDrone) =>
    devices[drone.deviceSn]
      ? deviceLabel(devices[drone.deviceSn]!)
      : (drone.deviceName ?? drone.deviceSn)
  const on = drones.filter((drone) => drone.enabled)
  const recording = on.filter((drone) => drone.state === 'recording').length

  return (
    <section className={cn(card, 'mb-4 p-4')} data-testid="recording-storage">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 mr-auto text-[14px] font-semibold">Automatic recording</h2>
        <span className="font-mono text-[10.5px] text-ink-3" data-testid="auto-summary">
          {on.length === 0
            ? 'Automatic recording is off'
            : `${on.length} drone${on.length === 1 ? '' : 's'} set to record · ${recording} recording now`}
        </span>
      </div>

      {storage?.paused && (
        <Notice tone="error" className="mb-3" data-testid="recording-paused">
          Recording is paused. {storage.pausedReason} It starts again by itself when there is room.
        </Notice>
      )}
      {error && (
        <Notice tone="error" className="mb-3" onDismiss={() => setError('')}>
          {error}
        </Notice>
      )}

      {mayPlace && location && (
        <>
          {location.warning && (
            <Notice tone="error" className="mb-3" data-testid="location-warning">
              {location.warning}
            </Notice>
          )}
          <div
            className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface-2 px-3 py-2.5"
            data-testid="storage-location"
          >
            <Icon name="folder" className="size-5 shrink-0 text-pine" />
            <div className="min-w-0 flex-1">
              <div className={eyebrow}>Videos are saved in</div>
              <div
                className="truncate font-mono text-[12.5px] font-medium"
                title={location.dir}
                data-testid="location-dir"
              >
                {location.dir}
              </div>
              {areaOf(location) && (
                <div className="truncate text-[11px] text-ink-3" data-testid="location-area">
                  {areaOf(location)}
                </div>
              )}
              {location.older.length > 0 && (
                <div className="truncate text-[11px] text-ink-3" title={location.older.join('\n')}>
                  Earlier videos are also read from {location.older.join(', ')}
                </div>
              )}
              {location.locked && (
                <div className="text-[11px] text-ink-3">
                  This install fixes the folder in its settings, so it cannot be changed here.
                </div>
              )}
            </div>
            {location.locked ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-ink-3">
                <Icon name="lock" className="size-3.5" />
                Fixed by the install
              </span>
            ) : (
              <Button
                variant="secondary"
                type="button"
                onClick={() => setPicking(true)}
                data-testid="location-change"
              >
                Change folder
              </Button>
            )}
          </div>
        </>
      )}
      {picking && location && (
        <StorageFolderDialog
          current={location}
          onClose={() => setPicking(false)}
          onChanged={() => void Promise.all([loadLocation(), loadStorage()])}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          data-testid="auto-toggle-list"
        >
          {open ? 'Hide drones' : 'Choose the drones that record automatically'}
        </Button>
        {open && drones.length > 0 && (
          <>
            <Button
              variant="secondary"
              type="button"
              disabled={busy || on.length === drones.length}
              onClick={() =>
                void change(
                  drones.filter((drone) => !drone.enabled),
                  true,
                )
              }
              data-testid="auto-all-on"
            >
              Turn on for all
            </Button>
            <Button
              variant="secondary"
              type="button"
              disabled={busy || on.length === 0}
              onClick={() => void change(on, false)}
            >
              Turn off for all
            </Button>
          </>
        )}
      </div>

      {open && (
        <ul className="m-0 mt-3 grid list-none gap-1.5 p-0" data-testid="auto-drones">
          {drones.length === 0 && (
            <li className="text-[12px] text-ink-3">There is no drone you may record.</li>
          )}
          {drones.map((drone) => (
            <li
              key={drone.deviceSn}
              className="flex items-center gap-3 rounded-md border border-line px-3 py-2"
              data-testid="auto-drone"
              data-enabled={drone.enabled ? 'true' : 'false'}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{nameOf(drone)}</span>
                <span className="block font-mono text-[9.5px] text-ink-3">{drone.deviceSn}</span>
              </span>
              <span
                className={cn(
                  'whitespace-nowrap font-mono text-[10.5px]',
                  drone.state === 'recording'
                    ? 'text-live'
                    : drone.state === 'paused'
                      ? 'text-danger-text'
                      : 'text-ink-3',
                )}
              >
                {STATE_TEXT[drone.state]}
                {!drone.online && drone.enabled && drone.state !== 'paused'
                  ? ' · drone is off'
                  : ''}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={drone.enabled}
                aria-label={`Record ${nameOf(drone)} automatically`}
                disabled={busy}
                className={cn(
                  'relative h-5 w-9 flex-none cursor-pointer rounded-full border transition-colors disabled:opacity-50',
                  drone.enabled ? 'border-pine bg-pine' : 'border-line-strong bg-sunken',
                )}
                data-testid="auto-switch"
                onClick={() => void change([drone], !drone.enabled)}
              >
                <span
                  className={cn(
                    'absolute top-0.5 size-3.5 rounded-full bg-white transition-[left]',
                    drone.enabled ? 'left-[18px]' : 'left-0.5',
                  )}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
