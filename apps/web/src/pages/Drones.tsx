import { useMemo, useState } from 'react'
import {
  can,
  DEVICE_LABEL_MAX,
  DRONE_COLORS,
  PILOT_PERMISSIONS,
  type VideoSourceInfo,
} from '@dji/protocol'
import { api, type User } from '../api'
import AddPilot from '../components/AddPilot'
import ColorDot from '../components/ColorDot'
import Icon from '../components/Icon'
import PilotList from '../components/PilotList'
import StageBar from '../components/StageBar'
import VideoSourcePanel from '../components/VideoSourcePanel'
import { deviceLabel, deviceName } from '../deviceSearch'
import { useFleet } from '../store'
import Badge from '../ui/Badge'
import Button from '../ui/Button'
import Notice from '../ui/Notice'
import { cn } from '../ui/cn'
import { emptyPanel, screenBody, td, th } from '../ui/surface'

/**
 * Every aircraft's name, nickname and colour. The nickname is an optional label shown beside the
 * name; the colour is how an aircraft is told apart on the map, on the live wall and in the
 * flight history.
 */
export default function Drones({
  user,
  railOpen,
  onOpenRail,
}: {
  user: User
  railOpen: boolean
  onOpenRail: (trigger: HTMLButtonElement) => void
}) {
  const devices = useFleet((state) => state.devices)
  const applyProfile = useFleet((state) => state.applyProfile)
  const setDevices = useFleet((state) => state.setDevices)
  const removeDevice = useFleet((state) => state.removeDevice)
  const [error, setError] = useState('')
  // The address panel: opened for a new video-only drone, or from a row.
  const [source, setSource] = useState<VideoSourceInfo | null>(null)
  const [adding, setAdding] = useState(false)
  const [addingPilot, setAddingPilot] = useState(false)
  const [created, setCreated] = useState('')
  // Bumped when a pilot is added, so the pilot list loads again.
  const [pilotsVersion, setPilotsVersion] = useState(0)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const canEditDrones = can(user, 'drones.rename')
  const canAddVideoOnly = can(user, 'drones.bind')
  // A drone operator account is made by whoever manages users and may bind drones.
  const canAddPilot = can(user, 'users.manage') && PILOT_PERMISSIONS.every((p) => can(user, p))
  // Whoever may add a video-only drone and see its address may also take it away.
  const mayRemoveVideoOnly = (sn: string) =>
    can(user, 'drones.bind', sn) || can(user, 'drones.delete', sn)
  const fleet = useMemo(
    () => Object.values(devices).sort((a, b) => deviceName(a).localeCompare(deviceName(b))),
    [devices],
  )
  const online = fleet.filter((device) => device.online).length

  async function updateDrone(
    sn: string,
    input: { displayName?: string | null; label?: string | null; color?: string },
  ) {
    setError('')
    try {
      const result = await api.updateDevice(sn, input)
      applyProfile({
        sn,
        displayName: result.displayName,
        label: result.label,
        color: result.color,
      })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function reloadFleet() {
    try {
      setDevices((await api.devices()).devices)
    } catch {
      // The 30-second refresh will catch up.
    }
  }

  async function addVideoOnly() {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError('')
    try {
      const result = await api.createVideoSource(name)
      setSource(result.source)
      setAdding(false)
      setNewName('')
      await reloadFleet()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function showAddress(sn: string) {
    setError('')
    try {
      const found = (await api.videoSources()).sources.find((entry) => entry.sn === sn)
      if (found) setSource(found)
      else setError('That drone has no address to show.')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function newKey(sn: string) {
    if (
      !window.confirm(
        'Make a new key? The old address stops working at once, and a push that is running is cut. Update DJI Fly with the new one.',
      )
    )
      return
    setError('')
    try {
      setSource((await api.rotateVideoSourceKey(sn)).source)
      await reloadFleet()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function removeVideoOnly(sn: string, name: string) {
    if (
      !window.confirm(
        `Remove ${name}? Its address stops working and it leaves the fleet for good. Screenshots already taken are kept.`,
      )
    )
      return
    setError('')
    try {
      await api.deleteVideoSource(sn)
      setSource((current) => (current?.sn === sn ? null : current))
      await reloadFleet()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function removeDrone(sn: string, name: string) {
    if (
      !window.confirm(
        `Delete ${name}? History and screenshots are kept. Future telemetry and video stay blocked until this drone is explicitly rebound from Pilot 2.`,
      )
    )
      return
    setError('')
    try {
      await api.deleteDevice(sn)
      removeDevice(sn)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <>
      <StageBar
        bar="drones"
        title="Drones"
        summary={`${fleet.length} drone${fleet.length === 1 ? '' : 's'} / ${online} online`}
        railOpen={railOpen}
        onOpenRail={onOpenRail}
      />
      <div className={screenBody} data-testid="drones-screen">
        {error && (
          <Notice tone="error" className="mb-3.5" onDismiss={() => setError('')}>
            {error}
          </Notice>
        )}

        {created && (
          <Notice tone="success" className="mb-3.5" onDismiss={() => setCreated('')}>
            {created}
          </Notice>
        )}

        {(canAddVideoOnly || canAddPilot) && (
          <div className="mb-3.5 flex flex-wrap items-center gap-2" data-testid="video-only-add">
            {canAddVideoOnly && adding && (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void addVideoOnly()
                }}
              >
                <input
                  autoFocus
                  value={newName}
                  maxLength={40}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Name, for example Mini 5 Pro"
                  aria-label="Name of the video-only drone"
                  data-testid="video-only-name"
                  className="h-9 w-[260px] max-w-full rounded-md border border-line-strong bg-surface-2 px-3 text-[13px] outline-none focus:border-pine"
                />
                <Button
                  type="submit"
                  variant="mapPrimary"
                  disabled={busy || newName.trim() === ''}
                  data-testid="video-only-create"
                >
                  Create
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAdding(false)
                    setNewName('')
                  }}
                >
                  Cancel
                </Button>
              </form>
            )}
            {canAddPilot && addingPilot && (
              <AddPilot
                actor={user}
                onCancel={() => setAddingPilot(false)}
                onError={setError}
                onCreated={(email) => {
                  setAddingPilot(false)
                  setError('')
                  setCreated(`Drone operator ${email} created.`)
                  setPilotsVersion((version) => version + 1)
                }}
              />
            )}
            {!adding && !addingPilot && canAddVideoOnly && (
              <Button
                variant="secondary"
                onClick={() => setAdding(true)}
                data-testid="video-only-add-button"
              >
                <Icon name="plus" />
                Add video-only drone
              </Button>
            )}
            {!adding && !addingPilot && canAddPilot && (
              <Button
                variant="secondary"
                onClick={() => {
                  setCreated('')
                  setAddingPilot(true)
                }}
                data-testid="pilot-add-button"
              >
                <Icon name="plus" />
                Add drone operator
              </Button>
            )}
          </div>
        )}

        {source && (
          <VideoSourcePanel
            className="mb-3.5"
            source={source}
            onClose={() => setSource(null)}
            onNewKey={() => void newKey(source.sn)}
          />
        )}

        {fleet.length === 0 ? (
          <div className={emptyPanel}>
            <h2 className="m-0 text-[15px] font-semibold">No drones yet</h2>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-white [box-shadow:var(--shadow-card)]">
            <table className="w-full border-collapse" data-testid="drones-table">
              <thead>
                <tr>
                  <th className={th}>Drone</th>
                  <th className={th}>Label</th>
                  <th className={th}>Colour</th>
                  <th className={th}>Status</th>
                  <th className={th}>
                    <span className="sr-only">Drone actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {fleet.map((device) => (
                  <tr key={device.sn} data-testid="drone-row">
                    <td className={td}>
                      <div className="flex items-center gap-2.5">
                        <ColorDot color={device.color} className="size-3" />
                        <div className="min-w-0">
                          {canEditDrones ? (
                            <RenameInput
                              key={`${device.sn}-${device.displayName ?? ''}`}
                              value={device.displayName ?? ''}
                              placeholder={device.model ?? 'Drone'}
                              ariaLabel={`Name of ${deviceLabel(device)}`}
                              onSave={(name) => void updateDrone(device.sn, { displayName: name })}
                            />
                          ) : (
                            <span className="font-medium">
                              {device.displayName?.trim() || device.model || 'Drone'}
                            </span>
                          )}
                          <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9px] text-ink-3">
                            {device.sn}
                            {device.videoOnly && <Badge tone="neutral">Video only</Badge>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className={td}>
                      {canEditDrones ? (
                        <RenameInput
                          key={`${device.sn}-label-${device.label ?? ''}`}
                          value={device.label ?? ''}
                          placeholder="Add a label"
                          ariaLabel={`Label of ${deviceLabel(device)}`}
                          maxLength={DEVICE_LABEL_MAX}
                          onSave={(label) => void updateDrone(device.sn, { label })}
                        />
                      ) : (
                        <span className="text-ink-2">{device.label ?? '—'}</span>
                      )}
                    </td>
                    <td className={td}>
                      <div
                        className="flex flex-wrap items-center gap-1.5"
                        role="group"
                        aria-label={`Colour of ${deviceLabel(device)}`}
                      >
                        {DRONE_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            disabled={!canEditDrones}
                            className={cn(
                              'size-[18px] rounded-[50%] border-2 transition-transform enabled:hover:scale-110',
                              device.color.toLowerCase() === color
                                ? 'border-ink'
                                : 'border-white [box-shadow:0_0_0_1px_var(--line-strong)]',
                            )}
                            style={{ background: color }}
                            aria-label={`Use ${color}`}
                            aria-pressed={device.color.toLowerCase() === color}
                            onClick={() => void updateDrone(device.sn, { color })}
                          />
                        ))}
                        {canEditDrones && (
                          <input
                            type="color"
                            className="size-[22px] cursor-pointer rounded-[50%] border border-line-strong bg-transparent p-0"
                            value={device.color}
                            aria-label="Choose another colour"
                            title="Choose another colour"
                            onChange={(event) =>
                              void updateDrone(device.sn, { color: event.target.value })
                            }
                          />
                        )}
                      </div>
                    </td>
                    <td className={td}>
                      <Badge tone={device.online ? 'ok' : 'neutral'}>
                        {device.online ? 'Online' : 'Offline'}
                      </Badge>
                    </td>
                    <td className={td}>
                      <div
                        className="flex flex-wrap gap-1.5"
                        data-testid={device.videoOnly ? 'video-only-actions' : 'drone-actions'}
                      >
                        {device.videoOnly && canAddVideoOnly && (
                          <Button variant="secondary" onClick={() => void showAddress(device.sn)}>
                            Address
                          </Button>
                        )}
                        {device.videoOnly
                          ? mayRemoveVideoOnly(device.sn) && (
                              <Button
                                variant="secondary"
                                data-testid="remove-drone"
                                onClick={() => void removeVideoOnly(device.sn, deviceLabel(device))}
                              >
                                Remove
                              </Button>
                            )
                          : can(user, 'drones.delete', device.sn) && (
                              <Button
                                variant="secondary"
                                data-testid="remove-drone"
                                onClick={() => void removeDrone(device.sn, deviceLabel(device))}
                              >
                                Remove
                              </Button>
                            )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canAddPilot && (
          <PilotList key={pilotsVersion} actor={user} onNotice={setCreated} onError={setError} />
        )}
      </div>
    </>
  )
}

/** A text field (name or label) that saves when it loses focus or Enter is pressed. */
function RenameInput({
  value,
  placeholder,
  ariaLabel,
  maxLength = 40,
  onSave,
}: {
  value: string
  placeholder: string
  ariaLabel: string
  maxLength?: number
  onSave: (name: string | null) => void
}) {
  const [text, setText] = useState(value)
  const commit = () => {
    const next = text.trim()
    if (next !== value.trim()) onSave(next || null)
  }
  return (
    <input
      className="h-8 w-[200px] rounded-md border border-transparent bg-transparent px-2 text-[13px] font-medium outline-none hover:border-line-strong focus:border-pine focus:bg-surface-2"
      value={text}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setText(value)
          event.currentTarget.blur()
        }
      }}
    />
  )
}
