import { cn } from './cn'

export default function Spinner({
  tone = 'dark',
  className,
}: {
  tone?: 'dark' | 'light'
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'block size-[17px] animate-spin rounded-[50%] border-2',
        tone === 'dark'
          ? 'border-[var(--spinner-track-dark)] border-t-dark-pine'
          : 'border-[var(--spinner-track-light)] border-t-pine',
        className,
      )}
    />
  )
}
