import { useRef, useState } from 'react'
import { withBase } from '../base'
import { brand } from '../branding'
import Icon from '../components/Icon'
import Logo from '../components/Logo'
import { call, hasBridge, parse, stringData } from '../pilot-bridge'
import Button from '../ui/Button'
import { Field, TextInput } from '../ui/Field'
import { cn } from '../ui/cn'

interface PilotConfig {
  appId: string
  appKey: string
  license: string
  platformName: string
  workspaceId: string
  workspaceName: string
}

interface Step {
  label: string
  state: 'pending' | 'ok' | 'fail'
  detail?: string
}

type Phase =
  | 'no-bridge'
  | 'credentials'
  | 'checking'
  | 'pending'
  | 'rejected'
  | 'connecting'
  | 'connected'
  | 'license-failed'
  | 'error'

const INITIAL_STEPS: Step[] = [
  { label: 'Account sign-in', state: 'pending' },
  { label: 'DJI licence', state: 'pending' },
  { label: 'Controller approval', state: 'pending' },
  { label: 'Cloud API module', state: 'pending' },
  { label: 'Telemetry link', state: 'pending' },
  { label: 'Workspace', state: 'pending' },
  { label: 'Live video service', state: 'pending' },
]

const STEP_PENDING = [
  'Use your fleet account',
  'Checked with the server',
  'An administrator must approve this controller',
  'Loads after sign-in',
  'MQTT connection from Pilot 2',
  'Assigns this controller to the fleet',
  'Enables camera feeds on demand',
]

const STEP_DONE = [
  'Signed in',
  'Verified by Pilot 2',
  'Approved',
  'Module loaded',
  'MQTT connected',
  'Workspace linked',
  'Video service loaded',
]

const noteClass =
  'flex items-start gap-[7px] text-[10.5px] leading-[1.5] text-ink-3 pointer-coarse:text-[12.5px] until-narrow:text-[10px]'
const bodyClass =
  'px-6 pb-6 until-stack:px-5 until-stack:pb-5 pilot-landscape:grid pilot-landscape:grid-cols-2 pilot-landscape:[align-items:start] pilot-landscape:gap-x-8 pilot-landscape:pb-3 pilot-landscape:[&>*:not([data-parity=pilot-steps])]:col-start-1'

