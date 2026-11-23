import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  ACCOUNT_PERMISSIONS,
  can,
  defaultPermissions,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PERMISSIONS,
  PILOT_PERMISSIONS as PILOT_ACCESS,
  type Permission,
} from '@dji/protocol'
import { api, type User } from '../api'
import { withBase } from '../base'
import Icon from '../components/Icon'
import StageBar from '../components/StageBar'
import { formatDateTime } from '../flightFormat'
import { initials } from '../format'
import { generatePassword } from '../password'
import { followLink, navigate, type AppRoute } from '../routes'
import { useFleet } from '../store'
import Badge, { type BadgeTone } from '../ui/Badge'
import Button, { ButtonLink } from '../ui/Button'
import { Field, FieldError, TextInput } from '../ui/Field'
import Notice from '../ui/Notice'
import { cn } from '../ui/cn'
import {
  card,
  emptyPanel,
  eyebrow,
  filterControl,
  filterLabel,
  screenBody,
  segment,
  td,
  th,
  tileFoot,
} from '../ui/surface'

const permissionLabels: Record<Permission, string> = {
  'users.manage': 'Manage users',
  'inventory.manage': 'Controllers and drone inventory',
  'map.view': 'Operations map',
  'wall.view': 'Live wall',
  'shots.view': 'Screenshots screen',
  'recs.view': 'Recordings screen',
  'history.view': 'Flight history screen',
  'fleet.view': 'Drones screen',
  'zones.view': 'View zones and geofences',
  'alerts.view': 'View alerts',
  'drones.view': 'View drones',
  'drones.rename': 'Rename drones',
  'drones.delete': 'Delete drones',
  'drones.bind': 'Bind and rebind drones',
  'telemetry.view': 'View telemetry and history',
  'streams.view': 'Watch video',
  'streams.control': 'Control streams and quality',
  'screenshots.view': 'View and download screenshots',
  'screenshots.capture': 'Capture screenshots and record video',
  'screenshots.delete': 'Delete screenshots',
  'recordings.view': 'Watch and download recordings',
  'recordings.record': 'Record video on the server',
  'recordings.delete': 'Delete recordings',
  'recordings.upload': 'Upload videos',
  'zones.manage': 'Draw and edit no-fly zones and geofences',
  'flights.view': 'View flight history',
  'system.debug': 'View fleet debug logs',
  'audit.view': 'Read and export the audit log',
  'api.manage': 'Make API tokens for the customer’s own programs',
}

/**
 * The screens an account can open, in menu order. A screen only opens the page: which drones it
 * shows, and what can be done with each, is decided by the drone rights below.
 */
const SCREEN_PERMISSIONS: Permission[] = [
  'map.view',
  'wall.view',
  'shots.view',
  'recs.view',
  'history.view',
  'zones.view',
  'alerts.view',
  'fleet.view',
  'users.manage',
  'inventory.manage',
  'audit.view',
  'api.manage',
]

/** Account-wide rights that are not a screen. */
const ADMIN_PERMISSIONS: Permission[] = ['zones.manage', 'recordings.upload', 'system.debug']

const screenLabels: Partial<Record<Permission, string>> = {
  'map.view': 'Operations map',
  'wall.view': 'Live wall',
  'shots.view': 'Screenshots',
  'recs.view': 'Recordings',
  'history.view': 'Flight history',
  'fleet.view': 'Drones',
  'zones.view': 'Zones and geofences',
  'alerts.view': 'Alerts',
  'inventory.manage': 'Controllers and drones',
  'users.manage': 'Users and permissions',
  'audit.view': 'Audit log',
  'api.manage': 'API access',
}

const accountHints: Partial<Record<Permission, string>> = {
  'map.view': 'The live map of the drones they can see.',
  'wall.view': 'The wall of live video from the drones they can see.',
  'shots.view': 'The gallery of stored screenshots, and people counts, of the drones they can see.',
  'recs.view':
    'The videos recorded on the server and the ones uploaded, for the drones they can see. What they may do with each video is set under Recordings below.',
  'history.view': 'Past flights with their path and replay, for the drones they can see.',
  'fleet.view': 'The list of drones with their names, colours and status.',
  'zones.view': 'See no-fly zones and geofences. Drawing them is under Administration.',
  'alerts.view': 'The alerts raised for the drones they can see.',
  'inventory.manage': 'See and approve their own controllers and the drones those fly.',
  'users.manage': 'Create and edit the accounts under this one, and their access.',
  'zones.manage':
    'Draw, edit and delete the zones and geofences their own team drew, and set their warning distance.',
  'recordings.upload':
    "Upload video files into the recordings archive, into folders they name. They stay in this account's team.",
  'system.debug': 'Read the fleet debug logs.',
  'audit.view':
    'Read and export the audit log of this account’s team: who signed in, who changed what, and when.',
  'api.manage':
    'Make read-only API tokens, so a program of their own (an AI analysis tool) can read the drones, telemetry, pictures and video they can see.',
}

const aircraftGroups: { title: string; items: Permission[] }[] = [
  { title: 'Drones', items: ['drones.view', 'drones.rename', 'drones.delete', 'drones.bind'] },
  { title: 'Telemetry and video', items: ['telemetry.view', 'streams.view', 'streams.control'] },
  {
    title: 'Screenshots',
    items: ['screenshots.view', 'screenshots.capture', 'screenshots.delete'],
  },
  {
    title: 'Recordings',
    items: ['recordings.view', 'recordings.record', 'recordings.delete'],
  },
  { title: 'Flights', items: ['flights.view'] },
]

/** Exactly what a remote-controller sign-in needs; the server enforces the same set. */
const PILOT_PERMISSIONS: Permission[] = [...PILOT_ACCESS]

const roleLabels: Record<string, string> = {
  developer: 'Developer',
  admin: 'Admin',
  subadmin: 'Sub-admin',
  pilot: 'Drone operator',
}

const roleHints: Record<string, string> = {
  subadmin: 'Everything this account can do comes from the permissions below.',
  pilot: 'Only signs in on the remote controller (DJI Pilot 2). Nothing on the dashboard.',
  admin:
    "A customer's lead. You choose the screens and the drones they get; they give Sub-admins and Drone operators a part of it.",
}

type StatusFilter = 'all' | 'active' | 'disabled' | 'pending'

const statusOf = (u: User): Exclude<StatusFilter, 'all'> =>
  u.disabled ? 'disabled' : u.mustChangePassword ? 'pending' : 'active'

