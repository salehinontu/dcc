import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const screenshots = resolve(root, '.data/screenshots/rbac')
mkdirSync(screenshots, { recursive: true })
const children = []
let browser
async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
function start(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (data) => {
    log = (log + data).slice(-5000)
  })
  child.stderr.on('data', (data) => {
    log = (log + data).slice(-5000)
  })
  child.getLog = () => log
  children.push(child)
  return child
}
async function ready(url, child) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(child.getLog())
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Server did not start: ${child.getLog()}`)
}
const operatorEmail = `operator-${Date.now()}@example.com`
try {
  const apiPort = await freePort()
  const webPort = await freePort()
  const apiServer = start(['--import', 'tsx', 'apps/api/test/fixtures/rbac-ui-server.ts'], {
    RBAC_API_PORT: String(apiPort),
  })
  await ready(`http://127.0.0.1:${apiPort}/api/health`, apiServer)
  const webServer = start(
    [
      'apps/web/node_modules/vite/bin/vite.js',
      '--config',
      'apps/web/vite.config.ts',
      '--port',
      String(webPort),
      '--strictPort',
      'apps/web',
    ],
    { API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`, VITE_HOST: '127.0.0.1' },
  )
  await ready(`http://127.0.0.1:${webPort}`, webServer)
  browser = await puppeteer.launch({
    // Same lookup as the other checks, so this works on a developer's Windows machine too.
    executablePath:
      process.env.CHROME_PATH ??
      ['/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(
        (path) => existsSync(path),
      ),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(15000)
  await page.setViewport({ width: 1440, height: 1000 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${webPort}`, { waitUntil: 'networkidle2' })
  await page.type('input[type=email]', 'root@example.com')
  await page.type('input[type=password]', 'test-root-password')
  await page.click('button[type=submit]')
  await page.waitForSelector('[data-testid=app]')
  await page.waitForSelector('[data-testid=aircraft]')
  await page.click('[data-view=users]')
  // The menu is a real address: the list is /users, and a refresh stays there.
  await page.waitForSelector('[data-testid=users-table]')
  assert.equal(new URL(page.url()).pathname, '/users')
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid=users-table]')
  assert.equal(new URL(page.url()).pathname, '/users', 'a refresh stays on the users page')
  // Creation is a step from the list, with its own address.
  await page.click('[data-testid=create-user]')
  await page.waitForSelector('section form input[type=email]')
  assert.equal(new URL(page.url()).pathname, '/users/new')
  // Client-side validation runs before any request: an empty form shows field errors.
  await page.$eval('section form', (form) => form.requestSubmit())
  await page.waitForSelector('#user-email-error')
  await page.waitForSelector('#user-password-error')
  assert.equal(
    await page.$eval('#user-email', (input) => input.placeholder),
    'name@example.com',
    'the email field has a placeholder',
  )
  await page.type('section form input[type=email]', operatorEmail)
  await page.type('section form input[type=password]', 'temporary-password-123')
  // Per-aircraft grants: alpha only, visible and telemetry.
  await page.evaluate(() => {
    const fields = [...document.querySelectorAll('fieldset')]
    const alpha = fields.find((e) => e.querySelector('legend')?.textContent === 'alpha')
    for (const label of alpha.querySelectorAll('label'))
      if (
        ['drones.view', 'telemetry.view'].includes(label.querySelector('input')?.dataset.permission)
      )
        label.querySelector('input').click()
  })
  await page.screenshot({ path: `${screenshots}/users.png`, fullPage: true })
  // Ticking an action on a drone also ticks View drones, since every action needs it.
  const bravoGrants = await page.evaluate(() => {
    const fields = [...document.querySelectorAll('fieldset')]
    const bravo = fields.find((e) => e.querySelector('legend')?.textContent === 'bravo')
    bravo.querySelector('input[data-permission="telemetry.view"]').click()
    return [...bravo.querySelectorAll('input:checked')].map((input) => input.dataset.permission)
  })
  assert.deepEqual(bravoGrants, ['drones.view', 'telemetry.view'])
  // …and clearing View clears the rest, so no grant is left that does nothing.
  const bravoCleared = await page.evaluate(() => {
    const fields = [...document.querySelectorAll('fieldset')]
    const bravo = fields.find((e) => e.querySelector('legend')?.textContent === 'bravo')
    bravo.querySelector('input[data-permission="drones.view"]').click()
    return bravo.querySelectorAll('input:checked').length
  })
  assert.equal(bravoCleared, 0)
  const creation = page.waitForResponse(
    (r) => r.url().endsWith('/api/users') && r.request().method() === 'POST',
  )
  await page.$eval('section form', (form) => form.requestSubmit())
  const response = await creation
  assert.equal(response.status(), 201, await response.text())
  const id = (await response.json()).user.id
  // Saving returns to the list, which reports the new account.
  await page.waitForSelector('[data-testid=users-table]')
  assert.equal(new URL(page.url()).pathname, '/users')
  assert.ok(
    (await page.$eval('[data-testid=users-table]', (table) => table.textContent)).includes(
      operatorEmail,
    ),
  )
  // The edit page is addressable too, and survives a refresh.
  await page.goto(`http://127.0.0.1:${webPort}/users/${id}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid=user-form]')
  assert.equal(await page.$eval('#user-email', (input) => input.value), operatorEmail)
  assert.equal(
    await page.$eval('[data-testid=stage-title] h1', (h1) => h1.textContent),
    'Edit user',
  )
  // The other admin menu is its own address.
  await page.goto(`http://127.0.0.1:${webPort}/inventory/aircraft`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid=admin-inventory]')
  assert.equal(
    await page.$eval('[data-testid=inventory-tab-aircraft]', (a) => a.getAttribute('aria-current')),
    'page',
  )
  // Verify assigned permissions round trip from server.
  const created = await page.evaluate(async (id) => {
    const data = await (await fetch('/api/users')).json()
    return data.users.find((u) => u.id === id)
  }, id)
  assert.deepEqual(created.dronePermissions.alpha, ['drones.view', 'telemetry.view'])
  // Sign out and sign in with the password the admin set: it works as it is, with no change
  // forced and no form in the way.
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }))
  await page.reload({ waitUntil: 'networkidle2' })
  await page.type('input[type=email]', operatorEmail)
  await page.type('input[type=password]', 'temporary-password-123')
  await page.click('button[type=submit]')
  await page.waitForSelector('[data-testid=app]')
  await page.waitForSelector('[data-testid=aircraft]')
  assert.equal(await page.$('input[name=current]'), null, 'no password change is forced')
  const rows = await page.$$eval('[data-testid=aircraft]', (nodes) =>
    nodes.map((n) => n.textContent),
  )
  assert.equal(rows.length, 1)
  assert.ok(rows[0].includes('alpha'))
  assert.ok(!rows.join('').includes('bravo'))
  for (const view of ['users', 'inventory', 'wall']) {
    assert.equal(await page.$(`[data-view=${view}]`), null, `no ${view} menu for a scoped user`)
  }
  // Gated paths: a deep link to a screen this account cannot use lands on the map instead.
  for (const path of ['/users', '/users/new', '/inventory/controllers', '/live']) {
    await page.goto(`http://127.0.0.1:${webPort}${path}`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid=aircraft]')
    assert.equal(new URL(page.url()).pathname, '/', `${path} redirects to the map`)
    assert.equal(await page.$('[data-testid=users]'), null)
    assert.equal(await page.$('[data-testid=admin-inventory]'), null)
  }
  await page.screenshot({ path: `${screenshots}/scoped.png`, fullPage: true })

  // Changing the password later is the user's own choice. It must be real: afterwards the
  // new password is the one that works and the old one is gone.
  const changed = await page.evaluate(
    async () =>
      (
        await fetch('/api/auth/password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            currentPassword: 'temporary-password-123',
            newPassword: 'new-operator-password',
          }),
        })
      ).status,
  )
  assert.equal(changed, 200, 'a user can change their own password')
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }))
  await page.reload({ waitUntil: 'networkidle2' })
  const stale = await page.evaluate(
    async (email) =>
      (
        await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'temporary-password-123' }),
        })
      ).status,
    operatorEmail,
  )
  assert.equal(stale, 401, 'the old password must stop working')
  await page.type('input[type=email]', operatorEmail)
  await page.type('input[type=password]', 'new-operator-password')
  await page.click('button[type=submit]')
  await page.waitForSelector('[data-testid=aircraft]')
  assert.equal(
    await page.$$eval('[data-testid=aircraft]', (nodes) => nodes.length),
    1,
    'the new password signs in, still scoped to one aircraft',
  )
  // A user can also rename their own sign-in: it needs the password, and the new address works.
  const renamed = await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((response) => response.status)
    return {
      wrongPassword: await post('/api/auth/email', {
        currentPassword: 'not-the-password',
        email: 'renamed-operator@example.com',
      }),
      changed: await post('/api/auth/email', {
        currentPassword: 'new-operator-password',
        email: 'renamed-operator@example.com',
      }),
    }
  })
  assert.equal(renamed.wrongPassword, 400, 'the password is required')
  assert.equal(renamed.changed, 200, 'a user can change their own sign-in email')
  const signIns = await page.evaluate(async (oldEmail) => {
    const login = (email) =>
      fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'new-operator-password' }),
      }).then((response) => response.status)
    return { old: await login(oldEmail), renamed: await login('renamed-operator@example.com') }
  }, operatorEmail)
  assert.equal(signIns.old, 401, 'the old address no longer signs in')
  assert.equal(signIns.renamed, 200, 'the new address signs in')
  assert.deepEqual(errors, [])
  console.log(
    'Browser checks passed: user creation, per-drone permissions, sign-in with the admin-set password (no forced change), a voluntary password change (new password works, old one does not), changing your own sign-in email, scoped fleet and hidden unauthorized navigation, addressable admin screens and gated deep links.',
  )
} finally {
  await browser?.close()
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue
    if (process.platform === 'win32') child.kill()
    else {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* already stopped */
      }
    }
  }
}
