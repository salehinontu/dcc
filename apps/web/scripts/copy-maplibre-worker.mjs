// MapLibre v6 resolves its worker from `import.meta.url` at runtime, so the worker has to
// sit next to the main bundle. Vite cannot see that dynamic URL, so copy it after the build.
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const worker = require.resolve('maplibre-gl/dist/maplibre-gl-worker.mjs')
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/assets')

mkdirSync(out, { recursive: true })
copyFileSync(worker, resolve(out, 'maplibre-gl-worker.mjs'))