function Steps({
  steps,
  activeIndex,
  flush = false,
}: {
  steps: Step[]
  activeIndex: number
  flush?: boolean
}) {
  const done = steps.filter((step) => step.state === 'ok').length

  return (
    <div
      className={cn(
        flush ? 'mt-0 pt-0 [border-top:0]' : 'mt-[22px] border-t border-t-line pt-4',
        'pilot-landscape:col-start-2 pilot-landscape:row-span-4 pilot-landscape:row-start-1 pilot-landscape:mt-0 pilot-landscape:pt-0 pilot-landscape:[border-top:0]',
      )}
      data-parity="pilot-steps"
    >
      <div
        className="mb-1 flex items-center justify-between gap-3 font-mono text-[8.5px] uppercase tracking-[0.08em] text-ink-3 pointer-coarse:text-[11px]"
        data-parity="pilot-steps-title"
      >
        <span>Connection steps</span>
        <span>
          {done} of {steps.length}
        </span>
      </div>

      {steps.map((step, index) => {
        const tone =
          step.state === 'ok'
            ? 'done'
            : step.state === 'fail'
              ? 'fail'
              : index === activeIndex
                ? 'active'
                : 'pending'
        const stateLabel =
          step.state === 'ok'
            ? 'Done'
            : step.state === 'fail'
              ? 'Failed'
              : index === activeIndex
                ? 'Next'
                : 'Waiting'
        const detail = step.detail ?? (step.state === 'ok' ? STEP_DONE[index] : STEP_PENDING[index])
        const indexTone =
          tone === 'done'
            ? 'border-pine bg-pine text-white'
            : tone === 'fail'
              ? 'border-live bg-live text-white'
              : tone === 'active'
                ? 'border-pine bg-surface-2 text-pine-strong'
                : 'border-line-strong bg-surface-2 text-ink-3'
        const labelTone = tone === 'done' || tone === 'active' ? 'text-ink' : 'text-ink-2'
        const stateTone = tone === 'done' ? 'text-ok' : tone === 'fail' ? 'text-live' : 'text-ink-3'

        return (
          <div
            className="flex items-start gap-2.5 py-[7px]"
            key={step.label}
            data-parity={`step-${index}`}
          >
            <span
              className={cn(
                'mt-px grid size-[17px] flex-none place-items-center rounded-[50%] border font-mono text-[8px] tabular-nums pointer-coarse:size-[22px] pointer-coarse:text-[10px]',
                indexTone,
              )}
              data-parity={`step-index-${index}`}
            >
              {index + 1}
            </span>
            <span className="min-w-0 flex-1" data-parity={`step-main-${index}`}>
              <span
                className={cn('block text-[11.5px]', labelTone)}
                data-parity={`step-label-${index}`}
              >
                {step.label}
              </span>
              <span
                className="mt-px block text-[9.5px] leading-[1.4] text-ink-3"
                data-parity={`step-detail-${index}`}
              >
                {detail}
              </span>
            </span>
            <span
              className={cn(
                'ml-auto whitespace-nowrap pt-px font-mono text-[8px] uppercase tracking-[0.05em]',
                stateTone,
              )}
              data-parity={`step-state-${index}`}
            >
              {stateLabel}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function ConnectionLog({ log }: { log: string[] }) {
  if (log.length === 0) return null

  return (
    <details
      className="mt-4 border-t border-t-line pt-3 pilot-landscape:col-start-1"
      data-parity="pilot-log"
    >
      <summary className="cursor-pointer font-mono text-[8.5px] uppercase tracking-[0.08em] text-ink-3 hover:text-ink-2 pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center">
        Connection log
      </summary>
      <div
        className="mt-2 max-h-40 overflow-auto rounded-sm bg-sunken p-2.5 font-mono text-[10px] leading-[1.6] text-ink-2 [word-break:break-word]"
        data-parity="pilot-log-lines"
      >
        {log.map((line, index) => (
          <div key={`${index}-${line}`}>{line}</div>
        ))}
      </div>
    </details>
  )
}

function CardHeader({
  title,
  children,
  context,
}: {
  title: string
  children: string
  context?: string
}) {
  return (
    <div
      className="flex items-start gap-3 px-6 pb-[18px] pt-6 until-stack:px-5 until-stack:pb-4 until-stack:pt-5 pilot-landscape:px-6 pilot-landscape:pb-2 pilot-landscape:pt-3"
      data-parity="pilot-head"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-[50%] bg-white [box-shadow:var(--shadow-brand)]">
        <Logo />
      </span>
      <div>
        <h1 className="m-0 text-[19px] font-semibold tracking-[-0.025em] until-phone-lg:text-[17.5px]">
          {title}
        </h1>
        <p className="mb-0 mt-1 max-w-[40ch] text-[12px] leading-[1.5] text-ink-3 pointer-coarse:text-[12.5px] pilot-landscape:max-w-[70ch]">
          {children}
        </p>
        {context && (
          <p
            className="mb-0 mt-[5px] max-w-[40ch] font-mono text-[12px] leading-[1.5] tracking-[0.03em] text-ink-3 pointer-coarse:text-[12.5px] pilot-landscape:max-w-[70ch]"
            data-parity="pilot-context"
          >
            {context}
          </p>
        )}
      </div>
    </div>
  )
}

function CardFoot({ connected = false }: { connected?: boolean }) {
  return (
    <div
      className="flex items-center justify-between gap-4 border-t border-t-line px-6 py-3 font-mono text-[8.5px] uppercase tracking-[0.04em] text-ink-3 until-stack:px-5 pointer-coarse:text-[11px] pilot-landscape:px-6 pilot-landscape:py-2"
      data-parity="pilot-foot"
    >
      <span>DJI Pilot 2</span>
      {connected ? (
        <span
          className="inline-flex items-center gap-1.5 text-ink-2"
          data-parity="pilot-foot-status"
        >
          <span className="size-[5px] rounded-[50%] bg-ok" aria-hidden="true" />
          Telemetry live
        </span>
      ) : (
        <span>RC Plus 2 Enterprise</span>
      )}
    </div>
  )
}

function BridgeError({
  title,
  description,
  alertTitle,
  alertBody,
  note,
  onReload,
}: {
  title: string
  description: string
  alertTitle: string
  alertBody: string
  note: string
  onReload: () => void
}) {
  return (
    <>
      <CardHeader title={title}>{description}</CardHeader>
      <div className={bodyClass}>
        <div className="flex gap-[11px] rounded-md border border-danger-edge bg-live-soft p-[13px]">
          <Icon name="alert" className="mt-px size-4 flex-none text-live" />
          <div>
            <strong className="block text-[12px] font-semibold text-danger-text">
              {alertTitle}
            </strong>
            <p className="mt-[3px] text-[10.5px] leading-[1.5] text-ink-2">{alertBody}</p>
          </div>
        </div>
        <p className={`${noteClass} mt-[14px]`}>
          <Icon name="link" className="mt-px size-[13px] flex-none" />
          <span>{note}</span>
        </p>
        <Button variant="pilotReload" type="button" className="mt-[14px]" onClick={onReload}>
          <Icon name="refresh" />
          Reload page
        </Button>
      </div>
      <CardFoot />
    </>
  )
}

export default function PilotLogin() {
  // The form comes first: the config (and therefore the DJI licence) is only available to a
  // signed-in pilot, and the licence is needed before the controller serial can be read.
  const [phase, setPhase] = useState<Phase>(() => (hasBridge() ? 'credentials' : 'no-bridge'))
  const [controllerToken, setControllerToken] = useState('')
  const [rebindSn, setRebindSn] = useState('')
  const [rebindMessage, setRebindMessage] = useState('')
  const [rebindBusy, setRebindBusy] = useState(false)
  const [config, setConfig] = useState<PilotConfig | null>(null)
  const [steps, setSteps] = useState<Step[]>(INITIAL_STEPS)
  const [log, setLog] = useState<string[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [controllerSn, setControllerSn] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  // Issued by /api/pilot/auth and valid for five minutes: enough to read the config and
  // bind a controller, not worth persisting. Never written to storage or a cookie.
  const preauthRef = useRef<string | null>(null)

  function addLog(line: string) {
    setLog((current) => [...current.slice(-8), line])
  }

  function setStep(index: number, state: Step['state'], detail?: string) {
    setSteps((current) =>
      current.map((step, position) => (position === index ? { ...step, state, detail } : step)),
    )
  }

  async function connect() {
    setAuthError(null)
    setBusy(true)
    setPhase('checking')

    try {
      const authResponse = await fetch(withBase('/api/pilot/auth'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, flag: 1 }),
      })
      const authBody = (await authResponse.json().catch(() => ({}))) as {
        code?: number
        message?: string
        data?: { access_token?: string }
      }

      if (authResponse.status === 429) {
        setAuthError(
          authBody.message && /^too many/i.test(authBody.message)
            ? authBody.message
            : 'Too many attempts. Wait a minute and try again.',
        )
        setStep(0, 'fail', 'too many attempts')
        setPhase('credentials')
        return
      }
      if (authResponse.status === 403) {
        setAuthError('This account cannot bind a controller. Use a drone operator account.')
        setStep(0, 'fail', 'drone operator account required')
        setPhase('credentials')
        return
      }
      if (authBody.code !== 0 || !authBody.data?.access_token) {
        setAuthError('Email or password is incorrect.')
        setStep(0, 'fail', 'invalid credentials')
        setPhase('credentials')
        return
      }

      const preauth = authBody.data.access_token
      preauthRef.current = preauth
      setStep(0, 'ok')
      addLog(`signed in as ${username}`)

      const configResponse = await fetch(withBase('/api/pilot/config'), {
        headers: { authorization: `Bearer ${preauth}` },
      })
      if (!configResponse.ok) throw new Error('configuration unavailable')
      const configBody = (await configResponse.json()) as { code: number; data: PilotConfig }
      if (configBody.code !== 0) throw new Error('configuration unavailable')
      setConfig(configBody.data)

      if (!configBody.data.appId || !configBody.data.appKey || !configBody.data.license) {
        setStep(1, 'fail', 'App ID, key or licence missing on the server')
        setPhase('license-failed')
        return
      }

      const verified = parse(
        call(
          'platformVerifyLicense',
          configBody.data.appId,
          configBody.data.appKey,
          configBody.data.license,
        ),
      )
      const stillVerified = parse(call('platformIsVerified'))

      if (!verified.ok && !stillVerified.ok) {
        setStep(1, 'fail', verified.message ?? 'licence rejected')
        setPhase('license-failed')
        return
      }
      setStep(1, 'ok')

      // The serial only reads back after a successful licence check, which is why binding is
      // a separate call from signing in.
      const serial = controllerSn || stringData(parse(call('platformGetRemoteControllerSN')))
      if (!serial) {
        setStep(2, 'fail', 'controller serial unavailable')
        addLog('controller serial unavailable — is this page running inside Pilot 2?')
        setPhase('error')
        return
      }
      setControllerSn(serial)

      await requestBinding(preauth, serial, configBody.data)
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'login failed')
      setPhase('error')
    } finally {
      setBusy(false)
    }
  }

  async function requestBinding(preauth: string, serial: string, current: PilotConfig) {
    const response = await fetch(withBase('/api/pilot/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${preauth}` },
      body: JSON.stringify({ controllerSn: serial, flag: 1 }),
    })

    if (response.status === 401) {
      preauthRef.current = null
      setAuthError('Your session expired. Sign in again.')
      setStep(0, 'pending')
      setPhase('credentials')
      return
    }

    const body = (await response.json().catch(() => ({}))) as {
      code?: number
      message?: string
      data?: { access_token?: string; workspace_id?: string; status?: string }
    }

    if (body.code === 2) {
      setStep(2, 'pending', 'Waiting for an administrator')
      setPhase('pending')
      addLog(`controller ${serial} is awaiting approval`)
      return
    }
    if (body.code === 3) {
      setStep(2, 'fail', body.message ?? 'this controller was rejected')
      setPhase('rejected')
      addLog(`controller ${serial} was rejected`)
      return
    }
    if (body.code !== 0 || !body.data?.access_token) {
      throw new Error(body.message ?? 'login failed')
    }

    setStep(2, 'ok')
    setPhase('connecting')
    await establish(body.data.access_token, body.data.workspace_id ?? current.workspaceId, current)
  }

  async function checkApproval() {
    const preauth = preauthRef.current
    if (!preauth || !controllerSn || !config) {
      setPhase('credentials')
      return
    }

    setBusy(true)
    setPhase('checking')
    try {
      await requestBinding(preauth, controllerSn, config)
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'login failed')
      setPhase('error')
    } finally {
      setBusy(false)
    }
  }

  async function establish(token: string, workspaceId: string, current: PilotConfig) {
    const apiLoad = parse(
      call('platformLoadComponent', 'api', JSON.stringify({ host: location.origin, token })),
    )
    call('apiSetToken', token)
    setStep(3, apiLoad.ok ? 'ok' : 'fail', apiLoad.ok ? undefined : apiLoad.message)

    const infoResponse = await fetch(withBase('/api/pilot/user-info'), {
      headers: { authorization: `Bearer ${token}` },
    })
    const infoBody = (await infoResponse.json().catch(() => ({}))) as {
      code?: number
      message?: string
      data?: {
        mqtt_addr: string
        mqtt_username: string
        mqtt_password: string
        workspace_id: string
        status?: string
      }
    }
    if (infoBody.code !== 0 || !infoBody.data) {
      // `user-info` re-checks approval, so a controller rejected between sign-in and here
      // lands on the rejection panel instead of a generic error.
      if (infoBody.data?.status === 'rejected') {
        setStep(2, 'fail', infoBody.message ?? 'this controller was rejected')
        setPhase('rejected')
        return
      }
      throw new Error(infoBody.message ?? 'MQTT credentials unavailable')
    }

    const resolvedWorkspaceId = infoBody.data.workspace_id || workspaceId

    ;(window as unknown as { connectCallback?: (connected: boolean) => void }).connectCallback = (
      connected: boolean,
    ) => {
      if (!connected) {
        setStep(4, 'fail', 'connection refused')
        setPhase('error')
        addLog('MQTT connection failed')
        return
      }

      setStep(4, 'ok')

      call('platformSetWorkspaceId', resolvedWorkspaceId)
      call('platformSetInformation', current.platformName, current.workspaceName, '')
      setStep(5, 'ok')

      // Step 7 of the bridge sequence names this callback; define it before loading the
      // liveshare component or Pilot 2 has nothing to call.
      ;(
        window as unknown as { liveStatusCallback?: (status: unknown) => void }
      ).liveStatusCallback = (status) => {
        addLog(
          `live status ${typeof status === 'string' ? status : JSON.stringify(status)}`.slice(
            0,
            300,
          ),
        )
      }

      const liveLoad = parse(
        call(
          'platformLoadComponent',
          'liveshare',
          JSON.stringify({
            videoPublishType: 'video-on-demand',
            statusCallback: 'liveStatusCallback',
          }),
        ),
      )
      setStep(6, liveLoad.ok ? 'ok' : 'fail', liveLoad.ok ? undefined : liveLoad.message)

      // Kept for the rebind panel: a pilot can restore an aircraft that was soft-deleted,
      // which an admin cannot do from the dashboard.
      setControllerToken(token)
      setPhase('connected')
      addLog('connected to the cloud')
    }

    const thingLoad = parse(
      call(
        'platformLoadComponent',
        'thing',
        JSON.stringify({
          host: infoBody.data.mqtt_addr,
          username: infoBody.data.mqtt_username,
          password: infoBody.data.mqtt_password,
          connectCallback: 'connectCallback',
        }),
      ),
    )

    if (!thingLoad.ok) {
      setStep(4, 'fail', thingLoad.message)
      setPhase('error')
    }
  }

  const reload = () => window.location.reload()
  const activeIndex = steps.findIndex((step) => step.state === 'pending')
  const failedStep = steps.find((step) => step.state === 'fail')
  const allOk = steps.every((step) => step.state === 'ok')
  const setupVisible =
    phase === 'credentials' ||
    phase === 'checking' ||
    phase === 'connecting' ||
    (phase === 'error' && config !== null)
  const context = config ? `${config.platformName} / ${config.workspaceName}` : brand.name
  const hasAlert = phase === 'error' || Boolean(failedStep) || Boolean(authError)

  return (
    <div
      className="flex h-full flex-col items-center overflow-y-auto bg-paper pt-7 pr-[max(20px,env(safe-area-inset-right))] pb-[max(40px,env(safe-area-inset-bottom))] pl-[max(20px,env(safe-area-inset-left))] [-webkit-tap-highlight-color:transparent] touch-manipulation [scroll-padding-block:80px] overscroll-contain until-stack:pt-5 pilot-landscape:pb-2 pilot-landscape:pt-2"
      data-parity="pilot"
      data-testid="pilot"
    >
      <div
        className="w-full max-w-[456px] flex-none overflow-hidden rounded-lg border border-line bg-surface-2 [box-shadow:var(--shadow-card)] pilot-landscape:max-w-[880px]"
        data-parity="pilot-card"
      >
        {phase === 'no-bridge' && (
          <BridgeError
            title="Pilot bridge not found"
            description="This page has to run inside DJI Pilot 2. A normal browser cannot open the controller bridge."
            alertTitle="Load this page from Pilot 2"
            alertBody={`On the RC Plus 2, open Cloud Services in Pilot 2, then load the ${brand.name} address. The controller serial is read from Pilot 2 automatically.`}
            note="If the bridge is still missing, check that the page is open inside the Pilot 2 web view, not a desktop browser."
            onReload={reload}
          />
        )}

        {phase === 'license-failed' && (
          <BridgeError
            title="Licence verification failed"
            description="Pilot 2 could not verify this application's Cloud API licence."
            alertTitle="Check the server licence"
            alertBody="Check the App ID, App Key and Licence on the server, then reopen this page."
            note={steps[0]?.detail ?? 'The DJI licence was rejected by Pilot 2.'}
            onReload={reload}
          />
        )}

        {phase === 'error' && config === null && (
          <BridgeError
            title="Configuration unavailable"
            description={`${brand.name} could not read its Pilot configuration from the server.`}
            alertTitle="Check the Pilot configuration"
            alertBody="The server did not return an App ID, App Key and licence. Fix the server configuration, then reload."
            note={steps[0]?.detail ?? 'Configuration could not be loaded.'}
            onReload={reload}
          />
        )}

        {phase === 'pending' && (
          <>
            <CardHeader title="Awaiting approval" context={context}>
              This controller has asked to join the fleet. An administrator has to approve it before
              Pilot 2 can report telemetry.
            </CardHeader>

            <div className={bodyClass}>
              <div
                className="flex gap-[11px] rounded-md border border-warn-edge bg-warn-soft p-[13px]"
                data-parity="pilot-pending"
                data-testid="pilot-pending"
              >
                <Icon name="alert" className="mt-px size-4 flex-none text-warn" />
                <div>
                  <strong className="block text-[12px] font-semibold text-warn-text">
                    Waiting for an administrator
                  </strong>
                  <p className="mt-[3px] text-[10.5px] leading-[1.5] text-ink-2">
                    Controller{' '}
                    <span className="font-mono text-[9.5px] break-all">{controllerSn}</span> is
                    registered as pending. Nothing reaches the fleet until it is approved.
                  </p>
                </div>
              </div>

              <Button
                type="button"
                variant="pilotReload"
                className="mt-[14px]"
                disabled={busy}
                onClick={() => void checkApproval()}
              >
                <Icon name="refresh" />
                {busy ? 'Checking…' : 'Check approval'}
              </Button>

              <Steps steps={steps} activeIndex={activeIndex} />
              <ConnectionLog log={log} />
            </div>

            <CardFoot />
          </>
        )}

        {phase === 'rejected' && (
          <>
            <CardHeader title="Controller not approved" context={context}>
              An administrator has refused this controller. Pilot 2 cannot report telemetry from it.
            </CardHeader>

            <div className={bodyClass}>
              <div
                className="flex gap-[11px] rounded-md border border-danger-edge bg-live-soft p-[13px]"
                data-parity="pilot-rejected"
                data-testid="pilot-rejected"
              >
                <Icon name="alert" className="mt-px size-4 flex-none text-live" />
                <div>
                  <strong className="block text-[12px] font-semibold text-danger-text">
                    Rejected
                  </strong>
                  <p className="mt-[3px] text-[10.5px] leading-[1.5] text-ink-2">
                    {failedStep?.detail ??
                      'Ask an administrator to approve this controller, then reload the page.'}
                  </p>
                </div>
              </div>

              <p className={`${noteClass} mt-[14px]`}>
                <Icon name="link" className="mt-px size-[13px] flex-none" />
                <span>
                  Controller{' '}
                  <span className="font-mono text-[9.5px] break-all text-ink-2">
                    {controllerSn || 'unknown'}
                  </span>
                </span>
              </p>

              <Button variant="pilotReload" type="button" className="mt-[14px]" onClick={reload}>
                <Icon name="refresh" />
                Reload page
              </Button>

              <ConnectionLog log={log} />
            </div>

            <CardFoot />
          </>
        )}

        {setupVisible && (
          <>
            <CardHeader title="Connect this controller" context={context}>
              Sign in on the RC Plus 2 so Pilot 2 can join the fleet. Keep this page open while you
              fly.
            </CardHeader>

            <div className={bodyClass}>
              {hasAlert && (
                <div className="flex gap-[11px] rounded-md border border-danger-edge bg-live-soft p-[13px]">
                  <Icon name="alert" className="mt-px size-4 flex-none text-live" />
                  <div>
                    <strong className="block text-[12px] font-semibold text-danger-text">
                      {authError ? 'Sign-in failed' : 'Connection interrupted'}
                    </strong>
                    <p className="mt-[3px] text-[10.5px] leading-[1.5] text-ink-2">
                      {authError ??
                        failedStep?.detail ??
                        log[log.length - 1] ??
                        'Check the controller and try again.'}
                    </p>
                  </div>
                </div>
              )}

              <div className={cn(noteClass, 'mb-[18px]', hasAlert ? 'mt-[14px]' : 'mt-0')}>
                <Icon name="link" className="mt-px size-[13px] flex-none" />
                <span>
                  {controllerSn ? (
                    <>
                      Controller{' '}
                      <span className="font-mono text-[9.5px] break-all text-ink-2">
                        {controllerSn}
                      </span>{' '}
                      detected by Pilot 2.
                    </>
                  ) : (
                    'Waiting for the controller serial from Pilot 2.'
                  )}
                </span>
              </div>

              <form
                className="m-0"
                data-testid="pilot-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void connect()
                }}
              >
                <Field label="Email" htmlFor="pilot-email" tone="pilot">
                  <div className="relative">
                    <Icon
                      name="user"
                      className="pointer-events-none absolute left-[13px] top-1/2 size-4 text-ink-3 [transform:translateY(-50%)]"
                    />
                    <TextInput
                      tone="default"
                      fieldSize="pilot"
                      leadingIcon
                      id="pilot-email"
                      name="email"
                      type="email"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      placeholder="operator@example.com"
                      autoComplete="username"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      autoFocus
                      required
                    />
                  </div>
                </Field>

                <Field label="Password" htmlFor="pilot-password" tone="pilot" className="mt-[15px]">
                  <div className="relative">
                    <Icon
                      name="lock"
                      className="pointer-events-none absolute left-[13px] top-1/2 size-4 text-ink-3 [transform:translateY(-50%)]"
                    />
                    <TextInput
                      tone="default"
                      fieldSize="pilot"
                      leadingIcon
                      id="pilot-password"
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="Enter your password"
                      autoComplete="current-password"
                      required
                    />
                    <button
                      className="absolute right-[5px] top-1/2 grid size-11 place-items-center rounded-sm text-ink-3 [transform:translateY(-50%)] hover:bg-sunken hover:text-ink [&_svg]:size-[18px]"
                      type="button"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((current) => !current)}
                    >
                      <Icon name={showPassword ? 'eyeOff' : 'eye'} />
                    </button>
                  </div>
                </Field>

                <Button type="submit" variant="pilotSubmit" disabled={busy}>
                  {busy
                    ? phase === 'checking'
                      ? 'Checking…'
                      : 'Connecting…'
                    : 'Connect controller'}
                </Button>

                <p className={`${noteClass} mt-3`}>
                  <Icon name="alert" className="mt-px size-[13px] flex-none" />
                  <span>
                    This page only works inside DJI Pilot 2. In a normal browser the Pilot bridge is
                    unavailable.
                  </span>
                </p>
              </form>

              <Steps steps={steps} activeIndex={activeIndex} />
              <ConnectionLog log={log} />
            </div>

            <CardFoot />
          </>
        )}

        {phase === 'connected' && (
          <div data-parity="pilot-connected" data-testid="pilot-connected">
            <CardHeader title="Controller connected" context={context}>
              {`This RC Plus 2 is reporting to ${brand.name}. Keep this page open for the duration of the flight.`}
            </CardHeader>

            {allOk ? (
              <div
                className="mx-6 mb-5 flex items-start gap-[11px] rounded-md border border-line-soft bg-pine-wash p-[13px] until-stack:mx-5 pilot-landscape:mb-3"
                data-parity="connected-panel"
              >
                <span
                  className="grid size-6 flex-none place-items-center rounded-[50%] bg-pine text-white"
                  data-parity="connected-check"
                  aria-hidden="true"
                >
                  <Icon name="check" className="size-[13px] [stroke-width:2]" />
                </span>
                <div className="min-w-0 flex-1" data-parity="connected-main">
                  <strong className="block text-[12px] font-semibold text-pine-strong">
                    Telemetry and video are linked
                  </strong>
                  <p className="mt-[3px] text-[10.5px] leading-[1.5] text-ink-2">
                    Controller{' '}
                    <span className="font-mono text-[9px] break-all text-ink-3">
                      {controllerSn || 'this controller'}
                    </span>{' '}
                    is bound to {config?.workspaceName ?? 'the fleet console'}.
                  </p>
                </div>
              </div>
            ) : (
              <div
                className="mx-6 mb-5 flex gap-[11px] rounded-md border border-warn-edge bg-warn-soft p-[13px] until-stack:mx-5 pilot-landscape:mb-3"
                data-parity="pilot-connected-alert"
              >
                <Icon name="alert" className="mt-px size-4 flex-none text-warn" />
                <div>
                  <strong className="block text-[12px] font-semibold text-warn-text">
                    Connected with limited services
                  </strong>
                  <p className="mt-[3px] text-[10.5px] leading-[1.5] text-ink-2">
                    {failedStep?.detail ??
                      'One of the connection steps did not complete. Live video may be unavailable.'}
                  </p>
                </div>
              </div>
            )}

            <div className={bodyClass} data-parity="pilot-connected-body">
              <form
                className="mb-4 rounded-md border border-line bg-surface-2 p-[13px]"
                data-parity="pilot-rebind"
                onSubmit={(event) => {
                  event.preventDefault()
                  setRebindBusy(true)
                  setRebindMessage('')
                  void fetch(withBase('/api/pilot/bind'), {
                    method: 'POST',
                    headers: {
                      'content-type': 'application/json',
                      authorization: `Bearer ${controllerToken}`,
                    },
                    body: JSON.stringify({ deviceSn: rebindSn.trim() }),
                  })
                    .then(async (response) => {
                      const result = (await response.json()) as { message: string }
                      setRebindMessage(
                        response.ok
                          ? 'Drone rebound. Reconnect the drone in Pilot 2 to resume telemetry and video.'
                          : result.message,
                      )
                    })
                    .catch(() => setRebindMessage('Could not rebind. Check the connection.'))
                    .finally(() => setRebindBusy(false))
                }}
              >
                <strong className="block text-[12px] font-semibold text-ink">
                  Rebind a deleted drone
                </strong>
                <p className="mb-3 mt-[3px] text-[10.5px] leading-[1.5] text-ink-2">
                  Enter the drone serial previously linked to this controller. Your account needs
                  binding access to this drone.
                </p>
                <Field label="Drone serial" htmlFor="rebind-serial" tone="pilot">
                  <TextInput
                    id="rebind-serial"
                    tone="default"
                    fieldSize="pilot"
                    required
                    pattern="[A-Za-z0-9_-]{1,64}"
                    value={rebindSn}
                    onChange={(event) => setRebindSn(event.target.value)}
                    placeholder="Drone serial"
                  />
                </Field>
                <Button
                  type="submit"
                  variant="pilotReload"
                  className="mt-3 w-full disabled:cursor-progress disabled:opacity-60"
                  disabled={rebindBusy}
                >
                  {rebindBusy ? 'Rebinding…' : 'Rebind drone'}
                </Button>
                {rebindMessage && (
                  <p role="status" className="mb-0 mt-2.5 text-[10.5px] leading-[1.5] text-ink-2">
                    {rebindMessage}
                  </p>
                )}
              </form>
              <Steps steps={steps} activeIndex={-1} flush />

              <p
                className={cn(noteClass, 'mt-4 pilot-landscape:mt-0')}
                data-parity="pilot-keepalive"
              >
                <Icon name="alert" className="mt-px size-[13px] flex-none" />
                <span>Keep this screen open. Closing it stops telemetry from this controller.</span>
              </p>

              <ConnectionLog log={log} />
            </div>

            <CardFoot connected />
          </div>
        )}
      </div>
    </div>
  )
}
