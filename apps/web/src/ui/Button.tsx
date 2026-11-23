import type { ComponentPropsWithRef } from 'react'
import { cn } from './cn'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'submit'
  | 'mapPrimary'
  | 'pilotSubmit'
  | 'pilotReload'
  | 'dark'
  | 'darkGold'

const base =
  'inline-flex items-center justify-center rounded-md no-underline transition-[background,transform,box-shadow] disabled:cursor-not-allowed'

const variants: Record<ButtonVariant, string> = {
  primary:
    'h-11 gap-2 bg-pine px-[18px] text-[13.5px] font-medium text-white no-underline hover:bg-pine-strong [&_svg]:size-[15px]',
  secondary:
    'h-8 gap-[7px] whitespace-nowrap border border-line-strong bg-surface-2 px-3 text-[11.5px] font-medium text-ink [box-shadow:var(--shadow-btn)] hover:border-pine hover:bg-pine-wash hover:text-pine-strong [&_svg]:size-[14px]',
  submit:
    'h-11 w-full gap-2 bg-gold text-[13.5px] font-semibold tracking-[-0.005em] text-on-gold [box-shadow:var(--shadow-login-submit)] hover:bg-gold-strong hover:[transform:translateY(-1px)] motion-reduce:hover:[transform:none] disabled:cursor-progress disabled:opacity-60',
  mapPrimary:
    'h-[34px] gap-[7px] whitespace-nowrap px-[13px] text-[12px] font-semibold text-white [background-image:linear-gradient(180deg,var(--pine),var(--pine-strong))] [box-shadow:var(--shadow-primary)] hover:[background-image:linear-gradient(180deg,var(--pine-hover),var(--pine-hover-strong))] hover:[box-shadow:var(--shadow-primary-hover)] hover:[transform:translateY(-1px)] motion-reduce:hover:[transform:none] disabled:opacity-[0.45] [&_svg]:size-[15px] until-phone-lg:px-2.5',
  pilotSubmit:
    'mt-5 h-12 w-full gap-2 bg-pine text-[14px] font-medium tracking-[-0.005em] text-white hover:bg-pine-strong disabled:cursor-progress disabled:opacity-60 pointer-fine:until-phone-lg:h-[46px] pointer-coarse:h-[52px] pointer-coarse:text-[15px]',
  pilotReload:
    'h-[46px] gap-[7px] border border-line-strong bg-surface-2 px-3 text-[13px] font-medium text-ink [box-shadow:var(--shadow-btn)] hover:border-pine hover:bg-pine-wash hover:text-pine-strong [&_svg]:size-[14px]',
  dark: 'h-8 gap-1.5 whitespace-nowrap border border-dark-line bg-dark-raised px-[11px] text-[11px] font-medium text-dark-text no-underline hover:border-[var(--dark-btn-hover-border)] hover:bg-[var(--dark-btn-hover-bg)] aria-pressed:border-gold aria-pressed:text-gold disabled:opacity-[0.42] [&_svg]:size-[13px] until-phone-lg:px-2',
  // The one confirming action on a dark surface, such as saving a verified count.
  darkGold:
    'h-8 gap-1.5 whitespace-nowrap border border-gold bg-gold px-[11px] text-[11px] font-semibold text-on-gold no-underline hover:border-gold-strong hover:bg-gold-strong disabled:opacity-[0.42] [&_svg]:size-[13px] until-phone-lg:px-2',
}

export function buttonClass(variant: ButtonVariant, className?: string): string {
  return cn(base, variants[variant], className)
}

export default function Button({
  variant = 'primary',
  className,
  type = 'button',
  ...props
}: ComponentPropsWithRef<'button'> & { variant?: ButtonVariant }) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />
}

export function ButtonLink({
  variant = 'primary',
  className,
  ...props
}: ComponentPropsWithRef<'a'> & { variant?: ButtonVariant }) {
  return <a className={buttonClass(variant, className)} {...props} />
}
