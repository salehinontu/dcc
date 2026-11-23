import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PILOT_PERMISSIONS } from '@dji/protocol'
import { api, type User } from '../api'
import { generatePassword } from '../password'
import Badge from '../ui/Badge'
import Button from '../ui/Button'
import { td, th } from '../ui/surface'

const field =
  'h-9 rounded-md border border-line-strong bg-surface-2 px-3 font-mono text-[13px] outline-none focus:border-pine'

/**
 * The drone operator accounts the signed-in account may see, with what can be done to each: a new password,
 * disabling, deleting. They live on the Drones screen with the drones their controllers fly, not
 * in the Users list. A Developer sees every customer's drone operators and which Admin each belongs to.
 */
export default function PilotList({
  actor,
  onNotice,
  onError,
}: {
  actor: User
  onNotice: (message: string) => void
  onError: (message: string) => void
}) {
  const [pilots, setPilots] = useState<User[] | null>(null)
  const [adminEmails, setAdminEmails] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<string | null>(null)
  const [resetting, setResetting] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const isDeveloper = actor.role === 'developer'

  const load = useCallback(() => {
    api
      .users()
      .then(({ users }) => {
        setPilots(users.filter((entry) => entry.role === 'pilot'))
        setAdminEmails(
          Object.fromEntries(
            users.filter((entry) => entry.role === 'admin').map((admin) => [admin.id, admin.email]),
          ),
        )
      })
      .catch((e: Error) => {
        setPilots([])
        onError(e.message)
      })
  }, [onError])
  useEffect(load, [load])

  // A drone operator's access is fixed; the edit route still wants the whole access in its body.
  const access = (disabled: boolean) => ({
    role: 'pilot',
    permissions: [...PILOT_PERMISSIONS],
    allDrones: true,
    dronePermissions: {},
    disabled,
  })

  async function toggleDisabled(entry: User) {
    const disabling = !entry.disabled
    if (disabling && !window.confirm(`Disable ${entry.email}? Their controller is disconnected.`))
      return
    setPending(entry.id)
    try {
      await api.updateUser(entry.id, access(disabling))
      onNotice(`${entry.email} ${disabling ? 'disabled' : 'enabled'}.`)
      load()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  async function remove(entry: User) {
    if (
      !window.confirm(
        `Delete ${entry.email} for good?\n\nTheir controller is disconnected. This cannot be undone.`,
      )
    )
      return
    setPending(entry.id)
    try {
      await api.deleteUser(entry.id)
      onNotice(`${entry.email} deleted.`)
      load()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  async function savePassword(event: FormEvent, entry: User) {
    event.preventDefault()
    setPending(entry.id)
    try {
      await api.updateUser(entry.id, { ...access(Boolean(entry.disabled)), password })
      onNotice(`${entry.email} has a new password. Their controller signs in again.`)
      setResetting(null)
      setPassword('')
      load()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  const valid = password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH

  return (
    <section className="mt-7" data-testid="pilot-list">
      <h2 className="mb-2.5 mt-0 text-[15px] font-semibold">Drone operators</h2>
      {pilots === null ? null : pilots.length === 0 ? (
        <p className="m-0 text-[13px] text-ink-3">No drone operators yet</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-white [box-shadow:var(--shadow-card)]">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Drone operator</th>
                {isDeveloper && <th className={th}>Admin</th>}
                <th className={th}>Status</th>
                <th className={th}>
                  <span className="sr-only">Drone operator actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pilots.map((entry) => (
                <tr key={entry.id} data-testid="pilot-row">
                  <td className={td}>
                    <span className="font-medium">{entry.email}</span>
                  </td>
                  {isDeveloper && (
                    <td className={`${td} text-ink-2`}>
                      {entry.adminId ? (adminEmails[entry.adminId] ?? '—') : 'No Admin'}
                    </td>
                  )}
                  <td className={td}>
                    <Badge tone={entry.disabled ? 'danger' : 'ok'}>
                      {entry.disabled ? 'Disabled' : 'Active'}
                    </Badge>
                  </td>
                  <td className={td}>
                    {resetting === entry.id ? (
                      <form
                        className="flex flex-wrap items-center gap-1.5"
                        onSubmit={(event) => void savePassword(event, entry)}
                      >
                        <input
                          autoFocus
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
                          aria-label={`New password for ${entry.email}`}
                          autoComplete="new-password"
                          className={`${field} w-[200px] max-w-full`}
                        />
                        <Button variant="secondary" onClick={() => setPassword(generatePassword())}>
                          Generate
                        </Button>
                        <Button
                          type="submit"
                          variant="mapPrimary"
                          disabled={!valid || pending === entry.id}
                        >
                          Save
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setResetting(null)
                            setPassword('')
                          }}
                        >
                          Cancel
                        </Button>
                      </form>
                    ) : (
                      <div className="flex flex-wrap gap-1.5" data-testid="pilot-actions">
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setResetting(entry.id)
                            setPassword('')
                          }}
                        >
                          New password
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={pending === entry.id}
                          onClick={() => void toggleDisabled(entry)}
                        >
                          {entry.disabled ? 'Enable' : 'Disable'}
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={pending === entry.id}
                          onClick={() => void remove(entry)}
                        >
                          Delete
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
