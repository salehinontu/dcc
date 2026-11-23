import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const out = process.env.SCREENSHOT_DIR ?? '.data/screenshots'
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const pilotEmail = process.env.PILOT_EMAIL ?? 'pilot@example.com'
const pilotPassword = process.env.PILOT_PASSWORD ?? 'pilot-e2e-pass'
const chromeArgs = ['--no-sandbox', '--disable-dev-shm-usage']
if (process.env.IGNORE_CERT_ERRORS === '1') chromeArgs.push('--ignore-certificate-errors')
mkdirSync(out, { recursive: true })

// The controller serial the fake bridge reports. This serial must already be approved in the
// target database before the run:
//   pnpm --filter @dji/api user:create -- --email pilot@example.com --password pilot-e2e-pass --role pilot
//   pnpm --filter @dji/api controller:approve -- --sn 1ZTESTRC0000001 --by e2e
const CONTROLLER_SN = process.env.PILOT_CONTROLLER_SN ?? '1ZTESTRC0000001'

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: chromeArgs,
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 520, height: 900, deviceScaleFactor: 1 })
  page.setDefaultNavigationTimeout(60_000)

  await page.evaluateOnNewDocument((sn) => {
    const calls = []
    window.__bridgeCalls = calls
    const ok = (name, args) => {
      calls.push({ name, args: args.map((arg) => (typeof arg === 'string' ? arg : String(arg))) })
      return JSON.stringify({ code: 0, data: '' })
    }
    window.djiBridge = {
      platformVerifyLicense: (...args) => ok('platformVerifyLicense', args),
      platformIsVerified: () => {
        calls.push({ name: 'platformIsVerified', args: [] })
        return JSON.stringify({ code: 0, data: true })
      },
      platformLoadComponent: (name, params) => {
        calls.push({ name: 'platformLoadComponent', args: [name, params] })
        if (name === 'thing') setTimeout(() => window.connectCallback?.(true), 150)
        return JSON.stringify({ code: 0, data: '' })
      },
      apiSetToken: (...args) => ok('apiSetToken', args),
      platformSetWorkspaceId: (...args) => ok('platformSetWorkspaceId', args),
      platformSetInformation: (...args) => ok('platformSetInformation', args),
      platformGetRemoteControllerSN: () => {
        calls.push({ name: 'platformGetRemoteControllerSN', args: [] })
        return JSON.stringify({ code: 0, data: sn })
      },
    }
  }, CONTROLLER_SN)

  page.on('pageerror', (error) => console.log('PAGE EXCEPTION:', error.message))

  const requests = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/pilot/')) requests.push(path)
  })

  await page.goto(`${baseUrl}/pilot`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid="pilot-form"] input[type=password]', { timeout: 15_000 })
  await page.type('[data-testid="pilot-form"] input[type=email]', pilotEmail)
  await page.type('[data-testid="pilot-form"] input[type=password]', pilotPassword)

  await Promise.all([
    page.click('[data-testid="pilot-form"] button[type=submit]'),
    page.waitForSelector('[data-testid="pilot-connected"]', { timeout: 20_000 }),
  ])

  await new Promise((resolve) => setTimeout(resolve, 800))
  await page.screenshot({ path: `${out}/pilot.png` })

  const calls = await page.evaluate(() => (window.__bridgeCalls ?? []).map((entry) => entry.name))
  console.log('BRIDGE CALLS:', calls.join(' -> '))
  console.log('PILOT REQUESTS:', requests.join(' -> '))

  // The config is read only after signing in, and the serial only after the licence check.
  assert.deepEqual(requests.slice(0, 4), [
    '/api/pilot/auth',
    '/api/pilot/config',
    '/api/pilot/login',
    '/api/pilot/user-info',
  ])
  assert.ok(
    requests.indexOf('/api/pilot/config') < requests.indexOf('/api/pilot/login'),
    'the config must be fetched before the controller is bound',
  )
  assert.ok(!requests.includes('/api/pilot/bind'), 'the client must not request a bind')

  const verifyAt = calls.indexOf('platformVerifyLicense')
  const serialAt = calls.indexOf('platformGetRemoteControllerSN')
  const apiAt = calls.indexOf('platformLoadComponent')
  assert.ok(
    verifyAt >= 0 && serialAt > verifyAt,
    'the licence is verified before the serial is read',
  )
  assert.ok(apiAt > serialAt, 'components load only after the controller is identified')
  assert.ok(calls.includes('apiSetToken'))

  const thing = await page.evaluate(() => {
    const entry = (window.__bridgeCalls ?? []).find(
      (item) => item.name === 'platformLoadComponent' && item.args[0] === 'thing',
    )
    return entry ? JSON.parse(entry.args[1]) : null
  })
  assert.ok(thing?.username && thing?.password, 'Pilot 2 must receive MQTT credentials')
  console.log('THING PARAMS KEYS:', Object.keys(thing).join(', '))
  console.log('pilot screenshot saved')
} finally {
  await browser.close()
}
