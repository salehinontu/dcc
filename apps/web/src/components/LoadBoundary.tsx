import { Component, type ReactNode } from 'react'
import BrandLockup from '../ui/BrandLockup'
import Button from '../ui/Button'

const RELOADED = 'drone-fleet-chunk-reload'

/** A script or stylesheet of the app that could not be fetched: almost always a tab older than the last update. */
function isLoadFailure(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /dynamically imported module|Importing a module script failed|error loading dynamically|ChunkLoadError|Unable to preload CSS/i.test(
    text,
  )
}

/**
 * Around a part of the app that loads on demand (the dashboard, the controller page). After an update the old file
 * names are gone from the server, so a tab opened before it cannot fetch them: the page reloads once by itself (nothing
 * is lost at that point, nothing has opened yet), and if that does not help it says so instead of showing a blank page.
 */
export default class LoadBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; message: string }
> {
  override state = { failed: false, message: '' }

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, message: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown) {
    if (!isLoadFailure(error)) return
    try {
      if (sessionStorage.getItem(RELOADED)) return
      sessionStorage.setItem(RELOADED, '1')
    } catch {
      return
    }
    window.location.reload()
  }

  override componentDidMount() {
    // Loaded fine: a later failure may reload once again.
    try {
      sessionStorage.removeItem(RELOADED)
    } catch {
      /* private mode: nothing to clear */
    }
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="grid h-full place-items-center bg-paper px-5 py-8" data-testid="load-failed">
        <div className="grid max-w-[420px] justify-items-center gap-4 text-center">
          <BrandLockup variant="notFound" />
          <h1 className="m-0 text-[20px] font-semibold">This page could not finish loading</h1>
          <p className="m-0 text-[13px] leading-[1.55] text-ink-3">
            The system was probably updated while this tab was open, or the connection dropped.
            Reload to get the current version.
          </p>
          <Button variant="submit" type="button" onClick={() => window.location.reload()}>
            Reload
          </Button>
          <p className="m-0 font-mono text-[10.5px] text-ink-3">
            {this.state.message.slice(0, 160)}
          </p>
        </div>
      </main>
    )
  }
}
