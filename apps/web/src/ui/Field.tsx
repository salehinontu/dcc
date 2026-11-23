import type { ComponentPropsWithRef, ReactNode } from 'react'
import Icon from '../components/Icon'
import { cn } from './cn'

type Tone = 'login' | 'default' | 'pilot'

const labelTones: Record<Tone, string> = {
  login: 'mb-1.5 block text-[11.5px] font-medium text-login-card-ink',
  default: 'mb-1.5 block text-[11.5px] font-medium text-ink-2',
  pilot: 'mb-1.5 block text-[12px] font-medium text-ink-2 pointer-coarse:text-[13px]',
}

export function Field({
  label,
  htmlFor,
  children,
  className,
  tone = 'login',
}: {
  label: string
  htmlFor: string
  children: ReactNode
  className?: string
  tone?: Tone
}) {
  return (
    <div className={cn('block', className)}>
      <label className={labelTones[tone]} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}

const inputTones: Record<Exclude<Tone, 'pilot'>, string> = {
  login:
    'border-login-card-line bg-white text-login-card-ink placeholder:text-login-card-muted hover:border-login-card-line-hover focus:border-danger focus:[box-shadow:0_0_0_3px_var(--login-focus-ring)]',
  default:
    'border-line-strong bg-surface-2 text-ink placeholder:text-ink-3 hover:border-input-hover focus:border-pine focus:[box-shadow:0_0_0_3px_var(--input-focus-ring)]',
}

const inputSizes = {
  default: 'h-11 text-[13.5px]',
  pilot:
    'h-12 text-[14px] pointer-fine:until-phone-lg:h-[46px] pointer-coarse:h-[52px] pointer-coarse:text-[15px]',
}

export function TextInput({
  tone = 'login',
  fieldSize = 'default',
  trailing = false,
  leadingIcon = false,
  invalid = false,
  className,
  ...props
}: ComponentPropsWithRef<'input'> & {
  tone?: Exclude<Tone, 'pilot'>
  fieldSize?: keyof typeof inputSizes
  trailing?: boolean
  leadingIcon?: boolean
  invalid?: boolean
}) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(
        'w-full rounded-md border py-0 outline-none transition-[border-color,box-shadow] focus-visible:outline-none aria-[invalid=true]:border-live aria-[invalid=true]:[box-shadow:0_0_0_3px_var(--live-focus-ring)]',
        inputSizes[fieldSize],
        leadingIcon ? 'pl-[38px] pr-[46px]' : trailing ? 'pl-3 pr-[46px]' : 'px-3',
        inputTones[tone],
        className,
      )}
      {...props}
    />
  )
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-[7px] flex items-start gap-1.5 text-[11.5px] leading-[1.4] text-live">
      <Icon name="alert" className="mt-px size-3.5" />
      <span>{children}</span>
    </p>
  )
}
