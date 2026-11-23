import { useEffect, useState } from 'react'
import { withBase } from '../base'
import { brand } from '../branding'
import { useRecordings } from '../recorder'
import Button from '../ui/Button'

const CHECK_EVERY_MS = 5 * 60_000

/**
 * Tells a tab that was opened before a deploy that a newer version is ready. It only offers:
 * reloading by itself could cut a recording or a live view short.
 */
export default function UpdateNotice() {
  const [stale, setStale] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const recording = useRecordings((state) => Object.keys(state.sessions).length > 0)

  useEffect(() => {
    // `npm run dev` has no version file, and a dev build never counts as stale.
    if (__BUILD_ID__ === 'dev') return undefined
    let stopped = false
    const check = async () => {
      try {
        const response = await fetch(withBase('/version.json'), { cache: 'no-store' })
        if (!response.ok) return
        const latest = (await response.json()) as { id?: string }
        if (!stopped && latest.id && latest.id !== __BUILD_ID__) setStale(true)
      } catch {
        // Offline or mid-deploy: the next check tries again.
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    void check()
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (!stale || dismissed) return null
  return (
    <div
      className="dark-shell fixed bottom-4 left-1/2 z-[90] flex w-[min(520px,calc(100vw-32px))] items-center gap-3 rounded-lg border border-dark-line bg-dark-surface px-4 py-3 text-[12.5px] text-dark-text [box-shadow:var(--shadow-float)] [transform:translateX(-50%)]"
      role="status"
      data-testid="update-notice"
    >
      <span className="min-w-0 flex-1 leading-[1.5]">
        A new version of {brand.name} is ready.
        {recording && ' A recording is running: stop it before you reload.'}
      </span>
      <Button variant="darkGold" onClick={() => window.location.reload()}>
        Reload
      </Button>
      <Button variant="dark" onClick={() => setDismissed(true)} aria-label="Remind me later">
        Later
      </Button>
    </div>
  )
}
