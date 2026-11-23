import { existsSync } from 'node:fs'

/**
 * The admin inventory: controllers by status, and aircraft in active / disabled / deleted.
 *
 * Drives the real page, because the point of this feature is that an admin can *see* state
 * the fleet rail hides. Against a running stack:
 *
 *   BASE_URL=http://localhost:5173 node tools/e2e/admin-inventory.mjs
 *
 * Needs an admin account and a controller the API knows about. Everything it changes it puts
 * back, and the aircraft it disables must already exist in the target database.
 */
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@example.com'
const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin12345'
const aircraftSn = process.env.INVENTORY_AIRCRAFT_SN ?? '1ZSIMDRN000000001'

const chrome =
  process.env.CHROME_PATH ??
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((path) =>
    existsSync(path),
  )
if (!chrome) throw new Error('Chrome not found; set CHROME_PATH')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const puppeteer = (await import('puppeteer-core')).default
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.setDefaultTimeout(20_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto(baseUrl, { waitUntil: 'networkidle2' })
  await page.type('input[type=email]', adminEmail)
  await page.type('input[type=password]', adminPassword)
  await page.click('button[type=submit]')
  await page.waitForSelector('[data-testid=app]')

  // The inventory is its own menu, separate from users, with an address per tab.
  await page.click('[data-view=inventory]')
  await page.waitForSelector('[data-testid=admin-inventory]')
  check(
    'the menu opens the controllers tab',
    new URL(page.url()).pathname === '/inventory/controllers',
    page.url(),
  )

  // 1. Controller registry: every controller, not just the pending ones.
  await page.waitForSelector('[data-testid=controller-row]')
  const controllers = await page.$$eval('[data-testid=controller-row]', (rows) =>
    rows.map((row) => ({
      cells: [...row.querySelectorAll('td')].map((td) => td.textContent.trim()),
      status: row.querySelector('span[class*=rounded-full]')?.textContent.trim(),
    })),
  )
  check('controller registry lists rows', controllers.length > 0, `${controllers.length} rows`)
  check(
    'registry shows more than pending controllers',
    controllers.some((row) => row.status === 'approved'),
    controllers.map((r) => r.status).join(', '),
  )
  check(
    'each row shows its aircraft',
    controllers.every((row) => row.cells.length === 6),
  )

  // 2. Aircraft tab: active and disabled are distinguishable.
  await page.click('[data-testid=inventory-tab-aircraft]')
  await page.waitForSelector('[data-testid=aircraft-active]')
  check(
    'the aircraft tab has its own address',
    new URL(page.url()).pathname === '/inventory/aircraft',
    page.url(),
  )
  const activeBefore = await page.$$eval(
    '[data-testid=aircraft-active] [data-testid=aircraft-row]',
    (rows) => rows.map((row) => row.textContent),
  )
  check('active aircraft are listed', activeBefore.length > 0, `${activeBefore.length} rows`)

  // 3. Disable one, and confirm it moves sections.
  const disabled = await page.evaluate(async (sn) => {
    const response = await fetch(`/api/devices/${sn}/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    return response.status
  }, aircraftSn)
  check('disabling an aircraft succeeds', disabled === 200, `HTTP ${disabled}`)
  // The toggle must be idempotent: a second disable is a no-op, not a 404.
  const again = await page.evaluate(async (sn) => {
    const response = await fetch(`/api/devices/${sn}/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    return response.status
  }, aircraftSn)
  check('disabling twice is a no-op, not an error', again === 200, `HTTP ${again}`)
  await page.waitForSelector('[data-testid=aircraft-disabled]')
  const disabledRows = await page.$$eval(
    '[data-testid=aircraft-disabled] [data-testid=aircraft-row]',
    (rows) => rows.map((row) => row.textContent),
  )
  check(
    'the disabled aircraft moves to the Disabled section',
    disabledRows.some((row) => row.includes(aircraftSn)),
  )
  // A refresh stays on the same tab, and the disabled aircraft is still listed there.
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid=aircraft-disabled]')
  check(
    'a refresh stays on the aircraft tab',
    new URL(page.url()).pathname === '/inventory/aircraft',
    page.url(),
  )
  const goneFromFleet = await page.evaluate(async (sn) => {
    const data = await (await fetch('/api/devices')).json()
    return !data.devices.some((device) => device.sn === sn)
  }, aircraftSn)
  check('a disabled aircraft is hidden from the fleet view', goneFromFleet)

  // 4. Re-enable restores it, with no controller involved.
  const enabled = await page.evaluate(async (sn) => {
    const response = await fetch(`/api/devices/${sn}/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    return response.status
  }, aircraftSn)
  check('re-enabling succeeds', enabled === 200, `HTTP ${enabled}`)
  const back = await page.evaluate(async (sn) => {
    const data = await (await fetch('/api/devices')).json()
    return data.devices.some((device) => device.sn === sn)
  }, aircraftSn)
  check('the aircraft is back in the fleet', back)

  check('no page exceptions', errors.length === 0, errors.join('; '))
} finally {
  await browser.close().catch(() => undefined)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll admin inventory checks passed')
