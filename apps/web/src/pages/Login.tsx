import { useRef, useState, type FormEvent } from 'react'
import { api, type User } from '../api'
import { withBase } from '../base'
import { brand } from '../branding'
import Icon from '../components/Icon'
import Button from '../ui/Button'
import BrandLockup from '../ui/BrandLockup'
import { Field, FieldError, TextInput } from '../ui/Field'
import cargoImage from '../assets/login-cargo.jpg'
import deliveryImage from '../assets/login-delivery.jpg'
import heavyLiftImage from '../assets/login-heavy-lift.jpg'
import medicalImage from '../assets/login-medical.jpg'
import watermarkImage from '../assets/login-watermark-vtol.webp'

export default function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  // Set when the password was right and the account asks for a code from its authenticator app.
  const [challenge, setChallenge] = useState<string | null>(null)

  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setFieldError(null)
    setFormError(null)

    if (!email.trim() || !emailRef.current?.checkValidity()) {
      setFormError('Enter a valid email address.')
      emailRef.current?.focus()
      return
    }

    if (!password) {
      setFieldError('Enter your password to continue.')
      passwordRef.current?.focus()
      return
    }

    setBusy(true)
    try {
      const result = await api.login(email, password)
      if ('mfaRequired' in result) {
        setChallenge(result.mfaToken)
        setPassword('')
        return
      }
      onLogin(result.user)
    } catch (err) {
      // A lock-out or a rate limit says so; anything else stays the same vague message, so a wrong email and a
      // wrong password look alike.
      const message = (err as Error).message
      setFormError(
        message === 'Too Many Requests'
          ? 'Too many attempts from here. Wait a minute and try again.'
          : /^too many/i.test(message)
            ? message
            : 'Invalid email or password.',
      )
      passwordRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="grid min-h-full grid-cols-[minmax(0,1.16fr)_minmax(380px,0.84fr)] bg-paper until-wide:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] until-drawer:grid-cols-1 until-drawer:grid-rows-1">
        <div
          className="relative flex min-w-0 flex-col overflow-hidden px-[clamp(32px,4.6vw,64px)] pb-[34px] pt-9 until-drawer:hidden"
          data-decor="login-visual"
        >
          <svg
            className="pointer-events-none absolute inset-0 z-[1] size-full"
            viewBox="0 0 900 1000"
            preserveAspectRatio="xMidYMid slice"
            aria-hidden="true"
          >
            <path
              className="topo-grid"
              d="M0 250h900M0 500h900M0 750h900M150 0v1000M450 0v1000M750 0v1000"
            />
            <path
              className="topo-ticks"
              d="M0 245h10M0 495h10M0 745h10M145 0v10M445 0v10M745 0v10M890 250h10M890 500h10M890 750h10"
            />
            <path
              className="topo-line"
              d="M596 112c126-10 238 54 272 148 36 100-22 196-120 244-108 52-244 34-316-46-64-72-58-178 12-252 44-46 92-88 152-94Z"
            />
            <path
              className="topo-line"
              d="M596 166c102-8 190 42 218 118 30 82-18 158-96 198-88 44-198 28-258-38-52-58-46-144 12-204 36-38 74-70 124-74Z"
            />
            <path
              className="topo-line"
              d="M600 218c80-6 148 32 170 92 24 64-14 124-74 154-70 34-156 22-204-30-42-46-36-114 10-160 28-30 58-54 98-56Z"
            />
            <path
              className="topo-line"
              d="M606 268c58-4 108 22 124 66 18 46-10 90-54 112-52 24-112 16-146-22-30-34-26-82 8-116 20-20 40-38 68-40Z"
            />
            <path
              className="topo-line"
              d="M612 318c36-2 66 14 76 40 10 28-6 54-32 68-32 14-68 10-88-12-18-20-14-50 6-70 10-12 22-24 38-26Z"
            />
            <path
              className="topo-line"
              d="M176 794c78 0 140 48 140 122s-64 134-142 134-140-50-140-124 64-132 142-132Z"
            />
            <path
              className="topo-line"
              d="M176 838c56 0 100 33 100 85s-44 92-100 92-100-35-100-87 44-90 100-90Z"
            />
            <path
              className="topo-line"
              d="M176 884c30 0 54 17 54 45s-24 49-54 49-54-19-54-47 24-47 54-47Z"
            />
            <path
              className="topo-line"
              d="M-40 760c160-40 252-102 344-166 96-68 176-126 272-150 82-18 154-4 220 46"
            />
            <path className="topo-line" d="M760 640c46-42 122-42 156 6" />
            <path
              className="topo-line accent"
              d="M58 896c168-58 268-140 380-206 118-70 208-150 294-236 46-46 82-70 138-88"
            />
            <path
              className="topo-line accent"
              d="M58 930c176-58 282-142 396-210 120-72 212-152 300-240 46-46 82-70 138-88"
            />
            <circle className="topo-point" cx="732" cy="454" r="3" />
            <circle className="topo-ring" cx="732" cy="454" r="8" />
            <text className="topo-ping" x="708" y="441" textAnchor="end">
              RIDGE 01
            </text>
            <text className="topo-ping-sub" x="708" y="457" textAnchor="end">
              148 M / 274°
            </text>
            <path className="topo-leader" d="M716 446l10 4" />
          </svg>

          <img src={watermarkImage} alt="" aria-hidden="true" data-decor="login-watermark" />

          <div className="relative z-[2] flex items-start justify-between gap-6">
            <BrandLockup variant="login" />
            <div className="whitespace-nowrap text-right font-mono text-[9.5px] leading-[1.7] tracking-[0.06em] text-ink-3">
              23.8103° N<br />
              90.4125° E
            </div>
          </div>

          <div className="relative z-[2] my-auto max-w-[560px] self-start py-12">
            <h1
              className="m-0 max-w-none text-display-xl font-medium leading-[1.01] tracking-[-0.038em] text-balance until-wide:text-display-lg until-drawer:text-display-md until-phone-lg:text-display-sm"
              data-decor="login-title"
            >
              {brand.tagline}
            </h1>
          </div>

          <figure className="relative z-[2] mb-7 ml-0 mr-0 mt-0 grid h-[clamp(190px,36vh,360px)] flex-none grid-cols-2 gap-0.5 overflow-hidden rounded-[18px] border border-login-banner-edge bg-sunken [box-shadow:var(--shadow-login-banner)]">
            <img
              className="block size-full object-cover object-[50%_30%]"
              src={cargoImage}
              alt=""
              aria-hidden="true"
            />
            <img
              className="block size-full object-cover object-[100%_40%]"
              src={heavyLiftImage}
              alt=""
              aria-hidden="true"
            />
          </figure>

          <div
            className="relative z-[2] flex items-center gap-2.5 font-mono text-[9.5px] uppercase tracking-[0.05em] text-ink-3"
            data-decor="login-caption"
          >
            Operations console
          </div>
        </div>

        <div
          className="relative grid min-w-0 grid-rows-[1fr_auto] overflow-hidden [box-shadow:var(--shadow-login-panel)]"
          data-decor="login-panel"
        >
          <img src={deliveryImage} alt="" aria-hidden="true" data-decor="login-panel-photo" />
          <img
            src={medicalImage}
            alt=""
            aria-hidden="true"
            data-decor="login-panel-photo-top-left"
          />
          <img
            src={heavyLiftImage}
            alt=""
            aria-hidden="true"
            data-decor="login-panel-photo-upper-left"
          />
          <img src={cargoImage} alt="" aria-hidden="true" data-decor="login-panel-photo-top" />

          <div className="relative z-[1] grid place-items-center px-[clamp(28px,4vw,56px)] py-10 until-drawer:px-5 until-drawer:pb-[26px] until-drawer:pt-7">
            {challenge ? (
              <TwoStepLogin
                token={challenge}
                onVerified={onLogin}
                onBack={() => {
                  setChallenge(null)
                  setFormError(null)
                }}
              />
            ) : (
              <form
                className="w-full max-w-[400px] rounded-[18px] border border-login-card-edge bg-white px-8 pb-[30px] pt-9 [box-shadow:inset_0_3px_0_var(--gold),var(--shadow-login-card)]"
                data-testid="login-form"
                onSubmit={submit}
                noValidate
              >
                <div className="mb-6 hidden until-drawer:block">
                  <BrandLockup variant="login" />
                </div>
                <h2 className="mb-1.5 mt-0 text-[24px] font-semibold tracking-[-0.025em] text-login-card-ink">
                  Sign in
                </h2>
                <p className="mb-7 mt-0 text-[12.5px] text-login-card-muted">
                  Use your operations account.
                </p>

                <Field label="Email" htmlFor="login-email">
                  <TextInput
                    ref={emailRef}
                    id="login-email"
                    name="email"
                    type="email"
                    value={email}
                    placeholder="Enter your email"
                    onChange={(event) => {
                      setEmail(event.target.value)
                      setFormError(null)
                    }}
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                  />
                </Field>

                <Field label="Password" htmlFor="login-password" className="mt-4">
                  <div className="relative">
                    <TextInput
                      ref={passwordRef}
                      trailing
                      invalid={Boolean(fieldError)}
                      id="login-password"
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value)
                        setFieldError(null)
                        setFormError(null)
                      }}
                      placeholder="Enter your password"
                      autoComplete="current-password"
                      aria-describedby={fieldError ? 'login-password-error' : undefined}
                      required
                    />
                    <button
                      className="absolute right-[5px] top-1/2 grid size-[34px] place-items-center rounded-sm text-login-card-muted [transform:translateY(-50%)] hover:bg-sunken hover:text-ink"
                      type="button"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((current) => !current)}
                    >
                      <Icon name={showPassword ? 'eyeOff' : 'eye'} />
                    </button>
                  </div>
                  {fieldError && <FieldError id="login-password-error">{fieldError}</FieldError>}
                </Field>

                {formError && (
                  <p
                    role="alert"
                    className="mt-4 rounded-md border border-danger-edge bg-live-soft px-3 py-2.5 text-[12px] text-danger-text"
                  >
                    {formError}
                  </p>
                )}

                <Button type="submit" variant="submit" className="mt-6" disabled={busy}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </Button>

                <div className="mt-7 flex items-center justify-between gap-3 border-t border-t-login-card-line pt-[18px] text-[11.5px] text-login-card-muted">
                  <span>On an RC Plus 2 controller?</span>
                  <a
                    className="inline-flex items-center gap-[5px] text-[11.5px] font-medium text-pine no-underline hover:underline hover:underline-offset-[3px] [&_svg]:size-3.5"
                    href={withBase('/pilot')}
                  >
                    Open Pilot setup
                    <Icon name="arrowRight" />
                  </a>
                </div>
              </form>
            )}
          </div>

          <div className="relative z-[1] flex items-center justify-center gap-4 border-t border-t-login-foot-line px-[clamp(28px,4vw,56px)] py-4 font-mono text-[9px] uppercase tracking-[0.05em] text-login-foot-text until-drawer:px-5 until-drawer:py-3.5">
            <span className="text-center font-sans text-[11px] normal-case tracking-[0.01em]">
              Copyright © {brand.company}. All rights reserved.
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The second step of a sign-in, for an account with two-step sign-in on: the six-digit code its authenticator app shows
 * (Google Authenticator and the like), or one of its recovery codes. Nothing is signed in until this is right.
 */
