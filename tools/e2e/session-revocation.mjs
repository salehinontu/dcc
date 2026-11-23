import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Server-side session revocation, end to end.
 *
 *   two devices work -> sign-out ends one -> password change keeps this device and ends the
 *   rest -> an admin reset ejects the target immediately -> a disabled account is rejected ->
 *   a live dashboard socket is closed with 4001 when its session is revoked.
 *
 * Self-hosting: it starts `apps/api/test/fixtures/rbac-ui-server.ts` (in-memory PGlite, a
 * known developer, loopback only) rather than touching a development database, so it needs
 * nothing running and leaves nothing behind.
 *
 *   node tools/e2e/session-revocation.mjs
 *
 * The WebSocket step needs Chrome; point CHROME_PATH at it if the default is wrong. Set
 * BASE_URL to run the HTTP steps against an already-running API instead (the developer
 * credentials below must then exist there).
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const external = process.env.BASE_URL?.replace(/\/$/, '')
const adminEmail = process.env.ADMIN_EMAIL ?? 'root@example.com'
const adminPassword = process.env.ADMIN_PASSWORD ?? 'test-root-password'
const firstPassword = 'session-e2e-initial'
const secondPassword = 'session-e2e-rotated'
const resetPassword = 'session-e2e-reset-pw'
const email = `session-e2e-${Date.now()}@example.com`

const children = []
let browser
let apiUrl

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

