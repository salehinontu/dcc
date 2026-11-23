import { useEffect } from 'react'
import { withBase } from '../base'
import { pageTitle } from '../branding'
import Icon from '../components/Icon'
import { ButtonLink } from '../ui/Button'
import BrandLockup from '../ui/BrandLockup'

export default function NotFound() {
  const path = window.location.pathname

  useEffect(() => {
    const previous = document.title
    document.title = pageTitle('Page not found')
    return () => {
      document.title = previous
    }
  }, [])

  return (
    <main className="flex h-full overflow-y-auto bg-transparent px-5 py-8">
      <div className="m-auto flex w-full max-w-[480px] flex-col items-center gap-7">
        <BrandLockup variant="notFound" />

        <section
          className="w-full rounded-lg border border-line bg-surface-2 p-8 [box-shadow:var(--shadow-card)] until-phone:px-5 until-phone:py-6"
          data-testid="not-found"
          aria-labelledby="not-found-title"
        >
          <p className="mb-3 mt-0 font-mono text-[11px] font-medium tracking-[0.16em] text-pine">
            404
          </p>
          <h1
            id="not-found-title"
            className="mb-2.5 mt-0 text-display-2xs font-semibold leading-[1.15] tracking-[-0.025em] text-balance"
          >
            This page doesn't exist.
          </h1>
          <p className="mb-[18px] mt-0 text-[13px] leading-[1.6] text-ink-2 text-pretty">
            The address below isn't part of the operations console. Check the link, or return to the
            map.
          </p>
          <p
            className="mb-6 mt-0 rounded-sm border border-line bg-sunken px-2.5 py-2 font-mono text-[11.5px] tabular-nums text-ink-2 [overflow-wrap:anywhere]"
            data-testid="not-found-path"
            title={path}
          >
            {path}
          </p>
          <ButtonLink variant="primary" data-testid="not-found-action" href={withBase('/')}>
            Back to operations map
            <Icon name="arrowRight" />
          </ButtonLink>
        </section>
      </div>
    </main>
  )
}