const statusLabels = { active: 'Active', disabled: 'Disabled', pending: 'Password change pending' }
const statusTones: Record<Exclude<StatusFilter, 'all'>, BadgeTone> = {
  active: 'ok',
  pending: 'pending',
  disabled: 'danger',
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SERIAL = /^[A-Za-z0-9_-]{1,64}$/
const MIN_PASSWORD = PASSWORD_MIN_LENGTH

/** Keeps grants in protocol order, so a round trip compares equal regardless of click order. */
const ordered = (list: Iterable<Permission>) => {
  const set = new Set(list)
  return PERMISSIONS.filter((p) => set.has(p))
}

function accessSummary(entry: User): string {
  if (entry.role === 'pilot') return 'Remote sign-in only'
  if (entry.allDrones) return 'All drones'
  const count = Object.values(entry.dronePermissions).filter((grants) =>
    grants.includes('drones.view'),
  ).length
  return count === 0 ? 'No drones' : `${count} drone${count === 1 ? '' : 's'}`
}

function lockReason(entry: User, me: User): string | null {
  if (entry.id === me.id)
    return 'Use Change password for your own password. Ask another admin to change your access.'
  if (entry.role === 'developer') return 'Developer accounts are managed from the server CLI.'
  return null
}

function Check({
  label,
  hint,
  className,
  ...props
}: {
  label: string
  hint?: string
  className?: string
} & Omit<ComponentPropsWithoutRef<'input'>, 'type' | 'className'>) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-sm px-2 py-1.5 text-[12px] text-ink-2 transition-colors hover:bg-pine-wash hover:text-ink pointer-coarse:py-2.5',
        props.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
        className,
      )}
    >
      <input type="checkbox" className="mt-px size-3.5 flex-none accent-pine" {...props} />
      <span className="min-w-0">
        <span className="block">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-[1.45] text-ink-3">{hint}</span>}
      </span>
    </label>
  )
}

function Section({
  title,
  description,
  aside,
  children,
}: {
  title: string
  description?: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={cn(card, 'min-w-0 overflow-hidden')}>
      <header
        className={cn(
          'flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-line-soft px-5 py-3.5 until-stack:px-4',
          tileFoot,
        )}
      >
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[13.5px] font-semibold tracking-[-0.01em]">{title}</h2>
          {description && (
            <p className="m-0 mt-0.5 text-[11.5px] leading-[1.5] text-ink-3">{description}</p>
          )}
        </div>
        {aside}
      </header>
      <div className="p-5 until-stack:p-4">{children}</div>
    </section>
  )
}

interface UserGroup {
  key: string
  /** Empty for the single unlabelled group an Admin or Sub-admin sees. */
  title: string
  note: string
  entries: User[]
}

const roleOrder: Record<string, number> = { developer: 0, admin: 1, subadmin: 2, pilot: 3 }

/**
 * A Developer sees every account, so the list is split by Admin: one block per Admin with the
 * Sub-admins that belong to it, then the Developers, then any account with no Admin.
 * `all` is the unfiltered list, so a block's counts do not change with the search box.
 */
function groupByAdmin(visible: User[], all: User[]): UserGroup[] {
  const byEmail = (a: User, b: User) => a.email.localeCompare(b.email)
  const owned = (admin: User) => all.filter((u) => u.adminId === admin.id && u.id !== admin.id)
  const groups: UserGroup[] = []
  const placed = new Set<string>()

  const developers = visible.filter((u) => u.role === 'developer').sort(byEmail)
  if (developers.length > 0) {
    groups.push({ key: 'developers', title: 'Developers', note: '', entries: developers })
    for (const entry of developers) placed.add(entry.id)
  }
  for (const admin of all.filter((u) => u.role === 'admin').sort(byEmail)) {
    const entries = visible
      .filter((u) => u.id === admin.id || u.adminId === admin.id)
      .sort((a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9) || byEmail(a, b))
    if (entries.length === 0) continue
    const mine = owned(admin)
    const subs = mine.filter((u) => u.role === 'subadmin').length
    groups.push({
      key: admin.id,
      title: admin.email,
      note: `Admin · ${subs} Sub-admin${subs === 1 ? '' : 's'}`,
      entries,
    })
    for (const entry of entries) placed.add(entry.id)
  }
  const rest = visible.filter((u) => !placed.has(u.id)).sort(byEmail)
  if (rest.length > 0)
    groups.push({
      key: 'no-admin',
      title: 'No Admin',
      note: 'Only Developers see these accounts',
      entries: rest,
    })
  return groups
}

function Avatar({ entry }: { entry: User }) {
  return (
    <span
      className={cn(
        'grid size-8 flex-none place-items-center rounded-[50%] text-[10px] font-semibold tracking-[0.02em]',
        entry.disabled ? 'bg-sunken text-ink-3' : 'bg-pine-soft text-pine-strong',
      )}
      aria-hidden="true"
    >
      {initials(entry.email)}
    </span>
  )
}

