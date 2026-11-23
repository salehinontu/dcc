import type { HTMLAttributes } from 'react'
import { cn } from './cn'

export type StatusTone = 'live' | 'pending' | 'error' | 'idle'

const dots: Record<StatusTone, string> = {
  live: 'bg-dark-live [box-shadow:0_0_0_2px_var(--pill-live-ring)]',
  pending: 'bg-[var(--pill-pending-dot)] [box-shadow:0_0_0_2px_var(--pill-pending-ring)]',
  error: 'bg-dark-live [box-shadow:0_0_0_2px_var(--pill-live-ring)]',
  idle: 'bg-dark-faint',
}

export default function StatusPill({
  tone = 'live',
  label,
  className,
  ...rest
}: {
  tone?: StatusTone
  label: string
  className?: string
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      className={cn(
        'pointer-events-none inline-flex h-[21px] items-center gap-1.5 rounded-[3px] border border-[var(--pill-border)] bg-[var(--pill-bg)] px-[7px] font-mono text-[8px] uppercase tracking-[0.11em] backdrop-blur-[8px]',
        tone === 'pending' ? 'text-[var(--pill-pending-text)]' : 'text-[var(--pill-text)]',
        className,
      )}
    >
      <span className={cn('size-[5px] rounded-[50%]', dots[tone])} aria-hidden="true" />
      {label}
    </span>
  )
}
