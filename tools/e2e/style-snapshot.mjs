import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

/**
 * Style-parity harness for the Tailwind migration.
 *
 *   node tools/e2e/style-snapshot.mjs write [outDir]
 *   node tools/e2e/style-snapshot.mjs compare [baselineDir] [currentDir]
 *
 * `write` records computed styles, custom properties, a normalized CSSOM dump and
 * screenshots for every screen. `compare` records a fresh run and diffs it against the
 * baseline. Run it against the same host Chrome as the baseline; the project has no CI
 * browser/visual job.
 *
 * PARITY_SCOPE=quick limits the widths to the four design widths (390/820/1024/1600) and
 * skips the breakpoint-boundary screens. The default is the full matrix.
 */

const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const email = process.env.DEMO_EMAIL ?? 'admin@example.com'
const password = process.env.DEMO_PASSWORD ?? 'admin12345'
// The Pilot page only accepts a pilot-role account, and the controller it reports must be
// enrolled and approved in the target database (docs/deployment.md §8).
const pilotEmail = process.env.PILOT_EMAIL ?? 'pilot@example.com'
const pilotPassword = process.env.PILOT_PASSWORD ?? 'pilot-e2e-pass'
const quick = process.env.PARITY_SCOPE === 'quick'
const mode = process.argv[2] ?? 'write'
const baselineDir = process.argv[3] ?? '.data/style-snapshots/baseline'
const outDir =
  mode === 'compare' ? (process.argv[4] ?? '.data/style-snapshots/current') : baselineDir
const screensDir = join(outDir, 'screens')

const chromeArgs = ['--no-sandbox', '--disable-dev-shm-usage']
if (process.env.IGNORE_CERT_ERRORS === '1') chromeArgs.push('--ignore-certificate-errors')

mkdirSync(screensDir, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const STYLE_PROPS = [
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'box-sizing',
  'overflow',
  'overflow-x',
  'overflow-y',
  'z-index',
  'opacity',
  'transform',
  'translate',
  'scale',
  'rotate',
  'transform-origin',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'align-items',
  'align-self',
  'justify-content',
  'justify-self',
  'grid-template-columns',
  'grid-template-rows',
  'grid-auto-flow',
  'gap',
  'row-gap',
  'column-gap',
  'order',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'color',
  'background-color',
  'background-image',
  'background-clip',
  'background-size',
  'background-position',
  'background-repeat',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'box-shadow',
  'outline-width',
  'outline-style',
  'outline-color',
  'outline-offset',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-align',
  'text-decoration-line',
  'white-space',
  'text-overflow',
  'word-break',
  'filter',
  'backdrop-filter',
  'mask-image',
  'mix-blend-mode',
  'visibility',
  'pointer-events',
  'cursor',
  'user-select',
  'touch-action',
]

const PSEUDO_PROPS = [
  'content',
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'width',
  'height',
  'background-color',
  'background-image',
  'background-clip',
  'color',
  'border-width',
  'border-style',
  'border-color',
  'border-radius',
  'box-shadow',
  'opacity',
  'transform',
  'filter',
  'mask-image',
  'z-index',
]

const VOLATILE_DYNAMIC = new Set([
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'flex-basis',
  'grid-template-columns',
  'grid-template-rows',
  'top',
  'right',
  'bottom',
  'left',
  'transform',
  'translate',
  'scale',
  'rotate',
  'transform-origin',
])

// Elements whose colour is driven by live telemetry/stream state (battery level,
// online/offline, stream phase). Their layout is still compared; their state colours and
// opacity are reviewed in the screenshots instead.
const STATEFUL_PARITY = [
  /^parity:battery-fill-/,
  /^parity:tile-live-/,
  /^parity:rail-link$/,
  /^parity:detail-status$/,
  /^parity:aircraft-dot-/,
  /^parity:aircraft-[^-]+$/,
  /^parity:focus-placeholder$/,
]

const STATE_PROPS = new Set([
  'color',
  'background-color',
  'background-image',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'box-shadow',
  'backdrop-filter',
  'opacity',
])

function isStateful(key) {
  return STATEFUL_PARITY.some((pattern) => pattern.test(key))
}

/* ------------------------------------------------------------------ page plumbing */

function launch() {
  return puppeteer.launch({ executablePath: chrome, headless: true, args: chromeArgs })
}

async function newPage(browser) {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  page.setDefaultNavigationTimeout(60_000)
  page.on('pageerror', (error) => console.log('PAGE EXCEPTION:', error.message))
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
  return { context, page }
}

async function login(page, path = '/', waitFor = '.aircraft, [data-testid="aircraft"]') {
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('input[type=password]', { timeout: 20_000 })
  await page.type('input[type=email]', email)
  await page.type('input[type=password]', password)
  await Promise.all([
    page.click('button[type=submit]'),
    page.waitForSelector(waitFor, { timeout: 30_000 }),
  ])
}

async function freeze(page) {
  await page.evaluate(() => document.fonts.ready.then(() => true))
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.id = 'parity-freeze'
    style.textContent = `*, *::before, *::after {
      animation: none !important;
      transition: none !important;
      caret-color: transparent !important;
    }
    ::-webkit-scrollbar { display: none !important; }`
    document.head.appendChild(style)
    document.getAnimations().forEach((animation) => animation.cancel())
  })
  await sleep(200)
}

