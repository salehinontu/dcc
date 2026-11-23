import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { defaultPermissions } from '@dji/protocol'
import { AuditLog } from '../src/audit'
import { hashPassword, issueSession, publicUser } from '../src/auth'
import { config } from '../src/config'
import { migrate, type Db } from '../src/db'
import { Hub } from '../src/hub'
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  openSecret,
  otpauthUrl,
  sealSecret,
  stepAt,
  totpCode,
  verifyTotp,
} from '../src/mfa'
import { MqttAuthorizer } from '../src/mqtt-auth'
import { Registry } from '../src/registry'
import { buildServer } from '../src/server'
import { Store } from '../src/store'
import { StreamManager } from '../src/streams/manager'
import { WhepSessions } from '../src/streams/whep'
import type { MqttBridge } from '../src/mqtt'

const embedded = new PGlite()
const db: Db = {
  query: async <T>(sql: string, params?: unknown[]) => (await embedded.query<T>(sql, params)).rows,
  exec: async (sql) => {
    await embedded.exec(sql)
  },
  close: () => embedded.close(),
}
const store = new Store(db)
const hub = new Hub()
const registry = new Registry(store, 'workspace')
const bridge = {
  connected: true,
  subscribed: true,
  callService: async () => ({}),
} as unknown as MqttBridge
const whep = new WhepSessions()
const manager = new StreamManager({ store, hub, bridge, whep })
const authorizer = new MqttAuthorizer(store)
const audit = new AuditLog(db)

let app: Awaited<ReturnType<typeof buildServer>>
const ids: Record<string, string> = {}
const PASSWORD = 'initial-password-123'

/** Each request comes from its own address: the routes are rate-limited per address, and a test makes many. */
let nextAddress = 0
const fromNewAddress = (): string =>
  `10.7.${Math.floor(nextAddress / 250)}.${(nextAddress++ % 250) + 1}`

async function account(name: string, role: string, adminId: string | null = null) {
  const id = randomUUID()
  ids[name] = id
  await store.createUser(id, `${name}@example.com`, await hashPassword(PASSWORD), role, {
    permissions: defaultPermissions(role),
    allDrones: true,
    dronePermissions: {},
    mustChangePassword: false,
    adminId: role === 'admin' ? null : adminId,
  })
}

/** A request signed in as an account, without going through the password and code (for what is not under test). */
async function call(
  name: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
) {
  const token = await issueSession(publicUser((await store.findUserById(ids[name]!))!), store)
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown> | undefined,
    remoteAddress: fromNewAddress(),
  })
}

const login = (name: string, password = PASSWORD) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'user-agent': 'Test Browser/1.0' },
    payload: { email: `${name}@example.com`, password },
    remoteAddress: fromNewAddress(),
  })

const second = (token: string, code: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/mfa',
    payload: { token, code },
    remoteAddress: fromNewAddress(),
  })

/** The code the app shows now. The server accepts a step only once, so a test that signs in twice moves the account's clock back. */
const codeNow = (secret: string, ahead = 0) => totpCode(secret, stepAt(Date.now()) + ahead)
const forgetSpentCodes = () =>
  db.query(`UPDATE users SET totp_last_step = 0, totp_failures = 0, totp_locked_until = NULL`)

/** Sets two-step sign-in up for an account the way a person does, and returns what the app would hold. */
async function enrol(name: string): Promise<{ secret: string; recovery: string[] }> {
  const setup = await call(name, 'POST', '/api/auth/mfa/setup', { password: PASSWORD })
  assert.equal(setup.statusCode, 200, setup.body)
  const { secret } = setup.json() as { secret: string }
  const enabled = await call(name, 'POST', '/api/auth/mfa/enable', { code: codeNow(secret) })
  assert.equal(enabled.statusCode, 200, enabled.body)
  await forgetSpentCodes()
  return { secret, recovery: (enabled.json() as { recoveryCodes: string[] }).recoveryCodes }
}

