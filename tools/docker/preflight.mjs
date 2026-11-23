#!/usr/bin/env node
/**
 * Fail-fast checks before starting a Docker stack.
 *
 *   node tools/docker/preflight.mjs --dev
 *   node tools/docker/preflight.mjs --prod [--strict] [--skip-ports]
 *
 * --prod reads infra/.env.production by default. Set PROD_ENV_FILE to override.
 * --strict also treats missing DJI credentials as an error.
 * --skip-ports skips host port probes (useful for local smoke tests).
 */
import { execFileSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const infra = join(root, 'infra')
const mode = process.argv.includes('--prod')
  ? 'prod'
  : process.argv.includes('--dev')
    ? 'dev'
    : null
const strict = process.argv.includes('--strict')
const skipPorts = process.argv.includes('--skip-ports') || process.env.PREFLIGHT_SKIP_PORTS === '1'

if (!mode) {
  console.error('usage: node tools/docker/preflight.mjs --dev|--prod [--strict]')
  process.exit(2)
}

const errors = []
const warnings = []

function error(message) {
  errors.push(message)
}

function warn(message) {
  warnings.push(message)
}

function requireFile(path, label) {
  if (!existsSync(path)) {
    error(`${label} is missing: ${path}`)
    return false
  }
  if (statSync(path).size === 0) {
    error(`${label} is empty: ${path}`)
    return false
  }
  return true
}

function parseEnvFile(path) {
  const values = {}
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
  }
  return values
}

function requireValue(env, key) {
  if (!env[key] || env[key].trim() === '') error(`${key} is empty or missing`)
}

function checkDocker() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' })
  } catch {
    error('Docker is not available or the daemon is not running (docker info failed)')
    return
  }
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' })
  } catch {
    error('docker compose is not available')
  }
}

function checkTcp(port) {
  return new Promise((resolve) => {
    const server = createServer()
    let settled = false
    const finish = (message) => {
      if (settled) return
      settled = true
      if (!server.listening) resolve(message)
      else server.close(() => resolve(message))
    }
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') finish(`port ${port}/tcp is already in use`)
      else finish(null) // EACCES or an environment limitation: do not block.
    })
    server.once('listening', () => finish(null))
    server.listen({ host: '127.0.0.1', port })
  })
}

function checkUdp(port) {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    let settled = false
    const finish = (message) => {
      if (settled) return
      settled = true
      try {
        socket.close(() => resolve(message))
      } catch {
        resolve(message)
      }
    }
    socket.once('error', (err) => {
      if (err.code === 'EADDRINUSE') finish(`port ${port}/udp is already in use`)
      else finish(null)
    })
    socket.once('listening', () => finish(null))
    socket.bind({ address: '127.0.0.1', port })
  })
}

async function checkPorts(ports) {
  if (skipPorts) return
  for (const [port, protocol] of ports) {
    const problem = protocol === 'udp' ? await checkUdp(port) : await checkTcp(port)
    if (problem) error(problem)
  }
}

async function preflightDev() {
  requireFile(join(infra, 'docker-compose.dev.yml'), 'dev compose file')
  requireFile(join(infra, 'docker', 'Dockerfile.dev'), 'dev Dockerfile')
  requireFile(join(infra, 'emqx', 'emqx.dev.conf'), 'dev EMQX config')
  requireFile(join(infra, 'srs', 'srs.dev.conf'), 'dev SRS config')

  const ports = [
    [Number(process.env.DEV_WEB_PORT ?? 5174), 'tcp'],
    [Number(process.env.DEV_API_PORT ?? 3001), 'tcp'],
    [Number(process.env.DEV_MQTT_PORT ?? 1884), 'tcp'],
    [Number(process.env.DEV_RTMP_PORT ?? 1936), 'tcp'],
    [Number(process.env.DEV_SRS_HTTP_PORT ?? 1986), 'tcp'],
    [Number(process.env.DEV_SRS_FLV_PORT ?? 8081), 'tcp'],
    [8000, 'udp'],
  ]
  await checkPorts(ports)
}

