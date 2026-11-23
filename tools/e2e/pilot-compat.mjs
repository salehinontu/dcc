import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 960, height: 600 })
  await page.evaluateOnNewDocument(() => {
    window.djiBridge = {
      platformVerifyLicense: () => JSON.stringify({ code: 0 }),
      platformIsVerified: () => JSON.stringify({ code: 0 }),
      platformGetRemoteControllerSN: () => JSON.stringify({ code: 0, data: 'test-controller' }),
      platformLoadComponent: (name) => {
        if (name === 'thing') setTimeout(() => window.connectCallback(true), 10)
        return JSON.stringify({ code: 0 })
      },
      apiSetToken: () => JSON.stringify({ code: 0 }),
      platformSetWorkspaceId: () => JSON.stringify({ code: 0 }),
      platformSetInformation: () => JSON.stringify({ code: 0 }),
    }
  })
  const seen = []
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/')) seen.push({ path, headers: request.headers() })
    const data = {
      '/api/pilot/auth': { access_token: 'test-preauth' },
      '/api/pilot/config': {
        appId: 'test',
        appKey: 'test',
        license: 'test',
        platformName: 'Test',
        workspaceName: 'Test',
        workspaceId: 'test',
      },
      '/api/pilot/login': {
        access_token: 'test-pilot-token',
        user_id: 'test',
        workspace_id: 'test',
        status: 'approved',
      },
      '/api/pilot/user-info': {
        mqtt_addr: 'tcp://test:1883',
        mqtt_username: 'test',
        mqtt_password: 'test',
        workspace_id: 'test',
      },
    }[path]
    if (data) {
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data }),
      })
    } else if (new URL(request.url()).hostname.endsWith('googleapis.com')) {
      void request.abort()
    } else {
      void request.continue()
    }
  })
  const errors = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error('PAGE ERROR:', error.message)
  })
  await page.goto(`${process.env.BASE_URL ?? 'http://127.0.0.1:4195'}/pilot`)
  await page.waitForSelector('[data-testid="pilot-form"]')
  const styles = await page.$eval('[data-testid="pilot"]', (element) => {
    const style = getComputedStyle(element)
    return {
      display: style.display,
      background: style.backgroundColor,
      direction: style.flexDirection,
    }
  })
  assert.equal(styles.display, 'flex', 'Pilot layout utilities must work in the controller WebView')
  assert.equal(styles.direction, 'column')
  assert.equal(styles.background, 'rgb(242, 246, 252)', 'Pilot theme must render')
  const card = await page.$eval('[data-parity="pilot-card"]', (element) => ({
    width: element.getBoundingClientRect().width,
    border: getComputedStyle(element).borderTopWidth,
  }))
  assert.equal(card.border, '1px')
  assert.ok(card.width <= 880 && card.width > 400, `Unexpected card width: ${card.width}`)
  await page.type('input[type=email]', 'test@example.com')
  await page.type('input[type=password]', 'test-password')
  await page.click('button[type=submit]')
  await page.waitForSelector('[data-testid="pilot-connected"]')

  // The config is only readable with the pre-auth token, and the controller is only bound
  // after the admin-approved login call.
  const configRequest = seen.find((entry) => entry.path === '/api/pilot/config')
  assert.equal(configRequest?.headers.authorization, 'Bearer test-preauth')
  const infoRequest = seen.find((entry) => entry.path === '/api/pilot/user-info')
  assert.equal(infoRequest?.headers.authorization, 'Bearer test-pilot-token')
  assert.equal(
    seen.find((entry) => entry.path === '/api/pilot/bind'),
    undefined,
    'binding must not be requested by the client',
  )
  assert.deepEqual(errors, [])
  console.log(
    'PASS',
    await browser.version(),
    'Pilot styling, connection flow and authenticated binding',
  )
} finally {
  await browser.close()
}
