import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Starts the development stack in dependency order: broker -> API (connected and
 * subscribed) -> media, web and simulator.
 *
 * --core runs broker, API and simulator only. --no-web leaves the dashboard out so it can
 * run in its own terminal (run.bat): broker, API, media and simulator still start here.
 *
 * SIM_ENABLED=0 (shell or .env) starts none of the simulated aircraft: no simulator process and
 * no pre-approved simulator controllers, so the dashboard shows only real hardware.
 *
 * The simulator publishes topology exactly once, when it connects. The API takes longer to
 * open PGlite than the simulator takes to connect, so launching everything at once loses the
 * topology and leaves the dashboard with no aircraft until the simulator reconnects.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const core = process.argv.includes('--core')
const noWeb = process.argv.includes('--no-web')
const windows = process.platform === 'win32'

const envFile = readEnvFile(join(root, '.env'))
const simulator = String(process.env.SIM_ENABLED ?? envFile.SIM_ENABLED ?? '1') !== '0'
const brokerPort = Number(process.env.MQTT_PORT ?? 1883)
const apiPort = Number(process.env.PORT ?? envFile.PORT ?? 3000)

const children = new Map()
let stopping = false

function readEnvFile(path) {
  const values = {}
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // No .env: the defaults above apply.
  }
  return values
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (open) => {
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

async function apiReady() {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`)
  if (!response.ok) return `HTTP ${response.status}`
  const health = await response.json()
  if (!health.ok) return 'ok=false'
  if (!health.mqtt) return 'mqtt=false'
  if (!health.mqttSubscribed) return 'mqttSubscribed=false'
  return true
}

async function waitFor(label, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let detail = ''
  while (Date.now() < deadline) {
    if (stopping) throw new Error('stopped')
    try {
      const result = await check()
      if (result === true) return
      if (typeof result === 'string') detail = result
    } catch (error) {
      detail = error.message
    }
    await delay(250)
  }
  throw new Error(
    `${label} did not become ready within ${timeoutMs / 1000}s${detail ? ` (${detail})` : ''}`,
  )
}

function forward(stream, name) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) console.log(`[${name}] ${line}`)
  })
  stream.on('end', () => {
    if (pending) console.log(`[${name}] ${pending}`)
  })
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return
  if (windows) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

function stop(code) {
  if (stopping) return
  stopping = true
  for (const child of children.values()) killTree(child)
  children.clear()
  setTimeout(() => process.exit(code), 200)
}

function start(name, commandLine, extraEnv = {}) {
  const child = spawn(commandLine, {
    cwd: root,
    shell: true,
    detached: !windows,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  })
  children.set(name, child)

  if (child.stdout) forward(child.stdout, name)
  if (child.stderr) forward(child.stderr, name)

  child.on('error', (error) => {
    if (stopping) return
    console.error(`[dev] ${name} failed to start: ${error.message}`)
    stop(1)
  })

  child.on('exit', (code, signal) => {
    children.delete(name)
    if (stopping) return
    console.error(`[dev] ${name} exited (${signal ?? code}); stopping the stack`)
    stop(code ?? 1)
  })
}

async function main() {
  if (await isPortOpen(brokerPort)) {
    throw new Error(`port ${brokerPort} is already in use — stop the running broker first`)
  }
  if (await isPortOpen(apiPort)) {
    throw new Error(`port ${apiPort} is already in use — stop the running API first`)
  }

  start('broker', 'pnpm --filter @dji/dev-broker dev')
  console.log(`[dev] waiting for the MQTT broker on ${brokerPort}...`)
  await waitFor('MQTT broker', () => isPortOpen(brokerPort), 30_000)
  console.log('[dev] broker ready')

  // The simulator is the only "controller" in host mode, and a controller needs an approved
  // enrolment before its topology is accepted.
  start('api', 'pnpm --filter @dji/api dev', simulator ? { SEED_SIMULATOR: '1' } : {})
  console.log('[dev] waiting for the API and its MQTT subscription...')
  await waitFor('API', apiReady, 120_000)
  console.log('[dev] API ready and subscribed — starting the rest')

  if (!core) start('media', 'node tools/media/start.mjs')
  if (!noWeb) start('web', 'pnpm --filter @dji/web dev')
  if (simulator) start('sim', 'pnpm --filter @dji/simulator dev')
  else console.log('[dev] simulator disabled (SIM_ENABLED=0) — no demo aircraft')
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

main().catch((error) => {
  console.error(`[dev] ${error.message}`)
  stop(1)
})