before(async () => {
  await migrate(db)
  await account('developer', 'developer')
  await account('alice', 'admin')
  await account('bob', 'admin')
  await account('carol', 'subadmin', ids.alice!)
  await account('dave', 'subadmin', ids.bob!)
  await account('erin', 'subadmin', ids.alice!)
  await account('pat', 'pilot', ids.alice!)
  app = await buildServer({ store, hub, registry, bridge, whep, manager, authorizer, audit })
  await app.ready()
})

after(async () => {
  await app.close()
})

test('the one-time code is RFC 6238: its test vectors, a window of one step either side, and each code only once', () => {
  // RFC 6238 appendix B, HMAC-SHA1, shared secret "12345678901234567890" (six digits are the last six of its eight).
  const secret = base32Encode(Buffer.from('12345678901234567890'))
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  for (const [seconds, code] of [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ] as const)
    assert.equal(totpCode(secret, stepAt(seconds * 1000)), code, `at ${seconds} s`)

  const now = 1_700_000_010_000
  const step = stepAt(now)
  const at = (offset: number) => totpCode(secret, step + offset)
  assert.equal(verifyTotp(secret, at(0), now), step)
  assert.equal(verifyTotp(secret, at(-1), now), step - 1, 'a phone a little slow')
  assert.equal(verifyTotp(secret, at(1), now), step + 1, 'a phone a little fast')
  assert.equal(verifyTotp(secret, at(-2), now), null, 'too old')
  assert.equal(verifyTotp(secret, at(2), now), null, 'too far ahead')
  // A code works once: nothing at or before the last accepted step is taken again.
  assert.equal(verifyTotp(secret, at(0), now, step), null)
  assert.equal(verifyTotp(secret, at(-1), now, step), null)
  assert.equal(verifyTotp(secret, at(1), now, step), step + 1)
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 3456', '28708２'])
    assert.equal(verifyTotp(secret, bad, now), null, `"${bad}"`)

  assert.deepEqual(
    base32Decode(base32Encode(Buffer.from('hello world'))),
    Buffer.from('hello world'),
  )
  assert.equal(generateTotpSecret().length, 32)
  assert.notEqual(generateTotpSecret(), generateTotpSecret())
  const url = otpauthUrl('Drone Fleet', 'a@b.example', secret)
  assert.match(
    url,
    /^otpauth:\/\/totp\/Drone%20Fleet:a%40b\.example\?secret=[A-Z2-7]+&issuer=Drone%20Fleet&algorithm=SHA1&digits=6&period=30$/,
  )
})

test('the secret is sealed at rest, and recovery codes are ten random, readable, single-use words', () => {
  const secret = generateTotpSecret()
  const sealed = sealSecret(secret)
  assert.ok(sealed.startsWith('v1:'))
  assert.ok(!sealed.includes(secret))
  assert.equal(openSecret(sealed), secret)
  assert.notEqual(sealSecret(secret), sealed, 'a fresh nonce each time')
  assert.equal(openSecret(sealed.slice(0, -4) + 'AAAA'), null, 'an altered value is refused')
  assert.equal(openSecret(null), null)
  const key = config.mfa.encryptionKey
  Object.defineProperty(config.mfa, 'encryptionKey', { value: 'another key', configurable: true })
  try {
    assert.equal(openSecret(sealed), null, 'another server key cannot open it')
  } finally {
    Object.defineProperty(config.mfa, 'encryptionKey', { value: key, configurable: true })
  }

  const codes = generateRecoveryCodes()
  assert.equal(codes.length, 10)
  assert.equal(new Set(codes).size, 10)
  for (const code of codes) {
    assert.match(code, /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/)
    assert.equal(normalizeRecoveryCode(code.toLowerCase().replace('-', ' ')), code.replace('-', ''))
  }
  assert.equal(normalizeRecoveryCode('too-short'), null)
  assert.equal(normalizeRecoveryCode('0O1IL-0O1IL'), null, 'no look-alike characters')
})

