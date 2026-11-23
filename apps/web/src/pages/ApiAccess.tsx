import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { API_TOKEN_NAME_MAX, type ApiTokenCreated, type ApiTokenRecord } from '@dji/protocol'
import { api } from '../api'
import { withBase } from '../base'
import Icon from '../components/Icon'
import StageBar from '../components/StageBar'
import { deviceLabel } from '../deviceSearch'
import { useFleet } from '../store'
import Badge from '../ui/Badge'
import Button, { ButtonLink } from '../ui/Button'
import Notice from '../ui/Notice'
import { card, emptyPanel, screenBody, td, th } from '../ui/surface'

const stamp = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})
const when = (iso: string | null) => (iso ? stamp.format(new Date(iso)) : null)

const EXPIRIES: { label: string; days: number | null }[] = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
  { label: 'Never expires', days: null },
]

const field =
  'h-9 rounded-md border border-line-strong bg-surface-2 px-3 text-[13px] outline-none focus:border-pine'

function status(token: ApiTokenRecord): 'revoked' | 'expired' | 'working' {
  if (token.revokedAt) return 'revoked'
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) return 'expired'
  return 'working'
}

/**
 * Read-only API tokens: a way for a program of the customer's own (an AI analysis tool) to read the drones,
 * telemetry, pictures and video the account may see. A token is shown once, when it is made.
 */
