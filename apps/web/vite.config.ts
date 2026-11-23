import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import postcssPresetEnv from 'postcss-preset-env'

// DJI RC Plus 2 runs a Chrome 95 WebView. Flatten Tailwind's cascade layers and lower
// modern CSS before serving it to the controller.
//
// `assertNoCascadeLayers` is the safety net: postcss-preset-env is what turns `@layer` into
// specificity-scoped rules, and if that step is ever skipped (a CSS chunk outside the
// pipeline, a config regression, a dependency bump) the controller silently loses the whole
// stylesheet instead of showing a broken-but-visible page. Fail the build instead.
function assertNoCascadeLayers(): Plugin {
  return {
    name: 'assert-no-cascade-layers',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'asset' || !output.fileName.endsWith('.css')) continue
        const css = typeof output.source === 'string' ? output.source : output.source.toString()
        const layers = [...css.matchAll(/@layer\s+([^{;]+)/g)]
          .map((match) => match[1]?.trim())
          .filter((name): name is string => Boolean(name))
        if (layers.length > 0) {
          this.error(
            `${output.fileName} contains cascade layers (${[...new Set(layers)].join(', ')}); ` +
              'the Chrome 95 WebView on the DJI RC Plus 2 would drop the entire stylesheet',
          )
        }
      }
    },
  }
}

// Every build gets an id, baked into the bundle and written to `version.json`. A tab that was
// opened before a deploy compares the two and offers a reload (see `UpdateNotice`), instead of
// running the old interface until someone remembers to refresh.
function emitVersion(id: string): Plugin {
  return {
    name: 'emit-version',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id }) })
    },
  }
}

// The host development flow uses the defaults below. The Docker dev stack overrides
// these targets with service names and binds Vite to 0.0.0.0.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const apiTarget = env.API_PROXY_TARGET ?? 'http://localhost:3000'
  const wsTarget = env.API_WS_TARGET ?? apiTarget.replace(/^http/, 'ws')
  const host = env.VITE_HOST ?? '127.0.0.1'
  const poll = env.VITE_USE_POLLING === '1'
  // Path deployments (for example behind a reverse proxy at /drone-fleet/) set this at
  // build time. Vite rewrites asset URLs and exposes it as import.meta.env.BASE_URL.
  const rawBase = env.VITE_BASE_PATH ?? '/'
  const base = rawBase === '/' ? '/' : `/${rawBase.replace(/^\/+|\/+$/g, '')}/`
  const buildId = mode === 'development' ? 'dev' : Date.now().toString(36)

  return {
    base,
    define: { __BUILD_ID__: JSON.stringify(buildId) },
    plugins: [tailwindcss(), react(), assertNoCascadeLayers(), emitVersion(buildId)],
    // DJI RC Plus 2 runs a Chrome 95 WebView. Flatten Tailwind's cascade layers
    // and lower modern CSS before serving it to the controller.
    css: {
      postcss: {
        plugins: [postcssPresetEnv({ browsers: 'Chrome >= 95', stage: 2 })],
      },
    },
    build: {
      target: 'chrome95',
      cssTarget: 'chrome95',
      // The map library is about half of the bundle and changes once a year; the app changes on every deploy.
      // Apart, a deploy makes a browser fetch only the app's own file again and keep the rest from its cache.
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'maplibre',
                test: /node_modules[/\\]maplibre-gl[/\\].*\.m?js$/,
                priority: 30,
              },
              {
                name: 'react',
                test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                priority: 20,
              },
              { name: 'vendor', test: /node_modules/, priority: 10 },
            ],
          },
        },
      },
    },
    // MapLibre v6 resolves its worker relative to its own module URL. Pre-bundling moves
    // that URL into .vite/deps, where the worker does not exist, so leave it unbundled.
    optimizeDeps: { exclude: ['maplibre-gl'] },
    server: {
      host,
      port: 5173,
      strictPort: true,
      // Docker Desktop bind mounts do not always deliver inotify events; polling keeps
      // HMR working when VITE_USE_POLLING is set.
      ...(poll ? { watch: { usePolling: true, interval: 300 } } : {}),
      // Allow ngrok's forwarding hostnames when demonstrating the dev server remotely.
      allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.io'],
      proxy: {
        // Vite's string shorthand enables changeOrigin, which rewrites Host to the API's
        // address. The API's same-origin guard compares Host with the browser's Origin,
        // so keep the original Host on both the HTTP and WebSocket proxied paths.
        '/api': { target: apiTarget, changeOrigin: false },
        '/ws': { target: wsTarget, ws: true, changeOrigin: false },
        // WHEP playback goes through /api/streams/:id/whep; media signalling is not
        // proxied here, so a browser cannot reach the media server or its stream keys.
      },
    },
  }
})
