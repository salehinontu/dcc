import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

/**
 * Two independent browser sessions watch the same fleet:
 *  - both see video for the same stream id,
 *  - one viewer leaving or navigating away does not restart or stop the other,
 *  - focusing a feed opens a second WHEP session for the same stream without restarting,
 *  - a hard-closed tab releases only its own watches,
 *  - no stream key or media URL ever reaches a browser.
 */

const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const out = process.env.SCREENSHOT_DIR ?? 'docs/screenshots'
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const email = process.env.DEMO_EMAIL ?? 'admin@example.com'
const password = process.env.DEMO_PASSWORD ?? 'admin12345'
const chromeArgs = ['--no-sandbox', '--disable-dev-shm-usage']
if (process.env.IGNORE_CERT_ERRORS === '1') chromeArgs.push('--ignore-certificate-errors')

mkdirSync(out, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function watchForLeaks(page, frames, responses) {
  // Puppeteer has no page-level WebSocket frame event; record frames from inside the page.
  await page.evaluateOnNewDocument(() => {
    const Native = window.WebSocket
    window.__fleetWsFrames = []
    class RecordingWebSocket extends Native {
      constructor(...args) {
        super(...args)
        this.addEventListener('message', (event) => {
          window.__fleetWsFrames.push(
            typeof event.data === 'string' ? event.data : '[binary frame]',
          )
        })
      }
    }
    window.WebSocket = RecordingWebSocket
  })

  page.on('response', (response) => {
    const type = response.headers()['content-type'] ?? ''
    if (!type.includes('application/json')) return
    responses.push(response.text().catch(() => ''))
  })
}

async function drainFrames(page, frames) {
  const captured = await page.evaluate(() => window.__fleetWsFrames ?? [])
  frames.push(...captured)
}

async function login(page) {
  await page.goto(baseUrl, { waitUntil: 'networkidle2' })
  await page.waitForSelector('input[type=password]', { timeout: 15_000 })
  await page.type('input[type=email]', email)
  await page.type('input[type=password]', password)
  await Promise.all([
    page.click('button[type=submit]'),
    page.waitForSelector('[data-testid="aircraft"]', { timeout: 30_000 }),
  ])
}

async function openWall(page) {
  await page.click('[data-view="wall"]')
  await page.waitForSelector('[data-testid="tile"]', { timeout: 20_000 })
}

async function waitForDecodedVideo(page, selector, timeout = 60_000) {
  await page.waitForFunction(
    (target) => {
      const videos = Array.from(document.querySelectorAll(target))
      return (
        videos.length > 0 && videos.every((video) => video.videoWidth > 0 && video.currentTime > 0)
      )
    },
    { timeout, polling: 200 },
    selector,
  )
}

async function playback(page, selector) {
  return page.$$eval(selector, (videos) =>
    videos.map((video) => ({
      currentTime: video.currentTime,
      width: video.videoWidth,
    })),
  )
}

async function activeStreams(page) {
  const body = await page.evaluate(async () => {
    const response = await fetch('/api/streams', { credentials: 'include' })
    return response.json()
  })
  return body.streams.filter((stream) => stream.phase === 'starting' || stream.phase === 'live')
}

function streamKey(stream) {
  return `${stream.deviceSn}|${stream.videoId}`
}

function activeIds(streams) {
  return streams.map((stream) => `${streamKey(stream)}|${stream.id}`).sort()
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: chromeArgs,
})

const framesA = []
const framesB = []
const responsesA = []
const responsesB = []

