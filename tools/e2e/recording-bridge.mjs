import puppeteer from 'puppeteer-core'

// A recording survives the picture going away. Record a live tile, stop the stream (the wall
// loses its picture, as a dropped link or a reconnect would), start it again, then stop the
// recording: in Chrome the whole stretch is ONE playable file that covers the gap too.
// NO_BRIDGE=1 hides the browser's steady-track API, which is what Safari and Firefox are like:
// then each stretch of picture is its own file, and both must still play.
// The folder picker is a native dialog, so the page's private storage stands in for the folder.

const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const demoEmail = process.env.DEMO_EMAIL ?? 'admin@example.com'
const demoPassword = process.env.DEMO_PASSWORD ?? 'admin12345'
const noBridge = process.env.NO_BRIDGE === '1'
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
  if (noBridge) {
    await page.evaluateOnNewDocument(() => {
      delete window.MediaStreamTrackProcessor
      delete window.MediaStreamTrackGenerator
    })
  }

  await page.goto(baseUrl, { waitUntil: 'networkidle2' })
  await page.waitForSelector('input[type=password]', { timeout: 15_000 })
  await page.type('input[type=email]', demoEmail)
  await page.type('input[type=password]', demoPassword)
  await Promise.all([
    page.click('button[type=submit]'),
    page.waitForSelector('[data-testid="aircraft"]', { timeout: 30_000 }),
  ])

  await page.goto(`${baseUrl}/live`, { waitUntil: 'networkidle2' })
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('e2e-recordings', { create: true })
    for await (const [name] of dir.entries()) await dir.removeEntry(name)
    window.showDirectoryPicker = async () => dir
  })

  const tile = '[data-testid="tile"]:has(video)'
  // The picture is playing when the video's clock moves.
  const playing = (timeout) =>
    page.waitForFunction(
      async (selector) => {
        const video = document.querySelector(`${selector} video`)
        if (!video || video.readyState < 2 || video.videoWidth === 0) return false
        const before = video.currentTime
        await new Promise((resolve) => setTimeout(resolve, 800))
        return video.currentTime > before
      },
      { timeout, polling: 500 },
      tile,
    )
  await playing(60_000)

  const sn = await page.evaluate(async () => {
    const response = await fetch('/api/devices')
    const { devices } = await response.json()
    return devices.find((device) => device.online)?.sn ?? null
  })
  check(Boolean(sn), `an online drone to record: ${sn}`)
  const control = (action) =>
    page.evaluate(
      async (serial, verb) =>
        (await fetch(`/api/devices/${serial}/stream/${verb}`, { method: 'POST' })).status,
      sn,
      action,
    )

  await page.hover(tile)
  await sleep(500)
  await page.click(`${tile} [data-testid="tile-record"]`)
  await page.waitForSelector(`${tile} [data-testid="tile-record"][data-recording="true"]`, {
    timeout: 10_000,
  })
  const startedAt = Date.now()
  check(true, 'recording started')
  await sleep(5000)

  check((await control('stop')) < 300, 'stream stopped: the picture goes away')
  await sleep(6000)
  const stillRecording = await page.evaluate(
    () => document.querySelector('[data-testid="tile-record"]')?.dataset.recording === 'true',
  )
  check(stillRecording || noBridge, 'the recording is still on while the picture is away')

  check((await control('resume')) < 300, 'stream resumed')
  await playing(60_000)
  check(true, 'the picture is back')
  await sleep(5000)

  await page.hover(tile)
  await sleep(300)
  await page.click(`${tile} [data-testid="tile-record"]`)
  await page.waitForFunction(
    () => document.querySelector('[data-testid="tile-record"]')?.dataset.recording !== 'true',
    { timeout: 10_000 },
  )
  const recordedSeconds = (Date.now() - startedAt) / 1000
  await sleep(3000)

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
      found.push({ name, bytes: file.size, seconds: video.duration })
      URL.revokeObjectURL(url)
    }
    return found
  })
  console.log(
    `files: ${files.map((f) => `${f.name} ${f.seconds.toFixed(1)}s`).join(', ')}; recorded ${recordedSeconds.toFixed(1)} s`,
  )
  check(
    files.every((file) => !file.name.endsWith('.crswap')),
    'no unfinished .crswap file is left behind',
  )
  if (noBridge) {
    check(
      files.length >= 2,
      `without the steady track each stretch is its own file (${files.length})`,
    )
  } else {
    check(files.length === 1, `one file for the whole recording (${files.length})`)
    // The gap is part of the file, so it is about as long as the recording was.
    check(
      files[0].seconds >= recordedSeconds * 0.8,
      `the file spans the gap: ${files[0].seconds.toFixed(1)} s of ${recordedSeconds.toFixed(1)} s`,
    )
  }
  console.log('recording bridge check passed')
} finally {
  await browser.close()
}
