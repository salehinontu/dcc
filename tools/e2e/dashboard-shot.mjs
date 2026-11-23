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

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: chromeArgs,
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
  page.setDefaultNavigationTimeout(60_000)

  page.on('pageerror', (error) => console.log('PAGE EXCEPTION:', error.message))

  await page.goto(baseUrl, { waitUntil: 'networkidle2' })
  await page.waitForSelector('input[type=password]', { timeout: 15_000 })
  await page.screenshot({ path: `${out}/login.png` })
  console.log('login screenshot saved')

  await page.type('input[type=email]', demoEmail)
  await page.type('input[type=password]', demoPassword)
  await Promise.all([
    page.click('button[type=submit]'),
    page.waitForSelector('[data-testid="aircraft"]', { timeout: 30_000 }),
  ])

  // Rename the first aircraft, then find it by name.
  await page.hover('[data-testid="aircraft"]')
  await page.click('[data-testid="aircraft"] [data-testid="aircraft-rename"]')
  await page.waitForSelector('[data-testid="aircraft-edit-input"]', { timeout: 10_000 })
  await page.focus('[data-testid="aircraft-edit-input"]')
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.type('[data-testid="aircraft-edit-input"]', 'Alpha One')
  await page.keyboard.press('Enter')

  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('[data-testid="aircraft-name"]')).some(
        (element) => element.textContent === 'Alpha One',
      ),
    { timeout: 10_000 },
  )
  console.log('rename ok')

  await page.type('[data-testid="fleet-search-input"]', 'Alpha')
  await new Promise((resolve) => setTimeout(resolve, 500))
  const searchCount = await page.$$eval('[data-testid="aircraft"]', (items) => items.length)
  console.log('SEARCH RESULTS:', searchCount)
  await page.screenshot({ path: `${out}/search.png` })
  await page.click('[data-testid="search-clear"]')

  await new Promise((resolve) => setTimeout(resolve, 7000))
  await page.screenshot({ path: `${out}/dashboard.png` })
  console.log('dashboard screenshot saved')

  // Live wall: every online aircraft should start streaming on its own.
  await page.click('[data-view="wall"]')
  await page.waitForSelector('[data-testid="tile"]', { timeout: 20_000 })
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[data-testid="live-pill"]')).some(
          (badge) => badge.textContent.trim() === 'Live',
        ),
      { timeout: 45_000 },
    )
    .catch(() => console.log('no tile reached live'))

  await new Promise((resolve) => setTimeout(resolve, 5000))
  await page.screenshot({ path: `${out}/wall.png` })

  const wall = await page.$$eval('[data-testid="tile"]', (tiles) =>
    tiles.map((tile) => ({
      badge: tile.querySelector('[data-testid="live-pill"]')?.textContent,
      video: Boolean(tile.querySelector('video')),
    })),
  )
  console.log('WALL:', JSON.stringify(wall))

  // Full screen from the first tile.
  await page.click('[data-testid="tile-open"]')
  await page.waitForSelector('[data-testid="focus"]', { timeout: 10_000 })
  await new Promise((resolve) => setTimeout(resolve, 5000))
  await page.screenshot({ path: `${out}/focus.png` })

  const focus = await page
    .$eval('[data-testid="focus"] video', (element) => ({
      readyState: element.readyState,
      width: element.videoWidth,
    }))
    .catch(() => null)
  console.log('FOCUS VIDEO:', JSON.stringify(focus))
  console.log('focus screenshot saved')
} finally {
  await browser.close()
}