async function preflightProd() {
  const envPath = process.env.PROD_ENV_FILE ?? join(infra, '.env.production')
  if (!requireFile(envPath, 'production env file')) return

  const env = parseEnvFile(envPath)
  const required = [
    'APP_DOMAIN',
    'PUBLIC_IP',
    'POSTGRES_PASSWORD',
    'JWT_SECRET',
    'EMQX_NODE_COOKIE',
    'PUBLIC_HOST',
    'MQTT_PUBLIC_HOST',
    'MQTT_USERNAME',
    'MQTT_PASSWORD',
    'MEDIA_RTMP_HOST',
    'MEDIA_WHEP_INTERNAL_TEMPLATE',
  ]
  for (const key of required) requireValue(env, key)

  const placeholders = new Map([
    ['APP_DOMAIN', ['app.example.com']],
    ['PUBLIC_IP', ['203.0.113.10']],
    ['POSTGRES_PASSWORD', ['change-me', 'dji']],
    ['JWT_SECRET', ['change-me-to-32-random-bytes', 'dev-secret-change-me']],
    ['EMQX_NODE_COOKIE', ['change-me-emqx-cookie', 'emqxsecretcookie']],
    ['MQTT_PASSWORD', ['change-me-server', 'dji-server']],
  ])
  for (const [key, values] of placeholders) {
    if (values.includes(env[key])) error(`${key} still has the example value`)
  }

  if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
    error('JWT_SECRET must be at least 32 characters')
  }
  if (env.EMQX_NODE_COOKIE && env.EMQX_NODE_COOKIE.length < 16) {
    error('EMQX_NODE_COOKIE must be at least 16 characters')
  }
  if (env.POSTGRES_PASSWORD && /[@:/?]/.test(env.POSTGRES_PASSWORD)) {
    error('POSTGRES_PASSWORD must not contain @ : / or ? (it is embedded in DATABASE_URL)')
  }
  if (env.MEDIA_WHEP_INTERNAL_TEMPLATE) {
    if (!/^https?:\/\/srs:1985\//.test(env.MEDIA_WHEP_INTERNAL_TEMPLATE)) {
      error('MEDIA_WHEP_INTERNAL_TEMPLATE must point at srs:1985 (the internal SRS service)')
    }
    if (!env.MEDIA_WHEP_INTERNAL_TEMPLATE.includes('{key}')) {
      error('MEDIA_WHEP_INTERNAL_TEMPLATE must contain a {key} placeholder')
    }
  }
  if (env.MEDIA_WEBRTC_TEMPLATE) {
    warn('MEDIA_WEBRTC_TEMPLATE is no longer used; remove it from .env.production')
  }
  if (env.MEDIA_PLAY_HOST) {
    warn('MEDIA_PLAY_HOST is no longer used; remove it from .env.production')
  }
  if (env.CORS_ORIGINS) {
    error('CORS_ORIGINS must be empty in production (same-origin deployment)')
  }
  if (env.PUBLIC_HOST && /^(localhost|127\.0\.0\.1)$/.test(env.PUBLIC_HOST)) {
    warn('PUBLIC_HOST is localhost; production sessions will not use Secure cookies')
  }
  if (env.MQTT_PUBLIC_HOST && !env.MQTT_PUBLIC_HOST.endsWith(':8883')) {
    warn('MQTT_PUBLIC_HOST does not end in :8883; Pilot 2 will use the configured port')
  }
  if (env.MEDIA_RTMP_HOST && /^(localhost|127\.0\.0\.1):/.test(env.MEDIA_RTMP_HOST)) {
    warn('MEDIA_RTMP_HOST points at localhost; a controller will not reach it')
  }

  // The host folder mounted into the API container as /storage: where a Developer can keep videos on a
  // big disk or a NAS. Docker would create a missing folder as root, on the system disk, so check it.
  const storageDir = env.STORAGE_HOST_DIR || '/srv/drone-fleet-storage'
  if (!isAbsolute(storageDir)) {
    error(
      `STORAGE_HOST_DIR must be an absolute path (for example /srv/drone-fleet-storage), not ${storageDir}`,
    )
  } else if (!existsSync(storageDir)) {
    warn(
      `STORAGE_HOST_DIR ${storageDir} does not exist yet: Docker will create it on the system disk. Create it, or mount the big disk there, before starting if videos should live elsewhere`,
    )
  } else if (!statSync(storageDir).isDirectory()) {
    error(`STORAGE_HOST_DIR ${storageDir} is not a folder`)
  }

  const certDir = env.CERT_DIR
    ? isAbsolute(env.CERT_DIR)
      ? env.CERT_DIR
      : resolve(infra, env.CERT_DIR)
    : join(infra, 'certs')
  requireFile(join(certDir, 'fullchain.pem'), 'TLS certificate (fullchain.pem)')
  requireFile(join(certDir, 'privkey.pem'), 'TLS private key (privkey.pem)')

  const djiKeys = ['DJI_APP_ID', 'DJI_APP_KEY', 'DJI_APP_LICENSE']
  const missingDji = djiKeys.filter((key) => !env[key])
  if (missingDji.length > 0) {
    const message = `missing DJI credentials: ${missingDji.join(', ')}; Pilot 2 licence checks will fail`
    if (strict) error(message)
    else warn(`${message} (pass --strict to make this an error)`)
  }

  // Ports below 1024 are skipped: a non-root preflight cannot bind them even though
  // Docker can. Check the remaining public ports and the WebRTC UDP port.
  const rtmpPort = Number(env.SRS_RTMP_PORT) || 1935
  const rtmpsPort = Number(env.RTMPS_PORT) || 1936
  const webrtcPort = Number(env.SRS_WEBRTC_PORT) || 8000
  await checkPorts([
    [8883, 'tcp'],
    [rtmpPort, 'tcp'],
    [rtmpsPort, 'tcp'],
    [webrtcPort, 'udp'],
  ])
  warn('ports 80/443 are not probed (privileged); verify they are free before deployment')
}

async function main() {
  console.log(`Preflight (${mode}${strict ? ', strict' : ''}) using ${root}`)
  checkDocker()
  if (mode === 'dev') await preflightDev()
  else await preflightProd()

  for (const message of warnings) console.log(`  warning: ${message}`)
  for (const message of errors) console.error(`  error: ${message}`)

  if (errors.length > 0) {
    console.error(`Preflight failed with ${errors.length} error(s).`)
    process.exit(1)
  }
  console.log('Preflight passed.')
}

void main()