async function startFixture() {
  const port = await freePort()
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/api/test/fixtures/rbac-ui-server.ts'],
    {
      cwd: root,
      env: { ...process.env, RBAC_API_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let log = ''
  const capture = (data) => {
    log = (log + data).slice(-4000)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  children.push(child)

  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture API exited\n${log}`)
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return `http://127.0.0.1:${port}`
    } catch {
      /* still starting */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new Error(`fixture API did not start\n${log}`)
}

async function json(path, init) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  return { response, body: await response.json().catch(() => ({})) }
}

/** One browser: its cookies are its session. */
function cookieJar(response) {
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .filter((entry) => !entry.endsWith('='))
    .join('; ')
}

async function login(password, target = email) {
  const { response, body } = await json('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: target, password }),
  })
  assert.equal(response.status, 200, `sign-in must succeed: ${JSON.stringify(body)}`)
  return cookieJar(response)
}

/** The `dji_session` value from a jar, for handing to the browser. */
function sessionToken(jar) {
  const entry = jar.split('; ').find((item) => item.startsWith('dji_session='))
  assert.ok(entry, 'the jar must carry a session cookie')
  return entry.slice('dji_session='.length)
}

const me = (cookie) => json('/api/me', { headers: { cookie } })

try {
  apiUrl = external ?? (await startFixture())

  const adminHeaders = {
    cookie: await login(adminPassword, adminEmail),
    'content-type': 'application/json',
  }

  const created = await json('/api/users', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      email,
      password: firstPassword,
      role: 'subadmin',
      permissions: ['drones.view'],
      allDrones: true,
      dronePermissions: {},
    }),
  })
  assert.equal(created.response.status, 201, JSON.stringify(created.body))
  const userId = created.body.user.id

  // The password the admin set works as it is. Change it once, as a user may, and treat
  // everything after that as normal sessions: a change revokes all and reissues this device.
  const bootstrap = await login(firstPassword)
  const rotated = await json('/api/auth/password', {
    method: 'POST',
    headers: { cookie: bootstrap, 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: firstPassword, newPassword: secondPassword }),
  })
  assert.equal(rotated.response.status, 200, JSON.stringify(rotated.body))
  const jarB = cookieJar(rotated.response)

  // 1. Two devices, both live.
  let jarA = await login(secondPassword)
  assert.equal((await me(jarA)).response.status, 200, 'device A works')
  assert.equal((await me(jarB)).response.status, 200, 'device B works')
  console.log('ok   two devices signed in')

  // 2. Sign-out ends that one device, and replaying its cookie does not resurrect it.
  await json('/api/auth/logout', { method: 'POST', headers: { cookie: jarA } })
  assert.equal((await me(jarA)).response.status, 401, 'the signed-out device is rejected')
  assert.equal((await me(jarB)).response.status, 200, 'the other device is untouched')
  console.log('ok   sign-out -> that device 401, the other still 200')

  // 3. Password change: this device continues on a new token, every other device dies.
  jarA = await login(secondPassword)
  const changed = await json('/api/auth/password', {
    method: 'POST',
    headers: { cookie: jarB, 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: secondPassword, newPassword: firstPassword }),
  })
  assert.equal(changed.response.status, 200, JSON.stringify(changed.body))
  const jarB2 = cookieJar(changed.response)
  assert.notEqual(jarB2, jarB, 'the changing device is handed a new token')
  assert.equal((await me(jarB2)).response.status, 200, 'the changing device stays signed in')
  assert.equal((await me(jarB)).response.status, 401, 'its previous token is dead')
  assert.equal((await me(jarA)).response.status, 401, 'every other device is signed out')
  console.log('ok   password change -> this device continues, the rest 401')

  // 4. A live dashboard socket closes with 4001 the moment its session is revoked.
  const chrome =
    process.env.CHROME_PATH ??
    ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(
      (path) => existsSync(path),
    )
  if (!chrome) {
    console.log('skip live-socket check: no Chrome found, set CHROME_PATH')
  } else {
    const puppeteer = (await import('puppeteer-core')).default
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    const token = sessionToken(jarB2)
    // The page must share the API's origin, or the cookie is not sent on the upgrade.
    const origin = new URL(apiUrl).origin
    await page.goto(`${apiUrl}/api/health`, { waitUntil: 'domcontentloaded' })
    await page.setCookie({ name: 'dji_session', value: token, url: `${origin}/` })

    // Open a dashboard socket, then reset the account from the admin session. The socket
    // must be ejected by the revocation — either directly by the hub or by the 2 s
    // keepalive check — and it must be a 4001 (session gone), not a 4003 (rights changed),
    // because the browser treats only 4001 as "do not reconnect".
    const socketClose = page.evaluate(async (url) => {
      const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`)
      return new Promise((resolveClose, rejectClose) => {
        const timer = setTimeout(() => rejectClose(new Error('socket stayed open')), 20_000)
        socket.addEventListener('close', (event) => {
          clearTimeout(timer)
          resolveClose(event.code)
        })
        socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'ping' })))
      })
    }, apiUrl)
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    const reset = await json(`/api/users/${userId}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        role: 'subadmin',
        permissions: ['drones.view'],
        allDrones: true,
        dronePermissions: {},
        disabled: false,
        password: resetPassword,
      }),
    })
    assert.equal(reset.response.status, 200, JSON.stringify(reset.body))
    const closeCode = await socketClose
    assert.equal(closeCode, 4001, `a revoked session must close with 4001, got ${closeCode}`)
    console.log('ok   admin reset -> live socket closed 4001')

    // 5. The reset ejected the target: its old cookie is dead, the new password works.
    assert.equal((await me(jarB2)).response.status, 401, 'the reset device is signed out')
    const jarC = await login(resetPassword)
    assert.equal((await me(jarC)).response.status, 200, 'the new password works')

    // 6. A disabled account is rejected even holding a live cookie.
    const disabled = await json(`/api/users/${userId}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        role: 'subadmin',
        permissions: ['drones.view'],
        allDrones: true,
        dronePermissions: {},
        disabled: true,
      }),
    })
    assert.equal(disabled.response.status, 200, JSON.stringify(disabled.body))
    assert.equal((await me(jarC)).response.status, 401, 'a disabled account is rejected')
    console.log('ok   admin reset + disable -> target 401')
  }

  console.log('PASS session revocation')
} finally {
  if (browser) await browser.close().catch(() => undefined)
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
}
