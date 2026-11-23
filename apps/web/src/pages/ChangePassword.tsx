import { useState, type FormEvent } from 'react'
import { PASSWORD_MIN_LENGTH } from '@dji/protocol'
import { api, type User } from '../api'
import Icon from '../components/Icon'
import TwoStep from '../components/TwoStep'
import { beginSessionRotation } from '../socket'
import BrandLockup from '../ui/BrandLockup'
import Button from '../ui/Button'
import { Field, TextInput } from '../ui/Field'

/**
 * The account screen: change your sign-in email and your password. Also serves the forced
 * first sign-in (`forced`: password only, no way back), which no screen sets any more.
 *
 * A successful password change ends *every* session for the account and immediately reissues
 * this device's, so the person stays signed in here while every other device is signed out.
 * An email change touches no session: it only renames the sign-in.
 */
export default function ChangePassword({
  onComplete,
  onCancel,
  forced = false,
  email,
  onUser,
  user,
}: {
  onComplete: () => void
  onCancel?: () => void
  forced?: boolean
  /** The current sign-in email; with `onUser`, it turns on the email form. */
  email?: string
  onUser?: (user: User) => void
  /** The signed-in account: with `onUser`, it turns on the two-step sign-in card (not for a Pilot, who has none). */
  user?: User
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (form.get('password') !== form.get('confirm')) {
      setError('Passwords do not match.')
      return
    }
    setBusy(true)
    setError('')
    // Before the request: the API closes this page's live socket the moment it revokes, and
    // that close can arrive before the response does.
    beginSessionRotation()
    try {
      await api.changePassword(String(form.get('current')), String(form.get('password')))
      onComplete()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="grid h-full place-items-center overflow-y-auto bg-paper px-5 py-8">
      <div className="grid w-full max-w-[400px] gap-6">
        <BrandLockup variant="notFound" />
        {!forced && email && onUser && <EmailForm email={email} onUser={onUser} />}
        {!forced && user && onUser && user.role !== 'pilot' && (
          <TwoStep
            user={user}
            onChanged={() => {
              void api.me().then((result) => onUser(result.user))
            }}
          />
        )}
        <form
          onSubmit={(event) => void submit(event)}
          className="w-full rounded-[18px] border border-login-card-edge bg-white px-8 pb-[30px] pt-9 [box-shadow:var(--shadow-login-card)] until-stack:px-6"
        >
          <h1 className="mb-1.5 mt-0 text-[24px] font-semibold tracking-[-0.025em] text-login-card-ink">
            {forced ? 'Set your password' : 'Change password'}
          </h1>
          <p className="mb-7 mt-0 text-[12.5px] leading-[1.5] text-login-card-muted">
            {forced
              ? 'Your administrator gave you a temporary password. Replace it before opening the fleet. Other devices signed in with it are signed out.'
              : 'Your other devices will be signed out straight away. This one stays signed in.'}
          </p>

          <Field label={forced ? 'Temporary password' : 'Current password'} htmlFor="cp-current">
            <TextInput
              id="cp-current"
              name="current"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label="New password" htmlFor="cp-new" className="mt-4">
            <TextInput
              id="cp-new"
              name="password"
              type="password"
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={200}
              autoComplete="new-password"
              required
            />
          </Field>
          <Field label="Confirm new password" htmlFor="cp-confirm" className="mt-4">
            <TextInput
              id="cp-confirm"
              name="confirm"
              type="password"
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={200}
              autoComplete="new-password"
              required
            />
          </Field>
          <p className="mb-0 mt-2 text-[11.5px] leading-[1.5] text-login-card-muted">
            At least {PASSWORD_MIN_LENGTH} characters.
          </p>

          {error && (
            <p
              role="alert"
              className="mt-4 flex items-center gap-2 rounded-md border border-danger-edge bg-live-soft px-3 py-2.5 text-[12px] text-danger-text"
            >
              <Icon name="alert" className="size-[15px]" />
              {error}
            </p>
          )}

          <Button type="submit" variant="submit" className="mt-6" disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </Button>

          <div className="mt-7 flex items-center justify-center gap-5 border-t border-t-login-card-line pt-[18px]">
            {onCancel && !forced && (
              <button
                type="button"
                className="inline-flex items-center gap-[5px] text-[11.5px] font-medium text-ink-2 hover:underline hover:underline-offset-[3px]"
                onClick={onCancel}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              className="inline-flex items-center gap-[5px] text-[11.5px] font-medium text-ink-2 hover:underline hover:underline-offset-[3px] [&_svg]:size-3.5"
              onClick={() => {
                void api.logout().finally(onComplete)
              }}
            >
              <Icon name="logout" />
              Sign out
            </button>
          </div>
        </form>
      </div>
    </main>
  )
}

/** Change the sign-in email. Needs the current password; nobody else is signed out by it. */
function EmailForm({ email, onUser }: { email: string; onUser: (user: User) => void }) {
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setBusy(true)
    setError('')
    setDone('')
    try {
      const result = await api.changeEmail(String(form.get('current')), String(form.get('email')))
      onUser((await api.me()).user)
      formElement.reset()
      setDone(`Done. You now sign in with ${result.email}.`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="w-full rounded-[18px] border border-login-card-edge bg-white px-8 pb-[30px] pt-9 [box-shadow:var(--shadow-login-card)] until-stack:px-6"
      data-testid="email-form"
    >
      <h1 className="mb-1.5 mt-0 text-[24px] font-semibold tracking-[-0.025em] text-login-card-ink">
        Your sign-in email
      </h1>
      <p className="mb-7 mt-0 text-[12.5px] leading-[1.5] text-login-card-muted">
        You sign in as <strong className="font-medium text-login-card-ink">{email}</strong>. Change
        it here; nobody gets signed out.
      </p>

      <Field label="New email" htmlFor="em-new">
        <TextInput
          id="em-new"
          name="email"
          type="email"
          maxLength={254}
          autoComplete="email"
          required
        />
      </Field>
      <Field label="Current password" htmlFor="em-current" className="mt-4">
        <TextInput
          id="em-current"
          name="current"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>

      {error && (
        <p
          role="alert"
          className="mt-4 flex items-center gap-2 rounded-md border border-danger-edge bg-live-soft px-3 py-2.5 text-[12px] text-danger-text"
        >
          <Icon name="alert" className="size-[15px]" />
          {error}
        </p>
      )}
      {done && (
        <p
          role="status"
          className="mt-4 flex items-center gap-2 rounded-md border border-line bg-pine-wash px-3 py-2.5 text-[12px] text-login-card-ink"
          data-testid="email-done"
        >
          <Icon name="check" className="size-[15px]" />
          {done}
        </p>
      )}

      <Button type="submit" variant="submit" className="mt-6" disabled={busy}>
        {busy ? 'Saving…' : 'Change email'}
      </Button>
    </form>
  )
}
