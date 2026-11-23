import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Starts MediaMTX for local video testing. The binary is downloaded into .data/mediamtx by
 * run.sh (or manually, see README); tools/media/mediamtx is the legacy location. If it is
 * missing, this process stays alive so the rest of `pnpm dev` keeps running (video stays at
 * "starting").
 *
 * The config is rendered into .data/mediamtx/runtime.yml first so the on-publish hooks can
 * use the platform's curl: `curl.exe` only exists on Windows, and host mode must reach
 * "live" on Linux and macOS too.
 */
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const name = process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx'
const binary = [join(root, '.data', 'mediamtx', name), join(here, 'mediamtx', name)].find(
  (candidate) => existsSync(candidate),
)

if (!binary) {
  console.log('[media] MediaMTX not installed — video is disabled. See README.')
  setInterval(() => undefined, 1 << 30)
} else {
  const runtimeDir = join(root, '.data', 'mediamtx')
  mkdirSync(runtimeDir, { recursive: true })

  const template = readFileSync(join(here, 'mediamtx.yml'), 'utf8')
  const platformTemplate =
    process.platform === 'win32' ? template : template.replaceAll('curl.exe', 'curl')
  const config = platformTemplate.replaceAll(
    'http://127.0.0.1:3000/',
    `http://127.0.0.1:${process.env.PORT ?? 3000}/`,
  )
  const runtime = join(runtimeDir, 'runtime.yml')
  writeFileSync(runtime, config)

  const child = spawn(binary, [runtime], { stdio: 'inherit' })

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })

  const stop = () => child.kill()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
