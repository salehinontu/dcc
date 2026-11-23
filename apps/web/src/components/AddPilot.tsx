import { useEffect, useState, type FormEvent } from 'react'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PILOT_PERMISSIONS } from '@dji/protocol'
import { api, type User } from '../api'
import { generatePassword } from '../password'
import Button from '../ui/Button'
import Icon from './Icon'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const field =
  'h-9 rounded-md border border-line-strong bg-surface-2 px-3 text-[13px] outline-none focus:border-pine'

/**
 * Makes a drone operator account, the one a remote controller signs in with. Its access is fixed, so the
 * only choices are who it is and, for a Developer, which Admin it works for.
 */
export default function AddPilot({
  actor,
  onCreated,
  onCancel,
  onError,
}: {
  actor: User
  onCreated: (email: string) => void
  onCancel: () => void
  onError: (message: string) => void
}) {
  const isDeveloper = actor.role === 'developer'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [copied, setCopied] = useState(false)
  const [admins, setAdmins] = useState<User[]>([])
  const [adminId, setAdminId] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isDeveloper) return
    let live = true
    api
      .users()
      .then(({ users }) => {
        if (live) setAdmins(users.filter((entry) => entry.role === 'admin'))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [isDeveloper])

  const ready =
    EMAIL.test(email.trim()) &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH

  async function copy() {
    try {
      await navigator.clipboard.writeText(password)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard access needs a secure context; show the password to copy by hand.
      setShow(true)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    try {
      await api.createUser({
        email: email.trim(),
        password,
        role: 'pilot',
        permissions: [...PILOT_PERMISSIONS],
        allDrones: true,
        dronePermissions: {},
        ...(isDeveloper ? { adminId: adminId || null } : {}),
      })
      onCreated(email.trim())
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => void submit(event)}
      data-testid="pilot-add"
    >
      <input
        autoFocus
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="name@example.com"
        aria-label="Drone operator email"
        data-testid="pilot-email"
        className={`${field} w-[240px] max-w-full`}
      />
      <input
        type={show ? 'text' : 'password'}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
        aria-label="Drone operator password"
        autoComplete="new-password"
        data-testid="pilot-password"
        className={`${field} w-[220px] max-w-full font-mono`}
      />
      <Button
        variant="secondary"
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
        onClick={() => setShow((value) => !value)}
      >
        <Icon name={show ? 'eyeOff' : 'eye'} />
      </Button>
      <Button
        variant="secondary"
        data-testid="pilot-generate"
        onClick={() => {
          setPassword(generatePassword())
          setShow(true)
        }}
      >
        <Icon name="refresh" />
        Generate
      </Button>
      <Button variant="secondary" disabled={!password} onClick={() => void copy()}>
        <Icon name={copied ? 'check' : 'link'} />
        {copied ? 'Copied' : 'Copy'}
      </Button>
      {isDeveloper && (
        <select
          value={adminId}
          onChange={(event) => setAdminId(event.target.value)}
          aria-label="Admin"
          data-testid="pilot-admin"
          className={`${field} max-w-full`}
        >
          <option value="">No Admin (only Developers see it)</option>
          {admins.map((admin) => (
            <option key={admin.id} value={admin.id}>
              {admin.email}
            </option>
          ))}
        </select>
      )}
      <Button
        type="submit"
        variant="mapPrimary"
        disabled={!ready || busy}
        data-testid="pilot-create"
      >
        Create
      </Button>
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  )
}