export default function Users({
  user,
  route,
  railOpen,
  onOpenRail,
  onChangePassword,
}: {
  user: User
  route: Extract<AppRoute, { name: 'users' | 'user-new' | 'user-edit' }>
  railOpen: boolean
  onOpenRail: (trigger: HTMLButtonElement) => void
  onChangePassword: () => void
}) {
  const [users, setUsers] = useState<User[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(() => {
    void api
      .users()
      .then((r) => {
        setUsers(r.users)
        setLoaded(true)
      })
      .catch((e: Error) => {
        setError(e.message)
        setLoaded(true)
      })
  }, [])
  useEffect(load, [load])

  async function toggleDisabled(entry: User) {
    const disabling = !entry.disabled
    if (disabling && !window.confirm(`Disable ${entry.email}? Their sessions end immediately.`))
      return
    setPending(entry.id)
    setError('')
    setNotice('')
    try {
      await api.updateUser(entry.id, {
        email: entry.email,
        role: entry.role,
        permissions: entry.permissions,
        allDrones: entry.allDrones,
        dronePermissions: entry.dronePermissions,
        disabled: disabling,
      } as Parameters<typeof api.updateUser>[1])
      setNotice(`${entry.email} ${disabling ? 'disabled' : 'enabled'}.`)
      load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  async function resetMfa(entry: User) {
    if (
      !window.confirm(
        `Reset two-step sign-in for ${entry.email}?\n\nTheir sessions end now, and they sign in with just their password until they set it up again. Do this when they have lost their phone.`,
      )
    )
      return
    setPending(entry.id)
    setError('')
    setNotice('')
    try {
      await api.resetUserMfa(entry.id)
      setNotice(`Two-step sign-in reset for ${entry.email}.`)
      load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  async function remove(entry: User) {
    if (
      !window.confirm(
        `Delete ${entry.email} for good?\n\nTheir sessions end now.${
          entry.role === 'pilot' ? ' The remote controller they signed in is disconnected.' : ''
        } This cannot be undone.`,
      )
    )
      return
    setPending(entry.id)
    setError('')
    setNotice('')
    try {
      await api.deleteUser(entry.id)
      setNotice(`${entry.email} deleted.`)
      load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  // Drone operator accounts are made and managed on the Drones screen, so they are not listed here.
  const listed = users.filter((u) => u.role !== 'pilot')
  const needle = query.trim().toLowerCase()
  const visible = listed.filter(
    (u) =>
      (!needle || u.email.toLowerCase().includes(needle)) &&
      (roleFilter === 'all' || u.role === roleFilter) &&
      (statusFilter === 'all' || statusOf(u) === statusFilter),
  )
  const filtered = needle !== '' || roleFilter !== 'all' || statusFilter !== 'all'
  const counts = { active: 0, pending: 0, disabled: 0 }
  for (const entry of listed) counts[statusOf(entry)] += 1
  const listSummary = [
    `${listed.length} ${listed.length === 1 ? 'user' : 'users'}`,
    `${counts.active} active`,
    counts.pending > 0 ? `${counts.pending} pending` : null,
    counts.disabled > 0 ? `${counts.disabled} disabled` : null,
  ]
    .filter(Boolean)
    .join(' / ')

  const groups: UserGroup[] =
    user.role === 'developer'
      ? groupByAdmin(visible, users)
      : [{ key: 'all', title: '', note: '', entries: visible }]

  const editing = route.name === 'user-edit' ? users.find((u) => u.id === route.id) : undefined

  function finishForm(message: string) {
    setNotice(message)
    setError('')
    navigate('/users')
    load()
  }

  if (route.name !== 'users') {
    const blocked = editing ? lockReason(editing, user) : null
    return (
      <>
        <StageBar
          bar="users"
          title={route.name === 'user-new' ? 'Create user' : 'Edit user'}
          summary={
            route.name === 'user-new'
              ? 'Users and permissions / new account'
              : (editing?.email ?? 'Users and permissions')
          }
          back={{ label: 'Back to users', to: '/users' }}
          railOpen={railOpen}
          onOpenRail={onOpenRail}
        />
        <section className={screenBody} data-testid="users">
          {route.name === 'user-edit' && !loaded ? (
            <p className="m-0 text-[12.5px] text-ink-3">Loading account…</p>
          ) : route.name === 'user-edit' && (!editing || blocked) ? (
            <div className={emptyPanel}>
              <div className="grid justify-items-center gap-3">
                <h2 className="m-0 text-[15px] font-semibold">
                  {editing ? 'This account cannot be edited here' : 'User not found'}
                </h2>
                <p className="m-0 max-w-[46ch] text-[12.5px] leading-[1.6] text-ink-3">
                  {blocked ??
                    'The account does not exist, or it is outside the access you can delegate.'}
                </p>
                <ButtonLink
                  variant="secondary"
                  href={withBase('/users')}
                  onClick={(event) => followLink(event, '/users')}
                >
                  <Icon name="back" />
                  Back to users
                </ButtonLink>
              </div>
            </div>
          ) : (
            <UserForm
              key={route.name === 'user-edit' ? route.id : 'new'}
              actor={user}
              admins={users.filter((u) => u.role === 'admin')}
              editing={editing ?? null}
              onSaved={finishForm}
            />
          )}
        </section>
      </>
    )
  }

  return (
    <>
      <StageBar
        bar="users"
        title="Users and permissions"
        summary={loaded ? listSummary : 'Loading accounts'}
        actions={
          <ButtonLink
            variant="mapPrimary"
            href={withBase('/users/new')}
            data-testid="create-user"
            aria-label="Create user"
            onClick={(event) => followLink(event, '/users/new')}
          >
            <Icon name="plus" />
            <span className="until-narrow:hidden">Create user</span>
          </ButtonLink>
        }
        railOpen={railOpen}
        onOpenRail={onOpenRail}
      />
      <section className={screenBody} data-testid="users">
        <div className="grid gap-3.5">
          <div className="flex flex-wrap items-end gap-2.5" role="group" aria-label="Filter users">
            <label
              className={cn(
                filterLabel,
                'min-w-[220px] max-w-[360px] flex-1 until-stack:max-w-none until-stack:basis-full',
              )}
            >
              <span>Search</span>
              <span className="relative block">
                <Icon
                  name="search"
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3"
                />
                <input
                  type="search"
                  aria-label="Search users by email"
                  placeholder="Search by email"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className={cn(filterControl, 'w-full min-w-0 pl-8')}
                />
              </span>
            </label>
            <label className={filterLabel}>
              <span>Role</span>
              <select
                aria-label="Filter by role"
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className={filterControl}
              >
                <option value="all">All roles</option>
                {Object.entries(roleLabels)
                  .filter(([value]) => value !== 'pilot')
                  .map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
            <label className={filterLabel}>
              <span>Status</span>
              <select
                aria-label="Filter by status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className={filterControl}
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="pending">Password change pending</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            {filtered && (
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery('')
                  setRoleFilter('all')
                  setStatusFilter('all')
                }}
              >
                <Icon name="x" />
                Clear filters
              </Button>
            )}
            <span className="ml-auto self-center font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-3 tabular-nums until-phone-lg:hidden">
              {visible.length} of {listed.length} shown
            </span>
          </div>

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

          {loaded && visible.length === 0 ? (
            <div className={emptyPanel}>
              <div>
                <h2 className="mb-1.5 mt-0 text-[15px] font-semibold">
                  {filtered ? 'No users match these filters' : 'No users yet'}
                </h2>
                <p className="m-0 max-w-[42ch] text-[12.5px] leading-[1.6] text-ink-3">
                  {filtered
                    ? 'Clear the filters to see every account you can manage.'
                    : 'Create an account and give it only the drones and actions it needs.'}
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className={cn(card, 'overflow-x-auto until-stack:hidden')}>
                <table className="w-full min-w-[680px] border-collapse" data-testid="users-table">
                  <thead>
                    <tr>
                      <th className={th}>User</th>
                      <th className={th}>Role</th>
                      <th className={th}>Status</th>
                      <th className={th}>Last sign-in</th>
                      <th className={th}>Drone access</th>
                      <th className={th}>Created by</th>
                      <th className={cn(th, 'text-right')}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => (
                      <Fragment key={group.key}>
                        {group.title && (
                          <tr data-testid="user-group">
                            <td
                              colSpan={7}
                              className="border-b border-line bg-sunken px-4 py-2 text-[12px]"
                            >
                              <strong className="font-semibold">{group.title}</strong>
                              {group.note && (
                                <span className="ml-2.5 text-ink-3">{group.note}</span>
                              )}
                            </td>
                          </tr>
                        )}
                        {group.entries.map((entry) => (
                          <tr
                            key={entry.id}
                            className={cn(
                              'transition-colors hover:bg-pine-wash',
                              entry.disabled && 'text-ink-3',
                            )}
                            data-testid="user-row"
                          >
                            <td className={td}>
                              <span className="flex min-w-0 items-center gap-2.5">
                                <Avatar entry={entry} />
                                <strong className="truncate font-medium">{entry.email}</strong>
                                {entry.id === user.id && <span className={eyebrow}>You</span>}
                              </span>
                            </td>
                            <td className={td}>{roleLabels[entry.role] ?? entry.role}</td>
                            <td className={td}>
                              <span className="inline-flex flex-wrap items-center gap-1.5">
                                <Badge tone={statusTones[statusOf(entry)]}>
                                  {statusLabels[statusOf(entry)]}
                                </Badge>
                                {entry.mfaEnabled && (
                                  <span
                                    className="font-mono text-[10px] tracking-[0.04em] text-ink-3"
                                    title="Two-step sign-in is on"
                                    data-testid="mfa-badge"
                                  >
                                    2FA
                                  </span>
                                )}
                              </span>
                            </td>
                            <td
                              className={cn(td, 'whitespace-nowrap text-ink-2')}
                              data-testid="last-login"
                            >
                              {entry.lastLoginAt ? formatDateTime(entry.lastLoginAt) : 'Never'}
                            </td>
                            <td className={cn(td, 'text-ink-2')}>{accessSummary(entry)}</td>
                            <td className={cn(td, 'text-ink-3')}>{entry.createdByEmail ?? '—'}</td>
                            <td className={cn(td, 'text-right')}>
                              <UserActions
                                entry={entry}
                                me={user}
                                busy={pending === entry.id}
                                onToggle={toggleDisabled}
                                onDelete={remove}
                                onResetMfa={resetMfa}
                                onChangePassword={onChangePassword}
                              />
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                    {!loaded && (
                      <tr>
                        <td colSpan={7} className={cn(td, 'py-8 text-center text-ink-3')}>
                          Loading accounts…
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <ul
                className="m-0 hidden list-none gap-2.5 p-0 until-stack:grid"
                data-testid="users-cards"
                aria-label="Users"
              >
                {groups.map((group) => (
                  <Fragment key={group.key}>
                    {group.title && (
                      <li className="px-1 pt-2 text-[12px]" data-testid="user-group">
                        <strong className="font-semibold">{group.title}</strong>
                        {group.note && <span className="ml-2 text-ink-3">{group.note}</span>}
                      </li>
                    )}
                    {group.entries.map((entry) => (
                      <li key={entry.id} className={cn(card, 'overflow-hidden')}>
                        <div className="flex items-center gap-2.5 px-3.5 pb-2.5 pt-3">
                          <Avatar entry={entry} />
                          <div className="min-w-0 flex-1">
                            <strong
                              className={cn(
                                'block truncate text-[13px] font-medium',
                                entry.disabled && 'text-ink-3',
                              )}
                            >
                              {entry.email}
                            </strong>
                            <span className="mt-0.5 block text-[11.5px] text-ink-3">
                              {roleLabels[entry.role] ?? entry.role} · {accessSummary(entry)}
                              {entry.createdByEmail && ` · by ${entry.createdByEmail}`}
                              {entry.id === user.id && ' · You'}
                            </span>
                          </div>
                        </div>
                        <div
                          className={cn(
                            'flex flex-wrap items-center gap-2 border-t border-line-soft px-3.5 py-2.5',
                            tileFoot,
                          )}
                        >
                          <Badge tone={statusTones[statusOf(entry)]}>
                            {statusLabels[statusOf(entry)]}
                          </Badge>
                          <span className="ml-auto">
                            <UserActions
                              entry={entry}
                              me={user}
                              busy={pending === entry.id}
                              onToggle={toggleDisabled}
                              onDelete={remove}
                              onResetMfa={resetMfa}
                              onChangePassword={onChangePassword}
                            />
                          </span>
                        </div>
                      </li>
                    ))}
                  </Fragment>
                ))}
                {!loaded && (
                  <li className="py-6 text-center text-[12.5px] text-ink-3">Loading accounts…</li>
                )}
              </ul>
            </>
          )}
        </div>
      </section>
    </>
  )
}

/** Opens the audit log filtered to one account: everything that account did, and everything done to it. */
function ActivityLink({ entry, me }: { entry: User; me: User }) {
  if (!can(me, 'audit.view')) return null
  const to = `/audit?actor=${encodeURIComponent(entry.email)}`
  return (
    <ButtonLink
      variant="secondary"
      href={withBase(to)}
      aria-label={`Activity of ${entry.email}`}
      data-testid="user-activity"
      onClick={(event) => followLink(event, to)}
    >
      <Icon name="list" />
      Activity
    </ButtonLink>
  )
}

function UserActions({
  entry,
  me,
  busy,
  onToggle,
  onDelete,
  onResetMfa,
  onChangePassword,
}: {
  entry: User
  me: User
  busy: boolean
  onToggle: (entry: User) => Promise<void>
  onDelete: (entry: User) => Promise<void>
  onResetMfa: (entry: User) => Promise<void>
  onChangePassword: () => void
}) {
  // Your own row: the one thing you do to yourself here is change your password. Access,
  // disabling and deleting yourself are left to someone else, so you cannot lock yourself out.
  if (entry.id === me.id) {
    return (
      <span className="inline-flex flex-wrap items-center justify-end gap-2">
        <ActivityLink entry={entry} me={me} />
        <Button
          variant="secondary"
          aria-label="Change your email or password"
          data-testid="change-own-password"
          onClick={onChangePassword}
        >
          <Icon name="lock" />
          Email / password
        </Button>
      </span>
    )
  }
  const locked = lockReason(entry, me)
  const to = `/users/${encodeURIComponent(entry.id)}`
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      <ActivityLink entry={entry} me={me} />
      {locked ? (
        <Button variant="secondary" disabled title={locked} aria-label={`Edit ${entry.email}`}>
          <Icon name="edit" />
          Edit
        </Button>
      ) : (
        <ButtonLink
          variant="secondary"
          href={withBase(to)}
          aria-label={`Edit ${entry.email}`}
          onClick={(event) => followLink(event, to)}
        >
          <Icon name="edit" />
          Edit
        </ButtonLink>
      )}
      {entry.mfaEnabled && !locked && (
        <Button
          variant="secondary"
          disabled={busy}
          title="Turn off this account’s two-step sign-in (a lost phone)"
          aria-label={`Reset two-step sign-in of ${entry.email}`}
          data-testid="reset-mfa"
          onClick={() => void onResetMfa(entry)}
        >
          <Icon name="lock" />
          Reset 2FA
        </Button>
      )}
      <Button
        variant="secondary"
        disabled={Boolean(locked) || busy}
        title={locked ?? undefined}
        aria-label={`${entry.disabled ? 'Enable' : 'Disable'} account ${entry.email}`}
        onClick={() => void onToggle(entry)}
      >
        <Icon name={entry.disabled ? 'check' : 'lock'} />
        {entry.disabled ? 'Enable' : 'Disable'}
      </Button>
      <Button
        variant="secondary"
        className="hover:border-danger hover:bg-transparent hover:text-danger"
        disabled={Boolean(locked) || busy}
        title={locked ?? 'Delete this account for good'}
        aria-label={`Delete account ${entry.email}`}
        data-testid="delete-user"
        onClick={() => void onDelete(entry)}
      >
        <Icon name="trash" />
        Delete
      </Button>
    </span>
  )
}

type FormState = {
  email: string
  password: string
  role: string
  permissions: Permission[]
  allDrones: boolean
  dronePermissions: Record<string, Permission[]>
  disabled: boolean
}

function UserForm({
  actor,
  admins,
  editing,
  onSaved,
}: {
  actor: User
  /** Every Admin, for a Developer choosing whose account this is. */
  admins: User[]
  editing: User | null
  onSaved: (message: string) => void
}) {
  const devices = useFleet((s) => s.devices)
  // Which Admin a new account belongs to. Only a Developer chooses; for everyone else it is
  // their own Admin, set by the server.
  const [ownerId, setOwnerId] = useState('')
  const ownerEmail = editing?.adminId
    ? (admins.find((a) => a.id === editing.adminId)?.email ?? null)
    : null
  const [form, setForm] = useState<FormState>(() =>
    editing
      ? {
          email: editing.email,
          password: '',
          role: editing.role,
          ...(editing.role === 'pilot'
            ? { permissions: PILOT_PERMISSIONS, allDrones: true, dronePermissions: {} }
            : {
                permissions: editing.permissions,
                allDrones: editing.allDrones,
                dronePermissions: editing.dronePermissions,
              }),
          disabled: editing.disabled ?? false,
        }
      : {
          email: '',
          password: '',
          role: 'subadmin',
          permissions: [],
          allDrones: false,
          dronePermissions: {},
          disabled: false,
        },
  )
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [serial, setSerial] = useState('')
  const [serialError, setSerialError] = useState('')
  const [aircraftQuery, setAircraftQuery] = useState('')
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) emailRef.current?.focus()
  }, [editing])

  // Anyone who manages users may hand on any right they hold themselves, including this one.
  const grantOptions = PERMISSIONS.filter((p) => can(actor, p))
  // A drone operator account only signs a controller in: its access is fixed, so nothing is offered.
  // In the menu's order, not the permission list's.
  const screenOptions =
    form.role === 'pilot' ? [] : SCREEN_PERMISSIONS.filter((p) => grantOptions.includes(p))
  const adminOptions =
    form.role === 'pilot' ? [] : ADMIN_PERMISSIONS.filter((p) => grantOptions.includes(p))
  const mayGrantAll = actor.allDrones || actor.role === 'developer'

  const droneSns = useMemo(
    () => [...new Set([...Object.keys(devices), ...Object.keys(form.dronePermissions)])].sort(),
    [devices, form.dronePermissions],
  )
  const aircraftNeedle = aircraftQuery.trim().toLowerCase()
  const shownSns = droneSns.filter((sn) => {
    if (!aircraftNeedle) return true
    const device = devices[sn]
    return [sn, device?.displayName, device?.model].some((value) =>
      value?.toLowerCase().includes(aircraftNeedle),
    )
  })
  const grantedCount = droneSns.filter((sn) =>
    (form.dronePermissions[sn] ?? []).includes('drones.view'),
  ).length

  const togglePermission = (p: Permission) =>
    setForm((f) => ({
      ...f,
      permissions: f.permissions.includes(p)
        ? f.permissions.filter((v) => v !== p)
        : ordered([...f.permissions, p]),
    }))

  /**
   * Every aircraft action requires View aircraft (see `can`), so ticking an action ticks View
   * with it, and clearing View clears the rest instead of leaving grants that do nothing.
   */
  function toggleAircraft(sn: string, p: Permission) {
    setForm((f) => {
      const current = f.dronePermissions[sn] ?? []
      let next: Permission[]
      if (current.includes(p)) next = p === 'drones.view' ? [] : current.filter((v) => v !== p)
      else next = ordered([...current, p, 'drones.view'])
      return { ...f, dronePermissions: { ...f.dronePermissions, [sn]: next } }
    })
  }

  function setAircraftGrants(sn: string, grants: Permission[]) {
    setForm((f) => ({ ...f, dronePermissions: { ...f.dronePermissions, [sn]: ordered(grants) } }))
  }

  const aircraftOptions = (sn: string) =>
    PERMISSIONS.filter((p) => !ACCOUNT_PERMISSIONS.includes(p) && can(actor, p, sn))

  /**
   * Drone operator has fixed access (see and bind every aircraft). A new Admin starts with everything the
   * actor can give, on every aircraft; a new Sub-admin starts empty and is given rights one by one.
   */
  function changeRole(role: string) {
    setForm((f) => {
      if (role === 'pilot')
        return { ...f, role, permissions: PILOT_PERMISSIONS, allDrones: true, dronePermissions: {} }
      // A new Admin starts with every screen and none of the drones: the Developer ticks the
      // ones this customer owns, so nothing of its own is shown by accident.
      if (role === 'admin' && !editing)
        return { ...f, role, permissions: ordered(grantOptions), allDrones: false }
      return {
        ...f,
        role,
        permissions: f.role === 'pilot' ? [] : f.permissions,
        allDrones: f.role === 'pilot' ? false : f.allDrones,
      }
    })
  }

  function applyRoleDefaults() {
    const defaults = defaultPermissions(form.role).filter((p) => grantOptions.includes(p))
    setForm((f) => ({
      ...f,
      permissions: ordered([
        ...f.permissions.filter((p) => ACCOUNT_PERMISSIONS.includes(p)),
        ...defaults.filter((p) => !ACCOUNT_PERMISSIONS.includes(p)),
      ]),
    }))
  }

  function addSerial() {
    const sn = serial.trim()
    if (!SERIAL.test(sn)) {
      setSerialError('Use the serial printed on the drone: letters, digits, - or _.')
      return
    }
    setSerialError('')
    // Seed View aircraft: an entry with no grants hides the aircraft, so adding a serial and
    // stopping there would look like nothing happened. Every other grant is opt-in.
    setForm((f) => ({
      ...f,
      dronePermissions: {
        ...f.dronePermissions,
        [sn]: f.dronePermissions[sn]?.length ? f.dronePermissions[sn]! : ['drones.view'],
      },
    }))
    setAircraftQuery('')
    setSerial('')
  }

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(form.password)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard access needs a secure context; the password stays visible to copy by hand.
      setShowPassword(true)
    }
  }

  function validate(): boolean {
    const next: typeof errors = {}
    if (!editing && !EMAIL.test(form.email.trim())) next.email = 'Enter a valid email address.'
    if (!editing || form.password) {
      if (form.password.length < MIN_PASSWORD)
        next.password = `Use at least ${MIN_PASSWORD} characters.`
      else if (form.password.length > 128) next.password = 'Use at most 128 characters.'
    }
    setErrors(next)
    if (next.email) emailRef.current?.focus()
    else if (next.password) passwordRef.current?.focus()
    return !next.email && !next.password
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setFormError('')
    if (!validate()) return
    setBusy(true)
    try {
      const body = {
        ...form,
        email: form.email.trim(),
        ...(form.role === 'pilot'
          ? { permissions: PILOT_PERMISSIONS, allDrones: true, dronePermissions: {} }
          : {}),
        ...(actor.role === 'developer' && !editing && form.role !== 'admin'
          ? { adminId: ownerId || null }
          : {}),
      }
      if (editing) {
        await api.updateUser(editing.id, { ...body, password: body.password || undefined })
        onSaved(
          form.password
            ? `${editing.email} updated. Their sessions ended; the new password works right away.`
            : `${editing.email} updated. Their active sessions were ended.`,
        )
      } else {
        await api.createUser(body)
        onSaved(
          `${body.email} created. Share the password with them securely. They can change it any time.`,
        )
      }
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const passwordLength = form.password.length

  return (
    <form className="grid gap-4" noValidate onSubmit={(e) => void save(e)} data-testid="user-form">
      <div className="mx-auto grid w-full max-w-[920px] gap-4">
        <Section
          title="Account"
          description={
            editing
              ? 'The email is the sign-in name and cannot be changed.'
              : 'They sign in with this email and this password, and can change it later.'
          }
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-4 until-stack:grid-cols-1">
            <Field label="Email address" htmlFor="user-email" tone="default">
              <TextInput
                ref={emailRef}
                id="user-email"
                tone="default"
                type="email"
                inputMode="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="name@example.com"
                disabled={Boolean(editing)}
                invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? 'user-email-error' : undefined}
                value={form.email}
                onChange={(e) => {
                  setForm({ ...form, email: e.target.value })
                  setErrors((x) => ({ ...x, email: undefined }))
                }}
                className="disabled:bg-sunken disabled:text-ink-2"
              />
              {errors.email && <FieldError id="user-email-error">{errors.email}</FieldError>}
            </Field>

            <Field label="Role" htmlFor="user-role" tone="default">
              <select
                id="user-role"
                value={form.role}
                aria-describedby="user-role-hint"
                onChange={(e) => changeRole(e.target.value)}
                className="h-11 w-full rounded-md border border-line-strong bg-surface-2 px-3 text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] hover:border-input-hover focus:border-pine focus:[box-shadow:0_0_0_3px_var(--input-focus-ring)]"
              >
                {actor.role === 'developer' && <option value="admin">Admin</option>}
                <option value="subadmin">Sub-admin</option>
                {/* A new drone operator is made on the Drones screen; an existing one stays editable here. */}
                {editing?.role === 'pilot' && <option value="pilot">Drone operator</option>}
              </select>
              <p id="user-role-hint" className="m-0 mt-1.5 text-[11.5px] leading-[1.5] text-ink-3">
                {roleHints[form.role] ?? 'Roles label the account; permissions decide access.'}
              </p>
            </Field>

            {actor.role === 'developer' && form.role !== 'admin' && (
              <Field label="Belongs to Admin" htmlFor="user-owner" tone="default">
                {editing ? (
                  <p
                    id="user-owner"
                    className="m-0 text-[13.5px] text-ink"
                    data-testid="user-owner-readonly"
                  >
                    {ownerEmail ?? 'No Admin (only Developers see it)'}
                  </p>
                ) : (
                  <>
                    <select
                      id="user-owner"
                      value={ownerId}
                      onChange={(e) => setOwnerId(e.target.value)}
                      aria-describedby="user-owner-hint"
                      className="h-11 w-full rounded-md border border-line-strong bg-surface-2 px-3 text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] hover:border-input-hover focus:border-pine focus:[box-shadow:0_0_0_3px_var(--input-focus-ring)]"
                    >
                      <option value="">No Admin (only Developers see it)</option>
                      {admins.map((admin) => (
                        <option key={admin.id} value={admin.id}>
                          {admin.email}
                        </option>
                      ))}
                    </select>
                    <p
                      id="user-owner-hint"
                      className="m-0 mt-1.5 text-[11.5px] leading-[1.5] text-ink-3"
                    >
                      Only that Admin and its Sub-admins see this account.
                    </p>
                  </>
                )}
              </Field>
            )}

            <Field
              label={editing ? 'New password' : 'Password'}
              htmlFor="user-password"
              tone="default"
              className="col-span-2 until-stack:col-span-1"
            >
              <div className="flex gap-2 until-phone:flex-wrap">
                <div className="relative min-w-0 flex-1 until-phone:basis-full">
                  <TextInput
                    ref={passwordRef}
                    id="user-password"
                    tone="default"
                    trailing
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    spellCheck={false}
                    maxLength={128}
                    placeholder={
                      editing
                        ? 'Leave blank to keep the current password'
                        : `At least ${PASSWORD_MIN_LENGTH} characters`
                    }
                    invalid={Boolean(errors.password)}
                    aria-describedby={
                      errors.password ? 'user-password-error' : 'user-password-hint'
                    }
                    value={form.password}
                    onChange={(e) => {
                      setForm({ ...form, password: e.target.value })
                      setErrors((x) => ({ ...x, password: undefined }))
                    }}
                    className="font-mono"
                  />
                  <button
                    className="absolute right-[5px] top-1/2 grid size-[34px] -translate-y-1/2 place-items-center rounded-sm text-ink-3 hover:bg-sunken hover:text-ink"
                    type="button"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    <Icon name={showPassword ? 'eyeOff' : 'eye'} />
                  </button>
                </div>
                <Button
                  variant="secondary"
                  className="h-11 until-phone:flex-1"
                  data-testid="generate-password"
                  onClick={() => {
                    setForm({ ...form, password: generatePassword() })
                    setShowPassword(true)
                    setErrors((x) => ({ ...x, password: undefined }))
                  }}
                >
                  <Icon name="refresh" />
                  Generate
                </Button>
                <Button
                  variant="secondary"
                  className="h-11 until-phone:flex-1"
                  disabled={!form.password}
                  onClick={() => void copyPassword()}
                >
                  <Icon name={copied ? 'check' : 'link'} />
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              {errors.password ? (
                <FieldError id="user-password-error">{errors.password}</FieldError>
              ) : (
                <p
                  id="user-password-hint"
                  className="m-0 mt-1.5 flex flex-wrap gap-x-3 text-[11.5px] leading-[1.5] text-ink-3"
                >
                  <span>
                    {editing
                      ? 'Setting one signs them out; the new password works right away.'
                      : `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters. They can change it later.`}
                  </span>
                  {passwordLength > 0 && (
                    <span
                      className={cn(
                        'font-mono tabular-nums',
                        passwordLength >= MIN_PASSWORD ? 'text-ok' : 'text-warn-text',
                      )}
                    >
                      {passwordLength}/{MIN_PASSWORD}+
                    </span>
                  )}
                </p>
              )}
            </Field>
          </div>
        </Section>

        {screenOptions.length > 0 && (
          <Section
            title="Screens"
            description="Which screens open for them, starting with the Operations map. What each screen shows is decided by the drones and rights below."
          >
            <div
              className="grid grid-cols-2 gap-x-3 gap-y-1 until-stack:grid-cols-1"
              data-testid="screen-grants"
            >
              {screenOptions.map((p) => (
                <Check
                  key={p}
                  label={screenLabels[p] ?? permissionLabels[p]}
                  hint={accountHints[p]}
                  data-permission={p}
                  checked={form.permissions.includes(p)}
                  onChange={() => togglePermission(p)}
                />
              ))}
            </div>
          </Section>
        )}

        {adminOptions.length > 0 && (
          <Section
            title="Administration"
            description="Account-wide rights. They are not tied to any drone."
          >
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 until-stack:grid-cols-1">
              {adminOptions.map((p) => (
                <Check
                  key={p}
                  label={permissionLabels[p]}
                  hint={accountHints[p]}
                  data-permission={p}
                  checked={form.permissions.includes(p)}
                  onChange={() => togglePermission(p)}
                />
              ))}
            </div>
          </Section>
        )}

        {form.role === 'pilot' ? (
          <Section
            title="Remote controller sign-in"
            description="A Drone operator account only connects a remote controller (DJI Pilot 2)."
          >
            <p
              className="m-0 text-[12.5px] leading-[1.6] text-ink-2"
              data-testid="pilot-access-note"
            >
              It gets exactly what that needs, on every drone: see the drone and bind it to the
              controller. It has nothing of its own on the dashboard, and there is nothing to choose
              here.
            </p>
          </Section>
        ) : (
          <Section
            title="Drone access"
            description="Which drones they can see, and what they can do with each."
          >
            <div className="grid gap-4">
              <div role="radiogroup" aria-label="Drone scope" className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!form.allDrones}
                  className={segment(!form.allDrones)}
                  data-testid="scope-selected"
                  onClick={() => setForm({ ...form, allDrones: false })}
                >
                  Selected drones
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={form.allDrones}
                  disabled={!mayGrantAll}
                  title={mayGrantAll ? undefined : 'You can only delegate drones you can access.'}
                  className={cn(
                    segment(form.allDrones),
                    'disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                  data-testid="scope-all"
                  onClick={() => setForm({ ...form, allDrones: true })}
                >
                  All drones, including future ones
                </button>
              </div>

              {form.allDrones ? (
                <div className="grid gap-3">
                  {form.role === 'admin' && (
                    <Notice tone="error" className="items-center">
                      <span data-testid="admin-all-drones-warning">
                        All drones means every drone on this installation, yours and other
                        customers' included, and the ones added later. For a customer, choose
                        Selected drones and tick only theirs.
                      </span>
                    </Notice>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="m-0 min-w-0 flex-1 text-[12px] leading-[1.5] text-ink-3">
                      These permissions apply to every drone in the fleet, now and later.
                    </p>
                    <Button variant="secondary" onClick={applyRoleDefaults}>
                      Use {roleLabels[form.role] ?? form.role} defaults
                    </Button>
                  </div>
                  <div className="grid grid-cols-3 gap-3 until-wide:grid-cols-2 until-stack:grid-cols-1">
                    {aircraftGroups.map((group) => {
                      const items = group.items.filter((p) => grantOptions.includes(p))
                      if (items.length === 0) return null
                      return (
                        <fieldset
                          key={group.title}
                          className="m-0 min-w-0 rounded-md border border-line bg-surface-2 px-2 pb-2 pt-1"
                        >
                          <legend className={cn(eyebrow, 'px-1.5')}>{group.title}</legend>
                          {items.map((p) => (
                            <Check
                              key={p}
                              label={permissionLabels[p]}
                              data-permission={p}
                              checked={form.permissions.includes(p)}
                              onChange={() => togglePermission(p)}
                            />
                          ))}
                        </fieldset>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <div className="grid gap-3">
                  <div className="flex flex-wrap items-center gap-2.5">
                    {droneSns.length > 4 && (
                      <span className="relative block min-w-[200px] max-w-[320px] flex-1 until-stack:max-w-none">
                        <Icon
                          name="search"
                          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3"
                        />
                        <input
                          type="search"
                          aria-label="Filter drones"
                          placeholder="Filter by name, serial or model"
                          value={aircraftQuery}
                          onChange={(e) => setAircraftQuery(e.target.value)}
                          className={cn(filterControl, 'w-full min-w-0 pl-8')}
                        />
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-3 tabular-nums">
                      {grantedCount} of {droneSns.length} drones visible to them
                    </span>
                  </div>

                  {droneSns.length === 0 ? (
                    <p className="m-0 rounded-md border border-dashed border-line-strong px-4 py-6 text-center text-[12px] leading-[1.6] text-ink-3">
                      No drones are reporting yet. Add one by serial below.
                    </p>
                  ) : shownSns.length === 0 ? (
                    <p className="m-0 py-4 text-center text-[12px] text-ink-3">
                      No drones match “{aircraftQuery}”.
                    </p>
                  ) : (
                    <div className="grid max-h-[520px] grid-cols-2 gap-2.5 overflow-y-auto pr-0.5 until-stack:max-h-none until-stack:overflow-visible until-stack:pr-0 [scrollbar-color:var(--line-strong)_transparent] [scrollbar-width:thin] until-wide:grid-cols-1">
                      {shownSns.map((sn) => {
                        const grants = form.dronePermissions[sn] ?? []
                        const options = aircraftOptions(sn)
                        const device = devices[sn]
                        const visible = grants.includes('drones.view')
                        return (
                          <fieldset
                            key={sn}
                            className={cn(
                              'm-0 min-w-0 rounded-md border px-2.5 pb-2 pt-1 transition-colors',
                              visible
                                ? 'border-line-rose bg-pine-tint'
                                : 'border-line bg-surface-2',
                            )}
                            data-testid="aircraft-grants"
                          >
                            <legend className="max-w-full break-all px-1 text-[12.5px] font-medium">
                              {device?.displayName ?? sn}
                            </legend>
                            <div className="-mt-0.5 mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
                              <span
                                className={cn(
                                  'size-1.5 flex-none rounded-[50%]',
                                  device?.online ? 'bg-ok' : 'bg-line-strong',
                                )}
                                aria-hidden="true"
                              />
                              <span className="min-w-0 truncate font-mono text-[9.5px] tracking-[0.04em] text-ink-3">
                                {device?.displayName ? `${sn} · ` : ''}
                                {device ? (device.online ? 'online' : 'offline') : 'not reporting'}
                              </span>
                              <span className="ml-auto flex gap-1">
                                <button
                                  type="button"
                                  className="rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-pine-strong hover:bg-pine-wash"
                                  aria-label={`Grant every action on ${device?.displayName ?? sn}`}
                                  onClick={() => setAircraftGrants(sn, options)}
                                >
                                  All
                                </button>
                                <button
                                  type="button"
                                  className="rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-40"
                                  aria-label={`Remove access to ${device?.displayName ?? sn}`}
                                  disabled={grants.length === 0}
                                  onClick={() => setAircraftGrants(sn, [])}
                                >
                                  None
                                </button>
                              </span>
                            </div>
                            <div className="grid grid-cols-2 gap-x-2 until-phone-lg:grid-cols-1">
                              {options.map((p) => (
                                <Check
                                  key={p}
                                  label={permissionLabels[p]}
                                  data-permission={p}
                                  checked={grants.includes(p)}
                                  onChange={() => toggleAircraft(sn, p)}
                                  className="text-[11.5px]"
                                />
                              ))}
                            </div>
                          </fieldset>
                        )
                      })}
                    </div>
                  )}

                  <div className="grid gap-1.5 border-t border-line-soft pt-3">
                    <label
                      htmlFor="user-add-serial"
                      className="text-[11.5px] font-medium text-ink-2"
                    >
                      Add a drone that is offline or not reporting yet
                    </label>
                    <div className="flex gap-2">
                      <TextInput
                        id="user-add-serial"
                        tone="default"
                        placeholder="Drone serial number"
                        autoCapitalize="characters"
                        spellCheck={false}
                        invalid={Boolean(serialError)}
                        aria-describedby={serialError ? 'user-add-serial-error' : undefined}
                        value={serial}
                        onChange={(e) => {
                          setSerial(e.target.value)
                          setSerialError('')
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addSerial()
                          }
                        }}
                        className="font-mono"
                      />
                      <Button variant="secondary" className="h-11 flex-none" onClick={addSerial}>
                        <Icon name="plus" />
                        Add
                      </Button>
                    </div>
                    {serialError ? (
                      <FieldError id="user-add-serial-error">{serialError}</FieldError>
                    ) : (
                      <p className="m-0 text-[11.5px] leading-[1.5] text-ink-3">
                        It is added with <strong className="font-medium">View drones</strong>{' '}
                        ticked; choose the other actions it needs.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </Section>
        )}

        {editing && (
          <Section title="Account status">
            <Check
              label="Disable this account"
              hint="Ends their sessions now and blocks sign-in until an admin enables it again."
              checked={form.disabled}
              onChange={(e) => setForm({ ...form, disabled: e.target.checked })}
            />
          </Section>
        )}

        {formError && <Notice tone="error">{formError}</Notice>}
      </div>

      {/* Spans the whole screen body, so the actions stay reachable on long forms. */}
      <div className="sticky bottom-0 z-[2] -mx-[22px] -mb-[26px] border-t border-t-line bg-glass-surface px-[22px] py-3 backdrop-blur-[14px] backdrop-saturate-[1.2] until-drawer:-mx-4 until-drawer:-mb-4 until-drawer:px-4 until-stack:-mb-[22px]">
        <div className="mx-auto flex w-full max-w-[920px] flex-wrap items-center justify-end gap-2">
          <p className="m-0 mr-auto text-[11.5px] text-ink-3 until-phone-lg:hidden">
            {editing
              ? 'Saving ends their active sessions.'
              : 'Nothing is saved until you create the account.'}
          </p>
          <ButtonLink
            variant="secondary"
            className="h-11 px-4 until-phone-lg:flex-1"
            href={withBase('/users')}
            onClick={(event) => followLink(event, '/users')}
          >
            Cancel
          </ButtonLink>
          <Button
            type="submit"
            variant="primary"
            disabled={busy}
            className="disabled:opacity-60 until-phone-lg:flex-[2]"
            data-testid="user-submit"
          >
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create user'}
          </Button>
        </div>
      </div>
    </form>
  )
}
