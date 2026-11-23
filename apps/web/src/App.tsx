import { lazy, Suspense, useEffect, useState } from 'react'
import { api, type User } from './api'
import LoadBoundary from './components/LoadBoundary'
import ChangePassword from './pages/ChangePassword'
import Icon from './components/Icon'
import TwoStep from './components/TwoStep'
import { useFleet } from './store'
import Login from './pages/Login'
import NotFound from './pages/NotFound'
import { parsePath, useLocationPath } from './routes'
import { clearSessionHint, hasSessionHint } from './session'
import BrandLockup from './ui/BrandLockup'

// The dashboard (the map library alone is about 290 kB compressed) loads only once someone has signed in, so the
// sign-in page, and the controller page on the RC's slow link, arrive with a fraction of the code.
const Dashboard = lazy(() => import('./pages/Dashboard'))

function BootScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3.5 bg-paper">
      <BrandLockup variant="boot" />
      <p className="m-0 text-[12px] text-ink-3">Connecting to the fleet…</p>
      <span className="h-px w-[42px] bg-line-strong" aria-hidden="true" />
    </div>
  )
}

export default function App() {
  // The address is the source of truth for which screen is shown, so refresh, back/forward
  // and copied links all land on the same screen.
  const parsed = parsePath(useLocationPath())
  // Without the session marker there is nothing to validate: render the login page
  // immediately instead of calling /api/me and logging a guaranteed 401.
  const [user, setUser] = useState<User | null | undefined>(() =>
    hasSessionHint() ? undefined : null,
  )
  const [changingPassword, setChangingPassword] = useState(false)

  useEffect(() => {
    if (!hasSessionHint()) return
    api
      .me()
      .then((result) => setUser(result.user))
      .catch(() => {
        clearSessionHint()
        setUser(null)
      })
  }, [])

  useEffect(() => {
    const expire = () => {
      clearSessionHint()
      useFleet.getState().setDevices([])
      useFleet.getState().replaceStreams([])
      setUser(null)
    }
    window.addEventListener('session-expired', expire)
    return () => window.removeEventListener('session-expired', expire)
  }, [])

  /**
   * A password change revokes every session for the account and reissues this device's, so
   * the page simply re-reads the account and carries on — including the forced change after
   * a temporary password, where `mustChangePassword` is now false.
   */
  function handlePasswordChanged() {
    setChangingPassword(false)
    api
      .me()
      .then((result) => setUser(result.user))
      .catch(() => {
        clearSessionHint()
        setUser(null)
      })
  }

  function handleLogout() {
    clearSessionHint()
    setUser(null)
    setChangingPassword(false)
    useFleet.getState().setDevices([])
    useFleet.getState().replaceStreams([])
  }

  if (user === undefined) return <BootScreen />
  if (user === null) return <Login onLogin={setUser} />
  if (user.mustChangePassword) return <ChangePassword forced onComplete={handlePasswordChanged} />
  // A role the installation requires two-step sign-in for sees nothing else until it has set it up.
  if (user.mfaEnrolRequired)
    return (
      <main className="grid h-full place-items-center overflow-y-auto bg-paper px-5 py-8">
        <div className="grid w-full max-w-[400px] gap-6">
          <BrandLockup variant="notFound" />
          <TwoStep user={user} forced onChanged={handlePasswordChanged} />
          <button
            type="button"
            className="mx-auto inline-flex items-center gap-[5px] text-[11.5px] font-medium text-ink-2 hover:underline hover:underline-offset-[3px] [&_svg]:size-3.5"
            onClick={() => {
              void api.logout().finally(handleLogout)
            }}
          >
            <Icon name="logout" />
            Sign out
          </button>
        </div>
      </main>
    )
  if (changingPassword)
    return (
      <ChangePassword
        onComplete={handlePasswordChanged}
        onCancel={() => setChangingPassword(false)}
        email={user.email}
        onUser={setUser}
        user={user}
      />
    )
  if (parsed.kind !== 'app') return <NotFound />
  return (
    <LoadBoundary>
      <Suspense fallback={<BootScreen />}>
        <Dashboard
          user={user}
          route={parsed.route}
          onLogout={handleLogout}
          onChangePassword={() => setChangingPassword(true)}
        />
      </Suspense>
    </LoadBoundary>
  )
}
