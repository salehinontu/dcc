import type { HTMLAttributes } from 'react'
import { cn } from './cn'

export type BadgeTone = 'ok' | 'pending' | 'danger' | 'neutral'

const tones: Record<BadgeTone, string> = {
  ok: 'border-line-soft bg-pine-wash text-pine-strong',
  pending: 'border-warn-edge bg-warn-soft text-warn-text',
  danger: 'border-danger-edge bg-live-soft text-danger-text',
  neutral: 'border-line bg-surface-2 text-ink-2',
}

/** A status chip for light admin surfaces (account status, enrolment status). */
export default function Badge({
  tone = 'neutral',
  className,
  ...props
}: { tone?: BadgeTone } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] leading-[1.45]',
        tones[tone],
        className,
      )}
      {...props}
    />
  )
}