function TwoStepLogin({
  token,
  onVerified,
  onBack,
}: {
  token: string
  onVerified: (user: User) => void
  onBack: () => void
}) {
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!code.trim()) {
      setError(recovery ? 'Enter a recovery code.' : 'Enter the 6-digit code.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api.mfaLogin(token, code.trim())
      onVerified(result.user)
    } catch (err) {
      setError((err as Error).message)
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="w-full max-w-[400px] rounded-[18px] border border-login-card-edge bg-white px-8 pb-[30px] pt-9 [box-shadow:inset_0_3px_0_var(--gold),var(--shadow-login-card)]"
      data-testid="two-step-form"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <div className="mb-6 hidden until-drawer:block">
        <BrandLockup variant="login" />
      </div>
      <h2 className="mb-1.5 mt-0 text-[24px] font-semibold tracking-[-0.025em] text-login-card-ink">
        Two-step verification
      </h2>
      <p className="mb-7 mt-0 text-[12.5px] leading-[1.5] text-login-card-muted">
        {recovery
          ? 'Enter one of the recovery codes you saved when you set up two-step sign-in. Each works once.'
          : `Open your authenticator app (Google Authenticator or similar) and enter the 6-digit code it shows for ${brand.name}.`}
      </p>

      <Field label={recovery ? 'Recovery code' : 'Code'} htmlFor="login-code">
        <TextInput
          id="login-code"
          name="code"
          value={code}
          onChange={(event) => {
            setCode(event.target.value)
            setError(null)
          }}
          inputMode={recovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={recovery ? 20 : 7}
          placeholder={recovery ? 'XXXXX-XXXXX' : '123456'}
          className={recovery ? undefined : 'text-center font-mono text-[18px] tracking-[0.3em]'}
          autoFocus
          data-testid="two-step-code"
        />
      </Field>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-danger-edge bg-live-soft px-3 py-2.5 text-[12px] text-danger-text"
        >
          {error}
        </p>
      )}

      <Button type="submit" variant="submit" className="mt-6" disabled={busy}>
        {busy ? 'Checking…' : 'Verify'}
      </Button>

      <div className="mt-7 flex items-center justify-between gap-3 border-t border-t-login-card-line pt-[18px] text-[11.5px]">
        <button
          type="button"
          className="font-medium text-pine hover:underline hover:underline-offset-[3px]"
          onClick={() => {
            setRecovery((current) => !current)
            setCode('')
            setError(null)
          }}
        >
          {recovery ? 'Use the app instead' : 'Use a recovery code'}
        </button>
        <button
          type="button"
          className="font-medium text-login-card-muted hover:underline hover:underline-offset-[3px]"
          onClick={onBack}
        >
          Back to sign in
        </button>
      </div>
    </form>
  )
}
