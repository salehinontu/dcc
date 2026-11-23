import { brand } from '../branding'
import Logo from '../components/Logo'
import { cn } from './cn'

type Variant = 'login' | 'notFound' | 'boot' | 'rail'

const config: Record<
  Variant,
  { wrapper: string; mark: string; text: string; name: string; sub: string }
> = {
  login: {
    wrapper: 'flex items-center gap-[16px] until-stack:gap-[12px]',
    mark: 'block size-[clamp(68px,6.6vw,100px)] shrink-0 until-stack:size-[56px]',
    text: 'block border-l-2 border-l-gold pl-[16px] until-stack:pl-[12px]',
    name: 'block text-[clamp(30px,3.6vw,52px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink until-stack:text-[26px]',
    sub: 'mt-1.5 block font-mono text-[10.5px] font-semibold uppercase leading-[1.4] tracking-[0.12em] text-pine until-stack:text-[8.5px]',
  },
  notFound: {
    wrapper: 'flex items-center gap-[10px]',
    mark: 'grid size-[42px] shrink-0 place-items-center rounded-[50%] bg-white [box-shadow:var(--shadow-brand)]',
    text: '',
    name: 'block text-[12.5px] font-bold uppercase tracking-[0.06em] leading-[1.25] text-ink',
    sub: 'mt-px block max-w-[200px] font-mono text-[9px] uppercase leading-[1.3] tracking-[0.08em] text-ink-3',
  },
  boot: {
    wrapper: 'flex items-center gap-[9px] text-[14px] font-semibold tracking-[-0.015em]',
    mark: 'grid size-[42px] shrink-0 place-items-center rounded-[50%] bg-white [box-shadow:var(--shadow-brand)]',
    text: '',
    name: 'text-[14px] font-semibold tracking-[-0.015em] text-ink',
    sub: '',
  },
  rail: {
    wrapper: 'flex items-center gap-[10px]',
    mark: 'grid size-[38px] shrink-0 place-items-center rounded-[50%] bg-white [box-shadow:var(--shadow-brand)]',
    text: '',
    name: 'block text-[12px] font-bold uppercase leading-[1.25] tracking-[0.06em] text-ink',
    sub: 'mt-px block max-w-[200px] font-mono text-[8.5px] font-semibold uppercase leading-[1.3] tracking-[0.08em] text-pine',
  },
}

export default function BrandLockup({
  variant = 'login',
  name = brand.name,
  sub = brand.subtitle,
  className,
}: {
  variant?: Variant
  name?: string
  sub?: string
  className?: string
}) {
  const styles = config[variant]
  return (
    <div className={cn(styles.wrapper, className)}>
      <span className={styles.mark}>
        <Logo />
      </span>
      {styles.sub ? (
        <span className={styles.text}>
          <span className={styles.name}>{name}</span>
          <span className={styles.sub}>{sub}</span>
        </span>
      ) : (
        <span className={styles.name}>{name}</span>
      )}
    </div>
  )
}
