import type { ReactNode } from 'react'
import { withBase } from '../base'
import { followLink } from '../routes'
import Icon from './Icon'

/**
 * The glass header above every dashboard screen: the mobile rail toggle, an optional back
 * control, the screen title with its one-line mono summary, and right-aligned actions.
 */
export default function StageBar({
  bar,
  title,
  summary,
  back,
  actions,
  railOpen,
  onOpenRail,
}: {
  bar: string
  title: string
  summary?: ReactNode
  back?: { label: string; to: string }
  actions?: ReactNode
  railOpen: boolean
  onOpenRail: (trigger: HTMLButtonElement) => void
}) {
  return (
    <header
      className="flex h-[var(--bar-h)] flex-none items-center gap-[18px] border-b border-b-line bg-glass-surface px-[22px] backdrop-blur-[14px] backdrop-saturate-[1.2] until-wide-lg:px-[18px] until-drawer:gap-2.5 until-drawer:px-4 until-phone-lg:gap-2 until-phone-lg:px-4"
      data-bar={bar}
      data-parity="stage-bar"
    >
      <button
        className="hidden until-drawer:grid until-drawer:size-[34px] until-drawer:flex-none until-drawer:place-items-center until-drawer:rounded-md until-drawer:border until-drawer:border-line until-drawer:bg-surface-2 until-drawer:text-ink-2 until-drawer:[&_svg]:size-4"
        data-parity="mobile-fleet"
        data-testid="mobile-fleet"
        type="button"
        aria-label="Open fleet panel"
        aria-expanded={railOpen}
        aria-controls="fleet-rail"
        onClick={(event) => onOpenRail(event.currentTarget)}
      >
        <Icon name="menu" />
      </button>

      {back && (
        <a
          className="grid size-[34px] flex-none place-items-center rounded-md border border-line bg-surface-2 text-ink-2 no-underline transition-colors hover:border-pine hover:bg-pine-wash hover:text-pine-strong [&_svg]:size-4"
          href={withBase(back.to)}
          aria-label={back.label}
          title={back.label}
          data-testid="stage-back"
          onClick={(event) => followLink(event, back.to)}
        >
          <Icon name="back" />
        </a>
      )}

      <div className="min-w-0" data-parity="stage-title" data-testid="stage-title">
        <h1 className="m-0 text-[15.5px] font-semibold tracking-[-0.02em] until-phone-lg:text-[14px]">
          {title}
        </h1>
        {summary && (
          <p className="m-0 mt-[3px] overflow-hidden whitespace-nowrap font-mono text-[9.5px] uppercase tracking-[0.04em] text-ink-3 tabular-nums text-ellipsis until-phone-lg:text-[8.5px] until-phone-lg:tracking-[0.02em] until-narrow:hidden">
            {summary}
          </p>
        )}
      </div>

      {actions && (
        <div
          className="ml-auto flex items-center gap-3 until-phone-lg:gap-[7px]"
          data-parity="stage-actions"
        >
          {actions}
        </div>
      )}
    </header>
  )
}