async function capture(page, name, { dynamic = false } = {}) {
  await freeze(page)
  const data = await page.evaluate(
    ({ styleProps, pseudoProps }) => {
      function pathOf(element) {
        if (element === document.documentElement) return 'html'
        if (element === document.body) return 'body'
        const parts = []
        let node = element
        while (node && node !== document.body && node !== document.documentElement) {
          const parent = node.parentElement
          if (!parent) break
          const index = Array.from(parent.children).indexOf(node) + 1
          parts.unshift(`${node.tagName.toLowerCase()}:${index}`)
          node = parent
        }
        return parts.join('/')
      }

      function styleObject(style, props) {
        const result = {}
        for (const prop of props) result[prop] = style.getPropertyValue(prop)
        return result
      }

      const elements = []
      const seen = new Map()
      const nodes = [
        document.documentElement,
        document.body,
        ...document.body.querySelectorAll('*'),
      ]
      for (const element of nodes) {
        if (element.id === 'parity-freeze' || element.hasAttribute('data-parity-mask')) continue
        if (['STYLE', 'SCRIPT', 'LINK', 'META', 'TITLE'].includes(element.tagName)) continue

        const base = element.dataset.parity
          ? `parity:${element.dataset.parity}`
          : `path:${pathOf(element)}`
        const count = seen.get(base) ?? 0
        seen.set(base, count + 1)
        const key = count === 0 ? base : `${base}#${count}`

        const rect = element.getBoundingClientRect()
        const computed = getComputedStyle(element)
        const pseudos = {}
        for (const pseudo of ['::before', '::after']) {
          const pseudoStyle = getComputedStyle(element, pseudo)
          const content = pseudoStyle.getPropertyValue('content')
          if (content && content !== 'none' && content !== 'normal') {
            pseudos[pseudo] = styleObject(pseudoStyle, pseudoProps)
          }
        }

        elements.push({
          key,
          tag: element.tagName.toLowerCase(),
          text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80),
          rect: {
            x: Number(rect.x.toFixed(1)),
            y: Number(rect.y.toFixed(1)),
            width: Number(rect.width.toFixed(1)),
            height: Number(rect.height.toFixed(1)),
          },
          styles: styleObject(computed, styleProps),
          pseudos,
        })
      }

      const customProps = {}
      const rootStyle = getComputedStyle(document.documentElement)
      for (let index = 0; index < rootStyle.length; index += 1) {
        const prop = rootStyle[index]
        if (prop.startsWith('--')) customProps[prop] = rootStyle.getPropertyValue(prop).trim()
      }

      return {
        elements,
        customProps,
        fonts: {
          sans: document.fonts.check('16px "Instrument Sans"'),
          mono: document.fonts.check('16px "IBM Plex Mono"'),
        },
      }
    },
    { styleProps: STYLE_PROPS, pseudoProps: PSEUDO_PROPS },
  )

  const cssom = await page.evaluate(() => {
    const rules = new Map()

    function add(key, declaration) {
      if (!rules.has(key)) rules.set(key, new Set())
      rules.get(key).add(declaration)
    }

    function walk(list, context) {
      for (const rule of list) {
        const kind = rule.constructor?.name ?? ''
        if (kind === 'CSSStyleRule') {
          const selector = rule.selectorText
          const media = context.media
          const supports = context.supports
          const condition = [media, supports].filter(Boolean).join(' && ')
          add(`${condition}||${selector}`, rule.style.cssText)
        } else if (kind === 'CSSMediaRule') {
          walk(rule.cssRules, { ...context, media: rule.media.mediaText })
        } else if (kind === 'CSSSupportsRule') {
          walk(rule.cssRules, {
            ...context,
            supports: `@supports ${rule.conditionText}`,
          })
        } else if (kind === 'CSSLayerBlockRule') {
          walk(rule.cssRules, context)
        } else if (kind === 'CSSKeyframesRule') {
          add(`@keyframes ${rule.name}`, rule.cssText)
        } else if (kind === 'CSSPropertyRule') {
          add(`@property ${rule.name}`, rule.cssText)
        } else if (kind === 'CSSFontFaceRule') {
          add('@font-face', rule.cssText)
        } else if (kind === 'CSSLayerStatementRule') {
          // layer order does not affect declarations
        } else if (rule.cssRules) {
          walk(rule.cssRules, context)
        }
      }
    }

    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode?.id === 'parity-freeze') continue
      try {
        walk(sheet.cssRules, { media: '', supports: '' })
      } catch {
        // cross-origin stylesheet (Google Fonts)
      }
    }

    return Object.fromEntries(
      Array.from(rules, ([key, value]) => [key, Array.from(value).sort()]).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    )
  })

  const record = { name, dynamic, ...data, cssom }
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(record))

  await maskDynamic(page)
  await page.screenshot({ path: join(screensDir, `${name}.png`) })
  await page.evaluate(() =>
    document.querySelectorAll('[data-parity-mask]').forEach((element) => element.remove()),
  )

  console.log(`captured ${name}${dynamic ? ' (dynamic)' : ''}`)
}