try {
  const contextA = await browser.createBrowserContext()
  const contextB = await browser.createBrowserContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()

  for (const page of [pageA, pageB]) {
    page.setDefaultNavigationTimeout(60_000)
    page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
    page.on('pageerror', (error) => console.log('PAGE EXCEPTION:', error.message))
  }
  watchForLeaks(pageA, framesA, responsesA)
  watchForLeaks(pageB, framesB, responsesB)
  await login(pageA)
  await login(pageB)
  await openWall(pageA)
  await openWall(pageB)

  // 1. Both viewers get decoded video for every visible tile.
  await waitForDecodedVideo(pageA, '[data-testid="tile"] video')
  await waitForDecodedVideo(pageB, '[data-testid="tile"] video')
  console.log('both viewers decode video')

  // 2. One active row per (aircraft, video), whatever the number of viewers.
  const active = await activeStreams(pageA)
  assert.ok(active.length > 0, 'expected at least one active stream')
  const counts = new Map()
  for (const stream of active) {
    const key = streamKey(stream)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const [key, count] of counts) {
    assert.equal(count, 1, `duplicate active rows for ${key}`)
  }
  console.log(`one active stream per video: ${counts.size}`)

  const idsBefore = activeIds(active)

  // 3. A switches to the map. B keeps playing and the stream ids do not change.
  await pageA.click('[data-view="map"]')
  await pageA.waitForSelector('[data-testid="map"]', { timeout: 10_000 })

  const beforeSwitch = await playback(pageB, '[data-testid="tile"] video')
  await sleep(10_000)
  const afterSwitch = await playback(pageB, '[data-testid="tile"] video')

  assert.equal(afterSwitch.length, beforeSwitch.length, 'tile count changed for viewer B')
  afterSwitch.forEach((entry, index) => {
    assert.ok(
      entry.currentTime > (beforeSwitch[index]?.currentTime ?? 0),
      'viewer B video stopped advancing while A changed views',
    )
  })
  assert.deepEqual(activeIds(await activeStreams(pageB)), idsBefore, 'stream ids changed')
  console.log('viewer B kept playing while A navigated')

  // 4. A opens a focus view, closes it and reopens it within five seconds. The player
  //    reattaches to the same stream and reaches a frame quickly.
  const focusButton = '[data-testid="open-live"]'
  await pageA.waitForSelector(focusButton, { timeout: 10_000 })

  await pageA.click(focusButton)
  await pageA.waitForSelector('[data-testid="focus"]', { timeout: 10_000 })
  await waitForDecodedVideo(pageA, '[data-testid="focus"] video', 15_000)

  await pageA.click('[data-testid="focus-back"]')
  await pageA.waitForFunction(() => !document.querySelector('[data-testid="focus"]'), {
    timeout: 10_000,
  })
  await sleep(1_000)

  const reopenStart = Date.now()
  await pageA.click(focusButton)
  await pageA.waitForSelector('[data-testid="focus"]', { timeout: 10_000 })
  await waitForDecodedVideo(pageA, '[data-testid="focus"] video', 15_000)
  const reopenMs = Date.now() - reopenStart
  console.log(`focus reopened with video in ${reopenMs} ms`)
  assert.ok(reopenMs < 5_000, `reopened focus took ${reopenMs} ms`)

  await pageA.click('[data-testid="focus-back"]')
  await pageA.waitForFunction(() => !document.querySelector('[data-testid="focus"]'), {
    timeout: 10_000,
  })

  assert.deepEqual(
    activeIds(await activeStreams(pageB)),
    idsBefore,
    'opening focus restarted a stream',
  )
  console.log('tile -> focus did not restart the stream')

  // 5. A hard-closed context releases only A's watches; B still plays.
  const beforeClose = await playback(pageB, '[data-testid="tile"] video')
  await drainFrames(pageA, framesA)
  await contextA.close()
  await sleep(6_000)
  const afterClose = await playback(pageB, '[data-testid="tile"] video')

  assert.equal(afterClose.length, beforeClose.length, 'tile count changed after A closed')
  afterClose.forEach((entry, index) => {
    assert.ok(
      entry.currentTime > (beforeClose[index]?.currentTime ?? 0),
      'viewer B video stopped after A closed',
    )
  })
  const idsAfterClose = activeIds(await activeStreams(pageB))
  assert.deepEqual(idsAfterClose, idsBefore, 'closing A changed the stream ids')
  console.log('viewer B kept playing after A hard-closed')

  await pageB.screenshot({ path: `${out}/multi-viewer-b.png` })
  await drainFrames(pageB, framesB)

  // 6. No browser frame or JSON body may contain a stream key or a media URL.
  assert.ok(framesA.length + framesB.length > 0, 'no WebSocket frames were captured')
  const bodies = await Promise.all([...responsesA, ...responsesB])
  const haystack = [...framesA, ...framesB, ...bodies].join('\n')
  const leaks = [
    { label: 'rtmp://', match: /rtmp:\/\//i },
    { label: 'stream=', match: /stream=/i },
    { label: '/live/', match: /\/live\//i },
    { label: 'stream_key', match: /stream_key/i },
    { label: 'playback', match: /"playback"/i },
  ].filter(({ match }) => match.test(haystack))
  assert.equal(
    leaks.length,
    0,
    `browser payloads leaked: ${leaks.map((leak) => leak.label).join(', ')}`,
  )
  console.log(
    `no stream keys in ${framesA.length + framesB.length} WS frames / ${bodies.length} JSON bodies`,
  )

  console.log('multi-viewer check passed')
} finally {
  await browser.close()
}
