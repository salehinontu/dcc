import { brand } from '../branding'
import { cn } from '../ui/cn'

/** The installation's logo (the built-in mark by default). Sits in a round, white-backed holder. */
export default function Logo({ className }: { className?: string }) {
  return (
    <img
      className={cn('block size-full rounded-[50%] object-contain', className)}
      src={brand.logo}
      alt=""
      width={40}
      height={40}
    />
  )
}