async function maskDynamic(page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('canvas.maplibregl-canvas, video')) {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const mask = document.createElement('div')
      mask.setAttribute('data-parity-mask', '')
      mask.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;background:#000;z-index:2147483647;pointer-events:none`
      document.body.appendChild(mask)
    }
  })
}

/* ------------------------------------------------------------------ screens */

const designWidths = [
  [390, 844],
  [820, 900],
  [1024, 900],
  [1600, 1000],
]

const boundaryWidths = quick
  ? []
  : [
      419, 420, 421, 519, 520, 521, 559, 560, 561, 759, 760, 761, 899, 900, 901, 1099, 1100, 1101,
      1239, 1240, 1241,
    ].map((width) => [width, 900])

async function captureLogin(browser) {
  const { context, page } = await newPage(browser)
  try {
    for (const [width, height] of [...designWidths, ...boundaryWidths]) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 })
      await page.goto(baseUrl, { waitUntil: 'networkidle2' })
      await page.waitForSelector('input[type=password]', { timeout: 20_000 })
      await page.evaluate(() => document.fonts.ready.then(() => true))
      await capture(page, `login-${width}x${height}`)
    }
  } finally {
    await context.close()
  }
}

async function captureNotFound(browser) {
  const { context, page } = await newPage(browser)
  try {
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
    await login(page, '/no-such-page', '.not-found-panel, [data-testid="not-found"]')
    await capture(page, 'not-found-1280x900')
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/no-such-page`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('.not-found-panel, [data-testid="not-found"]', { timeout: 20_000 })
    await capture(page, 'not-found-390x844')
  } finally {
    await context.close()
  }
}

async function capturePilot(browser) {
  for (const [width, height] of [[520, 900], ...(quick ? [] : [[900, 600]])]) {
    const { context, page } = await newPage(browser)
    try {
      await page.setViewport({ width, height, deviceScaleFactor: 1 })
      await page.evaluateOnNewDocument(() => {
        const calls = []
        window.__bridgeCalls = calls
        window.djiBridge = {
          platformVerifyLicense: () => JSON.stringify({ code: 0, data: true }),
          platformIsVerified: () => JSON.stringify({ code: 0, data: true }),
          platformLoadComponent: (name, params) => {
            calls.push([name, params])
            if (name === 'thing') setTimeout(() => window.connectCallback?.(true), 150)
            return JSON.stringify({ code: 0, data: '' })
          },
          apiSetToken: () => JSON.stringify({ code: 0, data: '' }),
          platformSetWorkspaceId: () => JSON.stringify({ code: 0, data: '' }),
          platformSetInformation: () => JSON.stringify({ code: 0, data: '' }),
          platformGetRemoteControllerSN: () => JSON.stringify({ code: 0, data: '1ZTESTRC0000001' }),
        }
      })
      await page.goto(`${baseUrl}/pilot`, { waitUntil: 'networkidle2' })
      await page.waitForSelector(
        '.pilot-form input[type=password], [data-testid="pilot-form"] input[type=password]',
        {
          timeout: 20_000,
        },
      )
      await capture(page, `pilot-setup-${width}x${height}`)

      await page.type(
        '.pilot-form input[type=email], [data-testid="pilot-form"] input[type=email]',
        pilotEmail,
      )
      await page.type(
        '.pilot-form input[type=password], [data-testid="pilot-form"] input[type=password]',
        pilotPassword,
      )
      await Promise.all([
        page.click(
          '.pilot-form button[type=submit], [data-testid="pilot-form"] button[type=submit]',
        ),
        page.waitForSelector('.pilot-connected, [data-testid="pilot-connected"]', {
          timeout: 30_000,
        }),
      ])
      await capture(page, `pilot-connected-${width}x${height}`, { dynamic: true })
    } finally {
      await context.close()
    }
  }
}

async function captureDashboard(browser) {
  const { context, page } = await newPage(browser)
  try {
    await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
    await login(page)
    const widths = quick ? [1600] : [1600, 899, 900, 901, 759, 760, 761]
    for (const width of widths) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 })
      await page.goto(baseUrl, { waitUntil: 'networkidle2' })
      await page.waitForSelector('.aircraft, [data-testid="aircraft"]', { timeout: 30_000 })
      await sleep(4_000)
      await capture(page, `map-${width}x900`, { dynamic: true })

      if (width <= 900) {
        await page.click('.mobile-fleet-btn, [data-testid="mobile-fleet"]')
        await sleep(300)
      }
      await page.click('[data-view="wall"]')
      await page.waitForSelector('.tile, [data-testid="tile"]', { timeout: 30_000 })
      await page
        .waitForFunction(
          () =>
            Array.from(document.querySelectorAll('.live-pill, [data-testid="live-pill"]')).some(
              (badge) => badge.textContent?.trim() === 'Live',
            ),
          { timeout: 45_000 },
        )
        .catch(() => console.log('wall did not reach Live in time'))
      await sleep(1_500)
      await capture(page, `wall-${width}x900`, { dynamic: true })

      if (width === 1600) {
        await page.click('.tile-open, [data-testid="tile-open"]')
        await page.waitForSelector('.focus-screen, [data-testid="focus"]', { timeout: 20_000 })
        await page
          .waitForFunction(
            () => {
              const video = document.querySelector(
                '.focus-screen video, [data-testid="focus"] video',
              )
              return Boolean(video && video.videoWidth > 0)
            },
            { timeout: 30_000 },
          )
          .catch(() => console.log('focus video did not decode in time'))
        await sleep(1_000)
        await capture(page, 'focus-1600x900', { dynamic: true })
        await page.click('.focus-back, [data-testid="focus-back"]')
        await page.waitForFunction(
          () => !document.querySelector('.focus-screen, [data-testid="focus"]'),
          { timeout: 20_000 },
        )
      }
    }
  } finally {
    await context.close()
  }
}

/* ------------------------------------------------------------------ compare */

function normalizePx(value) {
  return value.replace(/(-?\d+(?:\.\d+)?)px/g, (_, number) => {
    return `${Math.round(Number(number) * 10) / 10}px`
  })
}

function compareStyleMaps(file, key, baseline, current, dynamic) {
  const failures = []
  const props = new Set([...Object.keys(baseline), ...Object.keys(current)])
  const stateful = dynamic && isStateful(key)
  for (const prop of props) {
    if (dynamic && VOLATILE_DYNAMIC.has(prop)) continue
    if (stateful && STATE_PROPS.has(prop)) continue
    // An invisible outline (style: none) has browser-dependent width/colour values.
    if (
      (prop === 'outline-width' || prop === 'outline-color') &&
      baseline['outline-style'] === 'none' &&
      current['outline-style'] === 'none'
    ) {
      continue
    }
    const before = baseline[prop]
    const after = current[prop]
    if (before !== after && normalizePx(before) !== normalizePx(after)) {
      failures.push(`${file} ${key} ${prop}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    }
  }
  return failures
}