test('setting it up needs the password, proves the phone holds the secret, and shows the recovery codes once', async () => {
  assert.equal((await login('alice')).json().user.mfaEnabled, false)
  assert.equal((await call('alice', 'GET', '/api/auth/mfa')).json().enabled, false)
  assert.equal(
    (await call('alice', 'POST', '/api/auth/mfa/setup', { password: 'wrong-password-1' }))
      .statusCode,
    400,
  )

  const setup = (
    await call('alice', 'POST', '/api/auth/mfa/setup', { password: PASSWORD })
  ).json() as {
    secret: string
    otpauthUrl: string
    qr: string
  }
  assert.match(setup.secret, /^[A-Z2-7]{32}$/)
  assert.ok(setup.otpauthUrl.includes(`secret=${setup.secret}`))
  assert.ok(setup.otpauthUrl.includes('alice%40example.com'))
  assert.match(setup.qr, /^data:image\/png;base64,/)
  // Until a code proves it, nothing is on, and the secret in the database is sealed.
  const pending = (await store.findUserById(ids.alice!))!
  assert.equal(pending.totp_enabled_at, null)
  assert.equal(pending.totp_secret, null)
  assert.ok(pending.totp_pending_secret?.startsWith('v1:'))
  assert.ok(!pending.totp_pending_secret!.includes(setup.secret))
  assert.equal(
    (await login('alice')).json().user.email,
    'alice@example.com',
    'still a plain sign-in',
  )

  const wrong = await call('alice', 'POST', '/api/auth/mfa/enable', { code: '000000' })
  assert.equal(wrong.statusCode, 400)
  assert.equal((await store.findUserById(ids.alice!))!.totp_enabled_at, null)
  const done = await call('alice', 'POST', '/api/auth/mfa/enable', { code: codeNow(setup.secret) })
  assert.equal(done.statusCode, 200, done.body)
  const recovery = (done.json() as { recoveryCodes: string[] }).recoveryCodes
  assert.equal(recovery.length, 10)
  const row = (await store.findUserById(ids.alice!))!
  assert.ok(row.totp_enabled_at)
  assert.equal(row.totp_pending_secret, null)
  assert.equal(openSecret(row.totp_secret), setup.secret)
  assert.equal(await store.recoveryCodesLeft(ids.alice!), 10)
  const stored = await db.query<{ code_hash: string }>(
    `SELECT code_hash FROM user_recovery_codes WHERE user_id = $1`,
    [ids.alice],
  )
  assert.ok(
    stored.every(
      (entry) => !recovery.some((code) => entry.code_hash.includes(code.replace('-', ''))),
    ),
    'only hashes are kept',
  )
  assert.equal((await call('alice', 'GET', '/api/auth/mfa')).json().recoveryCodesLeft, 10)
  assert.equal((await call('alice', 'GET', '/api/me')).json().user.mfaEnabled, true)
  // It is on: setting it up again is refused, and the code that proved it cannot be used to sign in a second time.
  assert.equal(
    (await call('alice', 'POST', '/api/auth/mfa/setup', { password: PASSWORD })).statusCode,
    409,
  )
  assert.equal(
    (await call('alice', 'POST', '/api/auth/mfa/enable', { code: codeNow(setup.secret) }))
      .statusCode,
    409,
  )
  await forgetSpentCodes()
  await db.query(`UPDATE users SET totp_secret = $2 WHERE id = $1`, [
    ids.alice,
    sealSecret(setup.secret),
  ])
})

