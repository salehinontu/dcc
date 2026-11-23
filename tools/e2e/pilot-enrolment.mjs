import assert from 'node:assert/strict'

/**
 * Controller enrolment, end to end against a running API:
 *   anonymous config -> 401, first login -> pending, admin approval -> credentials issued.
 *
 * Host mode (PGlite) cannot share the database with a second process, so run this against the
 * API that is already serving the app:
 *   BASE_URL=http://localhost:5173 node tools/e2e/pilot-enrolment.mjs
 *
 * Requires an existing pilot account (see docs/deployment.md §8) and an admin account.
 */
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const pilotEmail = process.env.PILOT_EMAIL ?? 'pilot@example.com'
const pilotPassword = process.env.PILOT_PASSWORD ?? 'pilot-e2e-pass'
const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@example.com'
const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin12345'
const controllerSn = process.env.PILOT_CONTROLLER_SN ?? `E2E${Date.now()}`

async function json(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  return { response, body }
}

// 1. The DJI config is no longer readable anonymously.
const anonymous = await fetch(`${baseUrl}/api/pilot/config`)
assert.equal(anonymous.status, 401, 'anonymous /api/pilot/config must be 401')
assert.equal(anonymous.headers.get('cache-control'), 'no-store', 'the config must not be cached')
console.log('anonymous config -> 401, no-store')

// 2. A pilot account can read it after signing in.
const auth = await json('/api/pilot/auth', {
  method: 'POST',
  body: JSON.stringify({ username: pilotEmail, password: pilotPassword }),
})
assert.equal(auth.body.code, 0, 'pilot sign-in must succeed')
const preauth = auth.body.data.access_token
assert.ok(preauth, 'a pre-auth token must be returned')

const config = await json('/api/pilot/config', {
  headers: { authorization: `Bearer ${preauth}` },
})
assert.equal(config.response.status, 200)
assert.ok(config.body.data.appId !== undefined, 'the config must be returned')
console.log('authenticated config -> 200')

// 3. A first-time controller is pending and gets no credentials.
const first = await json('/api/pilot/login', {
  method: 'POST',
  headers: { authorization: `Bearer ${preauth}` },
  body: JSON.stringify({ controllerSn }),
})
assert.equal(first.response.status, 403)
assert.equal(first.body.code, 2, 'an unknown controller must be pending')
console.log(`first login for ${controllerSn} -> pending`)

const denied = await json('/api/pilot/user-info', {
  method: 'GET',
  headers: { authorization: `Bearer ${preauth}` },
})
assert.equal(denied.response.status, 403, 'a pre-auth token cannot read MQTT credentials')

// 4. An admin approves it.
const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: adminEmail, password: adminPassword }),
})
assert.equal(login.status, 200, 'admin sign-in must succeed')
const cookie = login.headers
  .getSetCookie()
  .map((entry) => entry.split(';')[0])
  .join('; ')
const adminHeaders = { cookie }

const list = await json('/api/admin/controllers', { headers: adminHeaders })
assert.equal(list.response.status, 200)
assert.ok(
  list.body.controllers.some(
    (row) => row.controllerSn === controllerSn && row.status === 'pending',
  ),
  'the pending controller must be listed for the admin',
)

const approve = await json(`/api/admin/controllers/${encodeURIComponent(controllerSn)}/approve`, {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({}),
})
assert.equal(approve.response.status, 200)
console.log(`admin approved ${controllerSn}`)

// 5. The same controller now receives a session and its MQTT credentials.
const second = await json('/api/pilot/login', {
  method: 'POST',
  headers: { authorization: `Bearer ${preauth}` },
  body: JSON.stringify({ controllerSn }),
})
assert.equal(second.body.code, 0, 'an approved controller must sign in')
assert.equal(second.body.data.status, 'approved')
const token = second.body.data.access_token

const info = await json('/api/pilot/user-info', { headers: { authorization: `Bearer ${token}` } })
assert.equal(info.response.status, 200, 'credentials must be issued after approval')
assert.ok(info.body.data.mqtt_username && info.body.data.mqtt_password)
console.log('approved controller -> MQTT credentials issued')

// 6. A viewer cannot use the admin endpoints.
const viewer = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: pilotEmail, password: pilotPassword }),
})
assert.equal(
  viewer.status,
  200,
  'the pilot account is a valid dashboard account too; the admin API must still refuse it',
)
const viewerHeaders = {
  cookie: viewer.headers
    .getSetCookie()
    .map((e) => e.split(';')[0])
    .join('; '),
}
const forbidden = await json('/api/admin/controllers', { headers: viewerHeaders })
assert.equal(forbidden.response.status, 403, 'only admins may list controllers')
console.log('non-admin -> 403 on the admin API')

// 7. Clean up so repeated runs stay clean.
await json(`/api/admin/controllers/${encodeURIComponent(controllerSn)}/reject`, {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({ reason: 'e2e cleanup' }),
})
console.log('PASS pilot enrolment: config gated, pending, approval, credentials, authorisation')