function compareRecords(file, baseline, current) {
  const failures = []
  const dynamic = Boolean(baseline.dynamic)

  if (baseline.fonts.sans !== current.fonts.sans || baseline.fonts.mono !== current.fonts.mono) {
    failures.push(
      `${file} fonts: ${JSON.stringify(baseline.fonts)} -> ${JSON.stringify(current.fonts)}`,
    )
  }

  for (const [key, before] of Object.entries(baseline.customProps)) {
    // Tailwind prunes unused theme variables (for example --radius-full once no utility
    // uses rounded-full). Those are generated helpers, not design tokens.
    if (key === '--radius-full') continue
    const after = current.customProps[key]
    if (before !== after) {
      failures.push(`${file} var(${key}): ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    }
  }

  // CSSOM selector coverage was the Stage 0 gate. Once components start replacing their
  // legacy classes with utilities, removed utility selectors disappear by design, so the
  // computed-style comparison is the value gate. The cssom records stay in the JSON for
  // reference and manual inspection.

  const currentElements = new Map(current.elements.map((element) => [element.key, element]))
  const baselineKeys = new Set(baseline.elements.map((element) => element.key))
  for (const before of baseline.elements) {
    // DOM paths shift when a stream changes between starting/live inside a tile. Dynamic
    // screens are compared through their stable data-parity anchors; static screens use
    // the full DOM path.
    if (dynamic && !before.key.startsWith('parity:')) continue
    const after = currentElements.get(before.key)
    if (!after) {
      if (!dynamic) failures.push(`${file} element missing: ${before.key}`)
      else console.warn(`WARN ${file} parity element missing: ${before.key}`)
      continue
    }
    failures.push(...compareStyleMaps(file, before.key, before.styles, after.styles, dynamic))
    for (const pseudo of ['::before', '::after']) {
      const beforePseudo = before.pseudos[pseudo]
      const afterPseudo = after.pseudos[pseudo]
      if (beforePseudo && afterPseudo) {
        failures.push(
          ...compareStyleMaps(file, `${before.key}${pseudo}`, beforePseudo, afterPseudo, dynamic),
        )
      } else if (Boolean(beforePseudo) !== Boolean(afterPseudo)) {
        failures.push(`${file} ${before.key}${pseudo}: presence changed`)
      }
    }
    if (!dynamic) {
      for (const side of ['x', 'y', 'width', 'height']) {
        if (Math.abs(before.rect[side] - after.rect[side]) > 0.5) {
          failures.push(
            `${file} ${before.key} rect.${side}: ${before.rect[side]} -> ${after.rect[side]}`,
          )
        }
      }
    }
  }
  for (const element of current.elements) {
    if (baselineKeys.has(element.key)) continue
    if (dynamic) {
      if (element.key.startsWith('parity:')) {
        console.warn(`WARN ${file} parity element added: ${element.key}`)
      }
    } else {
      failures.push(`${file} element added: ${element.key}`)
    }
  }
  return failures
}

function compareDirs() {
  const baselineFiles = readdirSync(baselineDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
  if (baselineFiles.length === 0) {
    console.error(`no baseline records in ${baselineDir}`)
    process.exitCode = 1
    return
  }
  let failures = 0
  for (const file of baselineFiles) {
    const baseline = JSON.parse(readFileSync(join(baselineDir, file), 'utf8'))
    let current
    try {
      current = JSON.parse(readFileSync(join(outDir, file), 'utf8'))
    } catch {
      console.error(`FAIL ${file}: current record missing`)
      failures += 1
      continue
    }
    const diffs = compareRecords(file, baseline, current)
    for (const diff of diffs.slice(0, 40)) console.error(`FAIL ${diff}`)
    if (diffs.length > 40) console.error(`... ${diffs.length - 40} more in ${file}`)
    failures += diffs.length
  }
  if (failures > 0) {
    console.error(`\n${failures} style difference(s) against ${baselineDir}`)
    process.exitCode = 1
  } else {
    console.log(`\nStyle parity OK against ${baselineDir}`)
  }
}

/* ------------------------------------------------------------------ main */

const browser = await launch()
try {
  await captureLogin(browser)
  await captureNotFound(browser)
  await capturePilot(browser)
  await captureDashboard(browser)
} finally {
  await browser.close()
}

if (mode === 'compare') {
  compareDirs()
} else if (mode !== 'write') {
  console.error(`unknown mode "${mode}" (use write or compare)`)
  process.exitCode = 1
}