test('with it on, the password opens nothing: a code is needed, each code works once, and a recovery code works once', async () => {
  const secret = openSecret((await store.findUserById(ids.alice!))!.totp_secret)!
  const first = await login('alice')
  assert.equal(first.statusCode, 200)
  const body = first.json() as { mfaRequired?: boolean; mfaToken?: string; user?: unknown }
  assert.equal(body.mfaRequired, true)
  assert.ok(body.mfaToken)
  assert.equal(body.user, undefined, 'no account details before the second step')
  assert.ok(!first.cookies.some((c) => c.name === 'dji_session'), 'no session cookie yet')
  assert.equal(first.headers['cache-control'], 'no-store')
  // The proof of a right password is not a session.
  const asSession = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { authorization: `Bearer ${body.mfaToken}` },
  })
  assert.equal(asSession.statusCode, 401)
  // A wrong password never reaches the second step.
  assert.equal((await login('alice', 'not-the-password')).statusCode, 401)

  assert.equal((await second(body.mfaToken!, '123456')).statusCode, 401)
  assert.equal((await second('x'.repeat(60), codeNow(secret))).statusCode, 401)
  assert.equal(
    (await second('garbage', codeNow(secret))).statusCode,
    400,
    'not even shaped like one',
  )
  assert.equal((await second(body.mfaToken!, 'not a code')).statusCode, 401)

  const code = codeNow(secret)
  const ok = await second(body.mfaToken!, code)
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json().user.email, 'alice@example.com')
  assert.equal(ok.json().method, 'totp')
  const cookie = ok.cookies.find((c) => c.name === 'dji_session')
  assert.ok(cookie?.httpOnly)
  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    cookies: { dji_session: cookie!.value },
  })
  assert.equal(me.statusCode, 200)

  // The same code again, from another sign-in, is not accepted: it has been used.
  const again = (await login('alice')).json() as { mfaToken: string }
  assert.equal((await second(again.mfaToken, code)).statusCode, 401)

  // A recovery code gets in once.
  await forgetSpentCodes()
  const recovery = (
    await call('alice', 'POST', '/api/auth/mfa/recovery-codes', {
      password: PASSWORD,
      code: codeNow(secret),
    })
  ).json().recoveryCodes as string[]
  assert.equal(recovery.length, 10)
  const viaRecovery = await second(
    ((await login('alice')).json() as { mfaToken: string }).mfaToken,
    recovery[0]!.toLowerCase(),
  )
  assert.equal(viaRecovery.statusCode, 200, viaRecovery.body)
  assert.equal(viaRecovery.json().method, 'recovery')
  assert.equal(viaRecovery.json().recoveryCodesLeft, 9)
  const reused = await second(
    ((await login('alice')).json() as { mfaToken: string }).mfaToken,
    recovery[0]!,
  )
  assert.equal(reused.statusCode, 401, 'a recovery code is spent')
})

test('a wrong password or role between the two steps voids the sign-in, and five wrong codes lock the second step', async () => {
  await forgetSpentCodes()
  const secret = openSecret((await store.findUserById(ids.alice!))!.totp_secret)!
  // The password is changed after the first step: the proof it gave is void.
  const stale = ((await login('alice')).json() as { mfaToken: string }).mfaToken
  await db.query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [
    ids.alice,
  ])
  assert.equal((await second(stale, codeNow(secret))).statusCode, 401)
  // An account turned off in the meantime cannot finish either.
  const fresh = ((await login('alice')).json() as { mfaToken: string }).mfaToken
  await db.query(`UPDATE users SET disabled = TRUE WHERE id = $1`, [ids.alice])
  assert.equal((await second(fresh, codeNow(secret))).statusCode, 401)
  await db.query(`UPDATE users SET disabled = FALSE WHERE id = $1`, [ids.alice])

  const token = ((await login('alice')).json() as { mfaToken: string }).mfaToken
  const statuses: number[] = []
  for (let n = 0; n < 5; n++) statuses.push((await second(token, '000000')).statusCode)
  assert.deepEqual(statuses, [401, 401, 401, 401, 429], 'the fifth wrong code in a row locks it')
  const locked = await second(token, codeNow(secret))
  assert.equal(locked.statusCode, 429, 'a right code is refused while it is locked')
  assert.match(locked.json().error, /Try again in \d+ minute/)
  // The lock is on the account: a fresh sign-in is no way round it.
  const other = ((await login('alice')).json() as { mfaToken: string }).mfaToken
  assert.equal((await second(other, codeNow(secret))).statusCode, 429)
  await forgetSpentCodes()
  assert.equal(
    (await second(other, codeNow(secret))).statusCode,
    200,
    'it opens again when the lock ends',
  )
})

