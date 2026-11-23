import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type User } from '../api'
import { brand } from '../branding'
import Button from '../ui/Button'
import { Field, TextInput } from '../ui/Field'
import Icon from './Icon'

type Status = Awaited<ReturnType<typeof api.mfaStatus>>
type Step =
  | { name: 'idle' }
  | { name: 'password' }
  | { name: 'scan'; secret: string; qr: string }
  | { name: 'codes'; codes: string[] }
  | { name: 'disable' }
  | { name: 'regenerate' }

const cardClass =
  'w-full rounded-[18px] border border-login-card-edge bg-white px-8 pb-[30px] pt-9 [box-shadow:var(--shadow-login-card)] until-stack:px-6'
const heading = 'mb-1.5 mt-0 text-[24px] font-semibold tracking-[-0.025em] text-login-card-ink'
const lead = 'mb-6 mt-0 text-[12.5px] leading-[1.55] text-login-card-muted'

/** The secret in groups of four, as an authenticator app shows it when it is typed instead of scanned. */
const grouped = (secret: string): string => secret.replace(/(.{4})/g, '$1 ').trim()

function Problem({ children }: { children: string }) {
  return (
    <p
      role="alert"
      className="mt-4 flex items-center gap-2 rounded-md border border-danger-edge bg-live-soft px-3 py-2.5 text-[12px] text-danger-text"
    >
      <Icon name="alert" className="size-[15px]" />
      {children}
    </p>
  )
}

/**
 * Two-step sign-in for the signed-in account: set it up (scan a QR code with Google Authenticator or any authenticator
 * app, type the first code, keep the recovery codes), see its state, make new recovery codes, turn it off. Setting up,
 * turning off and new codes ask for the password again. `forced` is the screen an account that must have it is held at.
 */
