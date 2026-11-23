/**
 * Class recipes shared by the admin screens (users, controllers, aircraft). They are the
 * same values the screenshot gallery and live wall use, collected so the admin pages cannot
 * drift into a look of their own.
 */

/** The scrolling body under a stage bar. */
export const screenBody =
  'min-h-0 flex-1 overflow-y-auto overscroll-contain px-[22px] pb-[26px] pt-[18px] [scrollbar-color:var(--line-strong)_transparent] [scrollbar-width:thin] until-drawer:p-4 until-stack:px-4 until-stack:pb-[22px] until-stack:pt-3.5'

export const card = 'rounded-lg border border-line bg-white [box-shadow:var(--shadow-card)]'

export const eyebrow = 'font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3'

/** A mono label stacked over a compact control, as in the screenshot filters. */
export const filterLabel =
  'flex flex-col gap-1 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3 until-stack:min-w-0 until-stack:w-full until-stack:flex-1'

export const filterControl =
  'h-8 min-w-[180px] rounded-md border border-line-strong bg-surface-2 px-2.5 font-sans text-[12px] normal-case tracking-normal text-ink outline-none hover:border-input-hover focus:border-pine focus:[box-shadow:0_0_0_3px_var(--input-focus-ring)] until-stack:min-w-0 until-stack:w-full until-stack:flex-1'

export const th =
  'whitespace-nowrap border-b border-line-soft bg-surface-2 px-3.5 py-2.5 text-left font-mono text-[9px] font-normal uppercase tracking-[0.08em] text-ink-3'

export const td = 'border-b border-line-soft px-3.5 py-3 align-middle text-[12.5px]'

/** The gradient foot used under gallery tiles, reused for card headers and footers. */
export const tileFoot =
  '[background-image:linear-gradient(180deg,var(--surface-2),var(--tile-foot-end))]'

/** Dashed empty-state panel, as on the wall and in the gallery. */
export const emptyPanel =
  'grid min-h-[260px] place-items-center rounded-lg border border-dashed border-line-strong bg-[var(--wall-empty-bg)] px-5 py-10 text-center'

/** Pill segmented control, as in the wall's layout picker. */
export function segment(active: boolean): string {
  return [
    'inline-flex h-7 items-center gap-1.5 rounded-[999px] border px-3 text-[12px] font-medium no-underline transition-colors',
    active
      ? 'border-transparent text-white [background-image:linear-gradient(180deg,var(--pine),var(--pine-strong))] [box-shadow:var(--shadow-layout-active)]'
      : 'border-line bg-white text-ink-2 hover:border-pine hover:text-pine-strong',
  ].join(' ')
}

/** A full-width text or number field for dense editor panels. */
export const compactInput =
  'h-9 w-full rounded-md border border-line-strong bg-surface-2 px-2.5 font-sans text-[12.5px] text-ink outline-none placeholder:text-ink-3 hover:border-input-hover focus:border-pine focus:[box-shadow:0_0_0_3px_var(--input-focus-ring)]'