test('turning it off needs the password and a code, signs the other devices out, and a role that must have it cannot', async () => {
  await forgetSpentCodes()
  const secret = openSecret((await store.findUserById(ids.alice!))!.totp_secret)!
  const other = await issueSession(publicUser((await store.findUserById(ids.alice!))!), store)
  const mine = await issueSession(publicUser((await store.findUserById(ids.alice!))!), store)
  const disable = (token: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/mfa/disable',
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    })

  assert.equal(
    (await disable(mine, { password: 'wrong-password-1', code: codeNow(secret) })).statusCode,
    400,
  )
  assert.equal((await disable(mine, { password: PASSWORD, code: '111111' })).statusCode, 400)
  assert.ok((await store.findUserById(ids.alice!))!.totp_enabled_at, 'still on')

  Object.defineProperty(config.mfa, 'requiredRoles', { value: ['admin'], configurable: true })
  try {
    const refused = await disable(mine, { password: PASSWORD, code: codeNow(secret) })
    assert.equal(refused.statusCode, 403)
    assert.match(refused.json().error, /requires/)
  } finally {
    Object.defineProperty(config.mfa, 'requiredRoles', { value: [], configurable: true })
  }

  await forgetSpentCodes()
  const done = await disable(mine, { password: PASSWORD, code: codeNow(secret) })
  assert.equal(done.statusCode, 200, done.body)
  const row = (await store.findUserById(ids.alice!))!
  assert.equal(row.totp_enabled_at, null)
  assert.equal(row.totp_secret, null)
  assert.equal(await store.recoveryCodesLeft(ids.alice!), 0)
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${mine}` },
      })
    ).statusCode,
    200,
    'this device stays signed in',
  )
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${other}` },
      })
    ).statusCode,
    401,
    'the others do not',
  )
  assert.equal(
    (await login('alice')).json().user.email,
    'alice@example.com',
    'a plain sign-in again',
  )
})

test('a role that must have it is held at the set-up until it does, and a Pilot never takes part', async () => {
  Object.defineProperty(config.mfa, 'requiredRoles', {
    value: ['admin', 'subadmin'],
    configurable: true,
  })
  try {
    const result = await login('bob')
    const user = result.json().user as { mfaRequired: boolean; mfaEnrolRequired: boolean }
    assert.equal(result.statusCode, 200)
    assert.equal(user.mfaRequired, true)
    assert.equal(user.mfaEnrolRequired, true)
    const cookie = result.cookies.find((c) => c.name === 'dji_session')!.value
    const get = (url: string) =>
      app.inject({ method: 'GET', url, cookies: { dji_session: cookie } })

    // Signed in, but with nothing to use until it is set up.
    assert.equal((await get('/api/me')).statusCode, 200)
    for (const url of ['/api/devices', '/api/users', '/api/screenshots', '/api/audit']) {
      const refused = await get(url)
      assert.equal(refused.statusCode, 403, url)
      assert.equal(refused.json().error, 'mfa_enrolment_required', url)
    }
    const setup = await app.inject({
      method: 'POST',
      remoteAddress: fromNewAddress(),
      url: '/api/auth/mfa/setup',
      cookies: { dji_session: cookie },
      payload: { password: PASSWORD },
    })
    assert.equal(setup.statusCode, 200, setup.body)
    const { secret } = setup.json() as { secret: string }
    const enable = await app.inject({
      method: 'POST',
      remoteAddress: fromNewAddress(),
      url: '/api/auth/mfa/enable',
      cookies: { dji_session: cookie },
      payload: { code: codeNow(secret) },
    })
    assert.equal(enable.statusCode, 200, enable.body)
    // Now it has what it needs: the same session opens the rest.
    assert.equal((await get('/api/devices')).statusCode, 200)
    assert.equal((await get('/api/me')).json().user.mfaEnrolRequired, false)

    // A Pilot is exempt whatever the list says, and cannot even start.
    const pilot = await login('pat')
    assert.equal(pilot.json().user.mfaRequired, false)
    assert.equal(
      (await call('pat', 'POST', '/api/auth/mfa/setup', { password: PASSWORD })).statusCode,
      403,
    )
    assert.equal((await call('pat', 'GET', '/api/auth/mfa')).statusCode, 403)
  } finally {
    Object.defineProperty(config.mfa, 'requiredRoles', { value: [], configurable: true })
  }
})

