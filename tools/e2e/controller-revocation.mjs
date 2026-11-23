import assert from 'node:assert/strict'

/**
 * Controller revocation, end to end against a running API:
 *
 *   gateway:revoke  ->  the controller cannot re-enable itself through /api/pilot/user-info
 *   approve         ->  the same controller works again
 *
 * A rejected controller is already blocked by the enrolment check, so this covers the other
 * path: a still-approved controller whose credential an admin revoked directly.
 *
 *   BASE_URL=http://127.0.0.1:3000 node tools/e2e/controller-revocation.mjs
 */
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const pilotEmail = process.env.PILOT_EMAIL ?? 'pilot@example.com'
const pilotPassword = process.env.PILOT_PASSWORD ?? 'pilot-e2e-pass'
const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@example.com'
const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin12345'
const controllerSn = process.env.PILOT_CONTROLLER_SN ?? `REV${Date.now()}`

async function json(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  return { response, body: await response.json().catch(() => ({})) }
}

const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: adminEmail, password: adminPassword }),
})
assert.equal(adminLogin.status, 200, 'admin sign-in must succeed')
const adminHeaders = {
  cookie: adminLogin.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; '),
}

const auth = await json('/api/pilot/auth', {
  method: 'POST',
  body: JSON.stringify({ username: pilotEmail, password: pilotPassword }),
})
assert.equal(auth.body.code, 0, 'pilot sign-in must succeed')
const preauth = auth.body.data.access_token

await json(`/api/admin/controllers/${encodeURIComponent(controllerSn)}/approve`, {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({}),
})

const login = await json('/api/pilot/login', {
  method: 'POST',
  headers: { authorization: `Bearer ${preauth}` },
  body: JSON.stringify({ controllerSn }),
})
assert.equal(login.body.code, 0, 'an approved controller must sign in')
const pilotToken = login.body.data.access_token

// 1. A normal call issues credentials.
const first = await json('/api/pilot/user-info', {
  headers: { authorization: `Bearer ${pilotToken}` },
})
assert.equal(first.response.status, 200, 'credentials must be issued')
assert.ok(first.body.data.mqtt_password)
console.log('approved controller -> credentials issued')

// 2. An admin revokes the credential. `gateway:revoke` does the same `UPDATE`.
const revoked = await fetch(
  `${baseUrl}/api/admin/controllers/${encodeURIComponent(controllerSn)}/reject`,
  {
    method: 'POST',
    headers: { ...adminHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'revocation e2e' }),
  },
)
assert.equal(revoked.status, 200)

// 3. The controller is now rejected, so user-info must refuse even though its token is valid.
const blocked = await json('/api/pilot/user-info', {
  headers: { authorization: `Bearer ${pilotToken}` },
})
assert.equal(blocked.response.status, 403, 'a rejected controller must not refresh credentials')
console.log('rejected controller -> user-info 403')

// 4. Re-approving is the only thing that clears it.
await json(`/api/admin/controllers/${encodeURIComponent(controllerSn)}/approve`, {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({}),
})
const again = await json('/api/pilot/user-info', {
  headers: { authorization: `Bearer ${pilotToken}` },
})
assert.equal(again.response.status, 200, 're-approval must restore credentials')
assert.notEqual(again.body.data.mqtt_password, first.body.data.mqtt_password, 'password rotates')
console.log('re-approved controller -> credentials restored, password rotated')

await fetch(`${baseUrl}/api/admin/controllers/${encodeURIComponent(controllerSn)}/reject`, {
  method: 'POST',
  headers: { ...adminHeaders, 'content-type': 'application/json' },
  body: JSON.stringify({ reason: 'e2e cleanup' }),
})
console.log('PASS controller revocation: reject blocks, approval restores')
