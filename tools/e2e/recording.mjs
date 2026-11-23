import puppeteer from 'puppeteer-core'

// Local recording: hover Rec on a wall tile, keep recording through tile → focus, stop from
// the focus view, and check the saved file plays. The folder picker is a native dialog, so
// the page's own private storage stands in for the folder the operator would choose.

const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const demoEmail = process.env.DEMO_EMAIL ?? 'admin@example.com'
const demoPassword = process.env.DEMO_PASSWORD ?? 'admin12345'
const chromeArgs = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--autoplay-policy=no-user-gesture-required',
]
if (process.env.IGNORE_CERT_ERRORS === '1') chromeArgs.push('--ignore-certificate-errors')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function check(condition, message) {
  if (!condition) throw new Error(message)
  console.log(message)
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: chromeArgs })

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
  page.setDefaultNavigationTimeout(60_000)
  page.on('pageerror', (error) => console.log('PAGE EXCEPTION:', error.message))
  const whepOffers = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/whep$/.test(request.url())) whepOffers.push(request.url())
  })

  await page.goto(baseUrl, { waitUntil: 'networkidle2' })
  await page.waitForSelector('input[type=password]', { timeout: 15_000 })
  await page.type('input[type=email]', demoEmail)
  await page.type('input[type=password]', demoPassword)
  await Promise.all([
    page.click('button[type=submit]'),
    page.waitForSelector('[data-testid="aircraft"]', { timeout: 30_000 }),
  ])

  await page.goto(`${baseUrl}/live`, { waitUntil: 'networkidle2' })
  // After the navigation: a page load would drop the stand-in picker.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('e2e-recordings', { create: true })
    for await (const [name] of dir.entries()) await dir.removeEntry(name)
    window.showDirectoryPicker = async () => dir
  })
  await page.waitForFunction(
    () => {
      const video = document.querySelector('[data-testid="tile"] video')
      return video && video.readyState >= 2 && video.videoWidth > 0
    },
    { timeout: 60_000 },
  )
  const tile = '[data-testid="tile"]:has(video)'
  await page.hover(tile)
  // The control fades in, so read it once the transition has finished.
  await sleep(500)
  const shown = await page.$eval(`${tile} [data-testid="tile-record"]`, (button) =>
    Number(getComputedStyle(button).opacity),
  )
  check(shown === 1, 'Rec shows on hover')

  const offersBefore = whepOffers.length
  await page.click(`${tile} [data-testid="tile-record"]`)
  await page.waitForSelector(`${tile} [data-testid="tile-record"][data-recording="true"]`, {
    timeout: 10_000,
  })
  check(true, 'recording started from the tile')
  await sleep(3000)

  await page.click(`${tile} [data-testid="tile-open"]`)
  await page.waitForSelector('[data-testid="focus-record"][data-recording="true"]', {
    timeout: 10_000,
  })
  check(true, 'recording kept running in the focus view')
  await sleep(3000)
  check(
    whepOffers.length === offersBefore,
    `recording and focus opened no new media session (${whepOffers.length - offersBefore})`,
  )

  // Until the file is closed, Chrome keeps the data in a `.crswap` file beside it.
  await page.click('[data-testid="focus-record"]')
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('[data-testid="focus"] [role="status"]')).some(
        (element) => element.textContent?.includes('Recording saved'),
      ),
    { timeout: 15_000 },
  )
  check(true, 'focus view reported the saved file')

  const files = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('e2e-recordings')
    const found = []
    for await (const [name, handle] of dir.entries()) {
      const file = await handle.getFile()
      const url = URL.createObjectURL(file)
      const video = document.createElement('video')
      video.muted = true
      video.src = url
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve
        video.onerror = () => reject(new Error(`${name} does not play`))
      })
      found.push({ name, bytes: file.size, seconds: video.duration, width: video.videoWidth })
      URL.revokeObjectURL(url)
    }
    return found
  })
  check(files.length === 1, `one file saved: ${files.map((file) => file.name).join(', ')}`)
  const [file] = files
  check(
    /^DRONE-FLEET_.+_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.(mp4|webm)$/.test(file.name),
    'file is named DRONE-FLEET_<name>_<date>_<time>',
  )
  check(
    file.width > 0 && file.seconds >= 4,
    `file plays: ${file.width} px wide, ${file.seconds.toFixed(1)} s`,
  )
  console.log('recording check passed')
} finally {
  await browser.close()
}
