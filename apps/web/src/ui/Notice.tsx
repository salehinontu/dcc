import type { ReactNode } from 'react'
import Icon from '../components/Icon'
import { cn } from './cn'

/**
 * Inline feedback banner. `error` is announced as an alert, `success` as a polite status;
 * pass `onDismiss` to let the reader close it.
 */
export default function Notice({
  tone,
  children,
  onDismiss,
  className,
}: {
  tone: 'error' | 'success'
  children: ReactNode
  onDismiss?: () => void
  className?: string
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2.5 text-[12px] leading-[1.5]',
        tone === 'error'
          ? 'border-danger-edge bg-live-soft text-danger-text'
          : 'border-line-soft bg-pine-wash text-pine-strong',
        className,
      )}
    >
      <Icon name={tone === 'error' ? 'alert' : 'check'} className="mt-px size-[15px] flex-none" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</span>
      {onDismiss && (
        <button
          type="button"
          className="-my-1 -mr-1.5 grid size-6 flex-none place-items-center rounded-sm opacity-70 transition-opacity hover:opacity-100 [&_svg]:size-3.5"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <Icon name="x" />
        </button>
      )}
    </div>
  )
}