test('an administrator can reset an account whose phone was lost, within the limits of editing it', async () => {
  const { secret } = await enrol('carol')
  await enrol('dave')
  const carolSession = await issueSession(
    publicUser((await store.findUserById(ids.carol!))!),
    store,
  )
  assert.equal((await login('carol')).json().mfaRequired, true)

  // Another customer's Admin does not see the account at all; nobody resets their own, a Developer's, or a peer Admin's.
  assert.equal((await call('bob', 'POST', `/api/users/${ids.carol}/mfa/reset`)).statusCode, 404)
  assert.equal((await call('alice', 'POST', `/api/users/${ids.alice}/mfa/reset`)).statusCode, 403)
  assert.equal(
    (await call('alice', 'POST', `/api/users/${ids.developer}/mfa/reset`)).statusCode,
    404,
  )
  assert.equal(
    (await call('developer', 'POST', `/api/users/${ids.developer}/mfa/reset`)).statusCode,
    403,
  )
  assert.equal(
    (await call('carol', 'POST', `/api/users/${ids.erin}/mfa/reset`)).statusCode,
    403,
    'no right to manage users',
  )
  assert.equal(
    (await call('alice', 'POST', `/api/users/${randomUUID()}/mfa/reset`)).statusCode,
    404,
  )
  assert.ok((await store.findUserById(ids.carol!))!.totp_enabled_at, 'nothing changed')

  const reset = await call('alice', 'POST', `/api/users/${ids.carol}/mfa/reset`)
  assert.equal(reset.statusCode, 200, reset.body)
  assert.equal(reset.json().user.mfaEnabled, false)
  const carol = (await store.findUserById(ids.carol!))!
  assert.equal(carol.totp_secret, null)
  assert.equal(await store.recoveryCodesLeft(ids.carol!), 0)
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${carolSession}` },
      })
    ).statusCode,
    401,
    'its sessions ended',
  )
  assert.equal(
    (await login('carol')).json().user.email,
    'carol@example.com',
    'it signs in with the password again',
  )
  assert.notEqual(secret, undefined)
  // A Developer may reset anyone's but its own, and the other accounts keep theirs.
  assert.equal(
    (await call('developer', 'POST', `/api/users/${ids.dave}/mfa/reset`)).statusCode,
    200,
  )
  assert.equal((await call('developer', 'POST', `/api/users/${ids.bob}/mfa/reset`)).statusCode, 200)
})

test('the account list and the sign-in answers carry the state, never a secret, a code or a hash', async () => {
  const { secret, recovery } = await enrol('erin')
  const everything = [
    (await call('developer', 'GET', '/api/users')).body,
    (await call('erin', 'GET', '/api/me')).body,
    (await call('erin', 'GET', '/api/auth/mfa')).body,
    (await login('erin')).body,
  ].join('\n')
  const listed = (await call('developer', 'GET', '/api/users')).json().users as {
    email: string
    mfaEnabled: boolean
  }[]
  assert.equal(listed.find((u) => u.email === 'erin@example.com')!.mfaEnabled, true)
  assert.equal(listed.find((u) => u.email === 'pat@example.com')!.mfaEnabled, false)
  assert.ok(!everything.includes(secret))
  assert.ok(!everything.includes('totp_secret'))
  assert.ok(!everything.includes('v1:'))
  for (const code of recovery) assert.ok(!everything.includes(code))
})

test('the audit trail records each step, who did it, and a wrong code, and never a code, a secret or a recovery code', async () => {
  await audit.flush()
  const rows = await db.query<{
    action: string
    outcome: string
    actor_email: string | null
    details: Record<string, unknown> | null
    target_label: string | null
    status: number | null
  }>(
    `SELECT action, outcome, actor_email, details, target_label, status FROM audit_log ORDER BY seq`,
  )
  const has = (action: string, outcome: string, email: string, detail?: Record<string, unknown>) =>
    rows.some(
      (row) =>
        row.action === action &&
        row.outcome === outcome &&
        row.actor_email === email &&
        (!detail || Object.entries(detail).every(([key, value]) => row.details?.[key] === value)),
    )
  assert.ok(
    has('auth.password_accepted', 'success', 'alice@example.com'),
    'password right, code awaited',
  )
  assert.ok(
    has('auth.login', 'success', 'alice@example.com', { mfa: 'totp' }),
    'signed in with a code',
  )
  assert.ok(
    has('auth.login', 'success', 'alice@example.com', { mfa: 'recovery' }),
    'signed in with a recovery code',
  )
  assert.ok(
    has('auth.login', 'failure', 'alice@example.com', { mfa: 'wrong code' }),
    'a wrong code is a failure, not a refusal',
  )
  assert.ok(has('auth.login', 'failure', 'alice@example.com', { mfa: 'wrong code, locked' }))
  assert.ok(has('auth.login', 'failure', 'alice@example.com', { mfa: 'locked' }))
  assert.ok(has('auth.mfa_setup_started', 'success', 'alice@example.com'))
  assert.ok(has('auth.mfa_enabled', 'success', 'alice@example.com'))
  assert.ok(
    has('auth.mfa_enabled', 'failure', 'alice@example.com'),
    'a wrong code while setting up',
  )
  assert.ok(has('auth.mfa_disabled', 'success', 'alice@example.com'))
  assert.ok(
    has('auth.mfa_disabled', 'denied', 'alice@example.com') ||
      has('auth.mfa_disabled', 'failure', 'alice@example.com'),
  )
  assert.ok(has('auth.mfa_recovery_codes', 'success', 'alice@example.com'))
  assert.ok(
    rows.some(
      (row) =>
        row.action === 'user.mfa_reset' &&
        row.outcome === 'success' &&
        row.actor_email === 'alice@example.com' &&
        row.target_label === 'carol@example.com',
    ),
  )
  assert.ok(
    rows.some((row) => row.action === 'user.mfa_reset' && row.outcome === 'denied'),
    'a refused reset is recorded',
  )

  // Nothing secret reached the trail.
  const text = JSON.stringify(rows)
  for (const secret of (
    await db.query<{ totp_secret: string | null }>(
      `SELECT totp_secret FROM users WHERE totp_secret IS NOT NULL`,
    )
  ).map((r) => openSecret(r.totp_secret)!))
    assert.ok(!text.includes(secret))
  assert.ok(!text.includes('otpauth'))
  assert.ok(!text.includes('mfaToken'))
  assert.ok(!/"code"/.test(text))
  assert.ok(!text.includes('000000'))
  // A sign-in that completed counts as the account's last sign-in.
  const last = await audit.lastLogins()
  assert.ok(last.has('alice@example.com'))
})