export default function ApiAccess({
  railOpen,
  onOpenRail,
}: {
  railOpen: boolean
  onOpenRail: (trigger: HTMLButtonElement) => void
}) {
  const devices = useFleet((state) => state.devices)
  const [tokens, setTokens] = useState<ApiTokenRecord[] | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<ApiTokenCreated | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setTokens((await api.apiTokens()).tokens)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const sorted = useMemo(
    () => [...Object.values(devices)].sort((a, b) => deviceLabel(a).localeCompare(deviceLabel(b))),
    [devices],
  )
  const working = tokens?.filter((token) => status(token) === 'working').length ?? 0

  async function revoke(id: string) {
    try {
      await api.revokeApiToken(id)
      setConfirming(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // Needs a secure context: the token stays on screen to copy by hand.
    }
  }

  const example = created
    ? `curl -H "Authorization: Bearer ${created.token}" ${window.location.origin}${withBase('/api/devices')}`
    : ''

  return (
    <>
      <StageBar
        bar="api-access"
        title="API access"
        summary={tokens ? `${working} working / ${tokens.length} made` : undefined}
        actions={
          <>
            <ButtonLink
              variant="secondary"
              href={withBase('/api/v1/openapi.json')}
              download="drone-fleet-api.json"
              data-testid="api-openapi"
            >
              <Icon name="download" />
              API description
            </ButtonLink>
            <Button
              variant="mapPrimary"
              type="button"
              data-testid="api-new"
              onClick={() => {
                setCreating((value) => !value)
                setCreated(null)
              }}
            >
              <Icon name="plus" />
              New token
            </Button>
          </>
        }
        railOpen={railOpen}
        onOpenRail={onOpenRail}
      />
      <div className={screenBody} data-testid="api-access-screen">
        <p className="mb-4 mt-0 max-w-[78ch] text-[12.5px] leading-[1.6] text-ink-3">
          Give a program of your own (for example an AI analysis tool) read-only access to the
          drones, telemetry, pictures and live video you can see. A token can only look: it can
          never change or delete anything, and you can stop it at any time.
        </p>

        {error && (
          <Notice tone="error" className="mb-3.5" onDismiss={() => setError('')}>
            {error}
          </Notice>
        )}

        {created && (
          <div className={`${card} mb-4 p-4`} data-testid="api-created">
            <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold">
              <Icon name="check" className="size-4 text-ok" />
              Token “{created.record.name}” is ready
            </div>
            <p className="m-0 mb-2.5 text-[12px] text-warn-text">
              Copy it now. It is shown only this once; if you lose it, make a new one.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code
                className="min-w-0 max-w-full flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[12px]"
                data-testid="api-token-value"
              >
                {created.token}
              </code>
              <Button variant="secondary" type="button" onClick={() => void copy(created.token)}>
                <Icon name={copied ? 'check' : 'link'} />
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div className="mt-3 text-[11.5px] text-ink-3">Try it from a terminal:</div>
            <code className="mt-1 block overflow-x-auto whitespace-pre rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[11.5px]">
              {example}
            </code>
            <div className="mt-3">
              <Button variant="secondary" type="button" onClick={() => setCreated(null)}>
                I have copied it
              </Button>
            </div>
          </div>
        )}

        {creating && (
          <NewToken
            drones={sorted.map((device) => ({ sn: device.sn, label: deviceLabel(device) }))}
            onCancel={() => setCreating(false)}
            onError={setError}
            onCreated={(result) => {
              setCreating(false)
              setCreated(result)
              void load()
            }}
          />
        )}

        {tokens && tokens.length === 0 ? (
          <div className={emptyPanel}>
            <div>
              <h2 className="mb-1.5 mt-0 text-[15px] font-semibold">No API tokens yet</h2>
              <p className="m-0 max-w-[50ch] text-[12.5px] leading-[1.6] text-ink-3">
                Press New token, choose which drones it may read, and give the token to the person
                who writes your program. The API description button gives them the full list of what
                it can read.
              </p>
            </div>
          </div>
        ) : (
          tokens && (
            <div className="overflow-x-auto rounded-lg border border-line bg-white [box-shadow:var(--shadow-card)]">
              <table className="w-full border-collapse" data-testid="api-tokens-table">
                <thead>
                  <tr>
                    <th className={th}>Name</th>
                    <th className={th}>Token</th>
                    <th className={th}>Drones</th>
                    <th className={th}>Made</th>
                    <th className={th}>Expires</th>
                    <th className={th}>Last used</th>
                    <th className={th}>Status</th>
                    <th className={th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((token) => {
                    const state = status(token)
                    return (
                      <tr key={token.id} data-testid="api-token-row" data-status={state}>
                        <td className={`${td} font-medium`}>{token.name}</td>
                        <td className={`${td} whitespace-nowrap font-mono text-[11px]`}>
                          {token.prefix}…
                        </td>
                        <td className={td}>
                          {token.deviceSns === null
                            ? 'All I can see'
                            : `${token.deviceSns.length} drone${token.deviceSns.length === 1 ? '' : 's'}`}
                        </td>
                        <td className={`${td} whitespace-nowrap text-[11.5px]`}>
                          {when(token.createdAt)}
                          <span className="block text-ink-3">{token.ownerEmail}</span>
                        </td>
                        <td className={`${td} whitespace-nowrap text-[11.5px]`}>
                          {when(token.expiresAt) ?? 'Never'}
                        </td>
                        <td className={`${td} whitespace-nowrap text-[11.5px]`}>
                          {when(token.lastUsedAt) ?? 'Not yet'}
                          {token.lastUsedIp && (
                            <span className="block font-mono text-[10.5px] text-ink-3">
                              {token.lastUsedIp}
                            </span>
                          )}
                        </td>
                        <td className={td}>
                          <Badge
                            tone={
                              state === 'working'
                                ? 'ok'
                                : state === 'expired'
                                  ? 'pending'
                                  : 'neutral'
                            }
                          >
                            {state === 'working'
                              ? 'Working'
                              : state === 'expired'
                                ? 'Expired'
                                : 'Revoked'}
                          </Badge>
                        </td>
                        <td className={`${td} text-right`}>
                          {state === 'working' &&
                            (confirming === token.id ? (
                              <span className="inline-flex gap-1.5">
                                <Button
                                  variant="secondary"
                                  type="button"
                                  data-testid="api-revoke-confirm"
                                  onClick={() => void revoke(token.id)}
                                >
                                  Stop it for good
                                </Button>
                                <Button
                                  variant="secondary"
                                  type="button"
                                  onClick={() => setConfirming(null)}
                                >
                                  Keep
                                </Button>
                              </span>
                            ) : (
                              <Button
                                variant="secondary"
                                type="button"
                                data-testid="api-revoke"
                                onClick={() => setConfirming(token.id)}
                              >
                                Revoke
                              </Button>
                            ))}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </>
  )
}

function NewToken({
  drones,
  onCreated,
  onCancel,
  onError,
}: {
  drones: { sn: string; label: string }[]
  onCreated: (created: ApiTokenCreated) => void
  onCancel: () => void
  onError: (message: string) => void
}) {
  const [name, setName] = useState('')
  const [all, setAll] = useState(true)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [days, setDays] = useState<number | null>(365)
  const [busy, setBusy] = useState(false)

  const ready = name.trim().length > 0 && (all || chosen.size > 0)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    try {
      onCreated(
        await api.createApiToken({
          name: name.trim(),
          deviceSns: all ? null : [...chosen],
          expiresInDays: days,
        }),
      )
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className={`${card} mb-4 grid gap-3.5 p-4`}
      onSubmit={(event) => void submit(event)}
      data-testid="api-new-form"
    >
      <label className="grid gap-1.5 text-[12px] font-medium text-ink-2">
        What is it for?
        <input
          autoFocus
          value={name}
          maxLength={API_TOKEN_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          placeholder="For example: Acme AI analytics"
          className={`${field} max-w-[420px] font-normal`}
          data-testid="api-name"
        />
      </label>

      <fieldset className="m-0 grid gap-2 border-0 p-0">
        <legend className="mb-1 p-0 text-[12px] font-medium text-ink-2">
          Which drones may it read?
        </legend>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="radio" name="scope" checked={all} onChange={() => setAll(true)} />
          Every drone I can see
        </label>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="radio" name="scope" checked={!all} onChange={() => setAll(false)} />
          Only the drones I choose
        </label>
        {!all && (
          <div className="grid max-h-[220px] gap-1.5 overflow-y-auto rounded-md border border-line bg-surface-2 p-2.5 pl-5">
            {drones.length === 0 && <span className="text-[12px] text-ink-3">No drones yet.</span>}
            {drones.map((drone) => (
              <label key={drone.sn} className="flex items-center gap-2 text-[12.5px]">
                <input
                  type="checkbox"
                  checked={chosen.has(drone.sn)}
                  onChange={(event) =>
                    setChosen((current) => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(drone.sn)
                      else next.delete(drone.sn)
                      return next
                    })
                  }
                />
                {drone.label}
                <span className="font-mono text-[10.5px] text-ink-3">{drone.sn}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <label className="grid gap-1.5 text-[12px] font-medium text-ink-2">
        How long should it work?
        <select
          value={days === null ? 'never' : String(days)}
          onChange={(event) =>
            setDays(event.target.value === 'never' ? null : Number(event.target.value))
          }
          className={`${field} max-w-[220px] font-normal`}
        >
          {EXPIRIES.map((option) => (
            <option key={option.label} value={option.days === null ? 'never' : String(option.days)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex gap-2">
        <Button
          type="submit"
          variant="mapPrimary"
          disabled={!ready || busy}
          data-testid="api-create"
        >
          Make token
        </Button>
        <Button variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
