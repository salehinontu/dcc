import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const out = process.env.SCREENSHOT_DIR ?? '.data/screenshots'
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const demoEmail = process.env.DEMO_EMAIL ?? 'admin@example.com'
const demoPassword = process.env.DEMO_PASSWORD ?? 'admin12345'
const chromeArgs = ['--no-sandbox', '--disable-dev-shm-usage']
if (process.env.IGNORE_CERT_ERRORS === '1') chromeArgs.push('--ignore-certificate-errors')
mkdirSync(out, { recursive: true })

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: chromeArgs,
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
  page.setDefaultNavigationTimeout(60_000)

  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // An unknown path is not a route. Signed out, it falls through to sign-in.
  await page.goto(`${baseUrl}/no-such-page`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid="login-form"]', { timeout: 15_000 })
  check('signed-out unknown path shows sign-in', true)

  await page.type('input[type=email]', demoEmail)
  await page.type('input[type=password]', demoPassword)
  await Promise.all([
    page.click('[data-testid="login-form"] button[type=submit]'),
    page.waitForSelector('[data-testid="not-found"]', { timeout: 20_000 }),
  ])
  check('signing in on an unknown path shows the 404 page', true)

  const pathText = await page.$eval('[data-testid="not-found-path"]', (element) =>
    element.textContent?.trim(),
  )
  check('the attempted path is shown', pathText === '/no-such-page', `got ${pathText}`)

  const title = await page.title()
  check('the document title is updated', title.startsWith('Page not found'), `got "${title}"`)
  await page.screenshot({ path: `${out}/not-found.png` })

  // The primary action is a real navigation back to the map.
  await Promise.all([
    page.click('[data-testid="not-found-action"]'),
    page.waitForSelector('[data-testid="stage-title"] h1', { timeout: 30_000 }),
  ])
  const heading = await page.$eval('[data-testid="stage-title"] h1', (element) =>
    element.textContent?.trim(),
  )
  check('the back action lands on the dashboard', heading === 'Operations', `got "${heading}"`)

  // Every menu has its own address: a deep link (or a refresh) lands on that screen, and the
  // rail marks it as the current page.
  const screens = [
    ['/', 'map', 'Operations'],
    ['/live', 'wall', 'Live wall'],
    ['/screenshots', 'shots', 'Screenshots'],
    ['/users', 'users', 'Users and permissions'],
    ['/users/new', 'users', 'Create user'],
    ['/inventory/controllers', 'inventory', 'Controllers and drones'],
    ['/inventory/aircraft', 'inventory', 'Controllers and drones'],
  ]
  for (const [path, view, expected] of screens) {
    await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="stage-title"] h1', { timeout: 20_000 })
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="stage-title"] h1', { timeout: 20_000 })
    const state = await page.evaluate(() => ({
      heading: document.querySelector('[data-testid="stage-title"] h1')?.textContent?.trim(),
      current: document.querySelector('[data-view][aria-current="page"]')?.dataset.view,
      path: window.location.pathname,
    }))
    check(
      `${path} survives a refresh`,
      state.heading === expected && state.current === view && state.path === path,
      JSON.stringify(state),
    )
  }

  // Menu clicks push history entries, so back and forward move between screens.
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-view="users"]', { timeout: 20_000 })
  await page.click('[data-view="users"]')
  await page.waitForSelector('[data-testid="users-table"]', { timeout: 20_000 })
  await page.click('[data-view="inventory"]')
  await page.waitForSelector('[data-testid="admin-inventory"]', { timeout: 20_000 })
  await page.goBack()
  await page.waitForSelector('[data-testid="users-table"]', { timeout: 20_000 })
  check(
    'back returns to the previous screen',
    new URL(page.url()).pathname === '/users',
    page.url(),
  )
  await page.goForward()
  await page.waitForSelector('[data-testid="admin-inventory"]', { timeout: 20_000 })
  check(
    'forward returns to the next screen',
    new URL(page.url()).pathname === '/inventory/controllers',
    page.url(),
  )

  // Matching stays exact under the new prefixes.
  for (const path of ['/users/new/extra', '/inventory', '/inventory/unknown', '/live/x']) {
    await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="not-found"]', { timeout: 20_000 })
    check(`${path} is not a route`, !(await page.$('[data-testid="app"]')))
  }

  // A signed-in deep link renders the 404 page directly.
  await page.goto(`${baseUrl}/another-missing`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid="not-found"]', { timeout: 20_000 })
  check('a signed-in deep link shows 404', !(await page.$('[data-testid="app"]')))

  // Matching is exact: a nested /pilot suffix is not the pilot route.
  await page.goto(`${baseUrl}/another-missing/pilot`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid="not-found"]', { timeout: 20_000 })
  check('a /pilot suffix is not the pilot route', !(await page.$('[data-testid="pilot"]')))

  // The real pilot route still renders.
  await page.goto(`${baseUrl}/pilot`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid="pilot"]', { timeout: 15_000 })
  check('/pilot renders pilot setup', !(await page.$('[data-testid="app"]')))

  // Phone layout: a long path wraps instead of forcing a horizontal scrollbar.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  await page.goto(`${baseUrl}/no-such-page/and-a-long-missing-segment-0123456789`, {
    waitUntil: 'networkidle2',
  })
  await page.waitForSelector('[data-testid="not-found"]', { timeout: 20_000 })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  check('no horizontal scroll at 390px', overflow <= 0, `${overflow}px`)
  await page.screenshot({ path: `${out}/not-found-mobile.png` })

  // The admin screens fit a phone without horizontal scrolling.
  for (const path of ['/users', '/users/new', '/inventory/controllers', '/inventory/aircraft']) {
    await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="users"], [data-testid="admin-inventory"]', {
      timeout: 20_000,
    })
    const widths = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="users"], [data-testid="admin-inventory"]')
      return {
        page: document.documentElement.scrollWidth - window.innerWidth,
        body: body.scrollWidth - body.clientWidth,
      }
    })
    check(
      `no horizontal scroll on ${path} at 390px`,
      widths.page <= 0 && widths.body <= 0,
      JSON.stringify(widths),
    )
  }

  check('no page exceptions', pageErrors.length === 0, pageErrors.join('; '))
} finally {
  await browser.close()
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll route checks passed')
}
