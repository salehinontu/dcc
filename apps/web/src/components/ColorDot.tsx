import { cn } from '../ui/cn'

/** An aircraft's colour as a small round chip. The colour is data, so it is set inline. */
export default function ColorDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block size-[10px] flex-none rounded-[50%] [box-shadow:0_0_0_1px_rgba(8,24,56,0.18)]',
        className,
      )}
      style={{ background: color }}
      aria-hidden="true"
    />
  )
}