export default function TwoStep({
  user,
  onChanged,
  forced = false,
}: {
  user: User
  /** Told after it was turned on or off, so the caller can read the account again. */
  onChanged: () => void
  forced?: boolean
}) {
  const [status, setStatus] = useState<Status | null>(null)
  const [step, setStep] = useState<Step>({ name: 'idle' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = useCallback(() => {
    api
      .mfaStatus()
      .then(setStatus)
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(load, [load])

  async function run(job: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await job()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const form = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    return new FormData(event.currentTarget)
  }

  const startSetup = (event: FormEvent<HTMLFormElement>) => {
    const data = form(event)
    void run(async () => {
      const result = await api.mfaSetup(String(data.get('password')))
      setStep({ name: 'scan', secret: result.secret, qr: result.qr })
    })
  }

  const finishSetup = (event: FormEvent<HTMLFormElement>) => {
    const data = form(event)
    void run(async () => {
      const result = await api.mfaEnable(String(data.get('code')))
      setSaved(false)
      setStep({ name: 'codes', codes: result.recoveryCodes })
      load()
    })
  }

  const turnOff = (event: FormEvent<HTMLFormElement>) => {
    const data = form(event)
    void run(async () => {
      await api.mfaDisable(String(data.get('password')), String(data.get('code')))
      setStep({ name: 'idle' })
      load()
      onChanged()
    })
  }

  const newCodes = (event: FormEvent<HTMLFormElement>) => {
    const data = form(event)
    void run(async () => {
      const result = await api.mfaRecoveryCodes(
        String(data.get('password')),
        String(data.get('code')),
      )
      setSaved(false)
      setStep({ name: 'codes', codes: result.recoveryCodes })
      load()
    })
  }

  const finishCodes = () => {
    setStep({ name: 'idle' })
    onChanged()
  }

  const download = (codes: string[]) => {
    const text = `${brand.name}: recovery codes for ${user.email}\nEach works once, in place of the 6-digit code.\n\n${codes.join('\n')}\n`
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${brand.name.replace(/\W+/g, '-')}-recovery-codes.txt`
    link.click()
    URL.revokeObjectURL(url)
  }

  const required = Boolean(status?.required ?? user.mfaRequired)

  return (
    <section className={cardClass} data-testid="two-step">
      <h1 className={heading}>{forced ? 'Set up two-step sign-in' : 'Two-step sign-in'}</h1>

      {forced && step.name === 'idle' && (
        <p className={lead} data-testid="two-step-required">
          Your organisation requires a second check at sign-in. Set it up now with an authenticator
          app (Google Authenticator, Microsoft Authenticator or similar). You cannot open the fleet
          until it is on.
        </p>
      )}

      {step.name === 'idle' && status && !status.enabled && (
        <>
          {!forced && (
            <p className={lead}>
              Add a second check to your sign-in: besides your password, a 6-digit code from an
              authenticator app on your phone. Someone who learns your password still cannot get in.
            </p>
          )}
          <Button
            type="button"
            variant="submit"
            onClick={() => setStep({ name: 'password' })}
            data-testid="two-step-start"
          >
            Set up two-step sign-in
          </Button>
        </>
      )}

      {step.name === 'idle' && status?.enabled && (
        <>
          <p className={lead}>
            <span className="inline-flex items-center gap-1.5 font-medium text-login-card-ink">
              <Icon name="check" className="size-[15px]" /> On
            </span>
            {status.enabledAt ? ` since ${new Date(status.enabledAt).toLocaleDateString()}` : ''}.
            You enter a code from your app each time you sign in. You have{' '}
            <strong className="font-medium text-login-card-ink" data-testid="recovery-left">
              {status.recoveryCodesLeft}
            </strong>{' '}
            recovery code{status.recoveryCodesLeft === 1 ? '' : 's'} left.
            {status.recoveryCodesLeft <= 2 && ' Make new ones soon.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setStep({ name: 'regenerate' })}
            >
              New recovery codes
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={required}
              title={required ? 'Your organisation requires two-step sign-in' : undefined}
              onClick={() => setStep({ name: 'disable' })}
              data-testid="two-step-off"
            >
              Turn off
            </Button>
          </div>
          {required && (
            <p className="mb-0 mt-3 text-[11.5px] text-login-card-muted">
              Your organisation requires it, so it cannot be turned off. If you lose your phone, ask
              an administrator to reset it.
            </p>
          )}
        </>
      )}

      {step.name === 'password' && (
        <form onSubmit={startSetup}>
          <p className={lead}>Confirm your password to start.</p>
          <Field label="Password" htmlFor="ts-password">
            <TextInput
              id="ts-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
            />
          </Field>
          <div className="mt-5 flex gap-2">
            <Button type="submit" variant="submit" disabled={busy}>
              {busy ? 'Checking…' : 'Continue'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setStep({ name: 'idle' })}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {step.name === 'scan' && (
        <form onSubmit={finishSetup}>
          <ol className="m-0 mb-4 grid list-decimal gap-1.5 pl-5 text-[12.5px] leading-[1.5] text-login-card-muted">
            <li>Install Google Authenticator (or any authenticator app) on your phone.</li>
            <li>Add an account and scan this picture, or type the key under it.</li>
            <li>Enter the 6-digit code the app then shows.</li>
          </ol>
          <div className="mb-3 grid justify-items-center gap-2">
            <img
              src={step.qr}
              alt={`QR code for ${user.email}`}
              width={232}
              height={232}
              className="rounded-md border border-login-card-line"
              data-testid="two-step-qr"
            />
            <code
              className="break-all text-center font-mono text-[12px] tracking-[0.08em] text-login-card-ink"
              data-testid="two-step-secret"
            >
              {grouped(step.secret)}
            </code>
          </div>
          <Field label="Code from the app" htmlFor="ts-code">
            <TextInput
              id="ts-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="123456"
              className="text-center font-mono text-[18px] tracking-[0.3em]"
              required
              autoFocus
              data-testid="two-step-enable-code"
            />
          </Field>
          <div className="mt-5 flex gap-2">
            <Button type="submit" variant="submit" disabled={busy}>
              {busy ? 'Checking…' : 'Turn on'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setStep({ name: 'idle' })}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {step.name === 'codes' && (
        <div data-testid="two-step-codes">
          <p className={lead}>
            Keep these recovery codes somewhere safe,{' '}
            <strong className="font-medium text-login-card-ink">not on the same phone</strong>. If
            you lose the phone, each one signs you in once in place of the 6-digit code. They are
            shown only now.
          </p>
          <ul className="m-0 mb-4 grid list-none grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-login-card-line bg-surface-2 p-3 font-mono text-[13px] text-login-card-ink">
            {step.codes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <div className="mb-4 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void navigator.clipboard?.writeText(step.codes.join('\n'))}
            >
              Copy
            </Button>
            <Button type="button" variant="secondary" onClick={() => download(step.codes)}>
              <Icon name="download" />
              Download
            </Button>
          </div>
          <label className="mb-4 flex items-center gap-2 text-[12.5px] text-login-card-ink">
            <input
              type="checkbox"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
              data-testid="two-step-saved"
            />
            I have saved these codes
          </label>
          <Button
            type="button"
            variant="submit"
            disabled={!saved}
            onClick={finishCodes}
            data-testid="two-step-done"
          >
            Done
          </Button>
        </div>
      )}

      {(step.name === 'disable' || step.name === 'regenerate') && (
        <form onSubmit={step.name === 'disable' ? turnOff : newCodes}>
          <p className={lead}>
            {step.name === 'disable'
              ? 'Turning it off signs your other devices out. Confirm with your password and a code from your app (or a recovery code).'
              : 'The old recovery codes stop working. Confirm with your password and a code from your app (or a recovery code).'}
          </p>
          <Field label="Password" htmlFor="ts-password">
            <TextInput
              id="ts-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
            />
          </Field>
          <Field label="Code" htmlFor="ts-code" className="mt-4">
            <TextInput
              id="ts-code"
              name="code"
              autoComplete="one-time-code"
              maxLength={20}
              placeholder="123456"
              required
            />
          </Field>
          <div className="mt-5 flex gap-2">
            <Button type="submit" variant="submit" disabled={busy}>
              {busy ? 'Checking…' : step.name === 'disable' ? 'Turn off' : 'Make new codes'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setStep({ name: 'idle' })}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {error && <Problem>{error}</Problem>}
    </section>
  )
}
