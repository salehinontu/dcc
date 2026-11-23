import type { ReactNode, SVGProps } from 'react'
import { cn } from '../ui/cn'

export type IconName =
  | 'mark'
  | 'map'
  | 'wall'
  | 'search'
  | 'x'
  | 'edit'
  | 'expand'
  | 'fullscreen'
  | 'fullscreenExit'
  | 'back'
  | 'refresh'
  | 'plus'
  | 'minus'
  | 'logout'
  | 'eye'
  | 'eyeOff'
  | 'check'
  | 'alert'
  | 'stop'
  | 'play'
  | 'arrowRight'
  | 'menu'
  | 'link'
  | 'user'
  | 'lock'
  | 'camera'
  | 'image'
  | 'download'
  | 'users'
  | 'trash'
  | 'server'
  | 'zone'
  | 'route'
  | 'bell'
  | 'pause'
  | 'crosshair'
  | 'upload'
  | 'record'
  | 'laptop'
  | 'list'
  | 'folder'
  | 'drone'
  | 'battery'
  | 'signalOff'

const paths: Record<IconName, ReactNode> = {
  mark: (
    <>
      <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
      <circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />
    </>
  ),
  map: (
    <>
      <path d="M9 4 3.6 6.2v13.4L9 17.4l6 2.6 5.4-2.2V4.4L15 6.6 9 4Z" />
      <path d="M9 4v13.4M15 6.6v13.4" />
    </>
  ),
  wall: (
    <>
      <rect x="4" y="4" width="6.4" height="6.4" rx="1" />
      <rect x="13.6" y="4" width="6.4" height="6.4" rx="1" />
      <rect x="4" y="13.6" width="6.4" height="6.4" rx="1" />
      <rect x="13.6" y="13.6" width="6.4" height="6.4" rx="1" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.4" />
      <path d="m15.6 15.6 4.2 4.2" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  edit: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
  expand: <path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5" />,
  fullscreen: <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />,
  fullscreenExit: <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />,
  back: <path d="M14.5 6 8.5 12l6 6" />,
  refresh: <path d="M20 11a8 8 0 0 0-14.9-4M4 5v5h5M4 13a8 8 0 0 0 14.9 4M20 19v-5h-5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  logout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3" />,
  eye: (
    <>
      <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="m4 4 16 16" />
    </>
  ),
  check: <path d="m5 12.5 4.2 4.2L19 7" />,
  alert: (
    <>
      <path d="M12 3.5 22 20H2L12 3.5Z" />
      <path d="M12 9.5v4.2" />
      <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.2" />,
  play: <path d="M8 5.2 19 12 8 18.8V5.2Z" />,
  arrowRight: <path d="M4 12h15M14 7l5 5-5 5" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  link: (
    <>
      <path d="M10 13.8a4 4 0 0 0 5.7 0l2.4-2.4a4 4 0 0 0-5.7-5.7L11.1 7" />
      <path d="M14 10.2a4 4 0 0 0-5.7 0l-2.4 2.4a4 4 0 0 0 5.7 5.7l1.3-1.3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="1.5" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
      <circle cx="12" cy="15.2" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9Z" />
      <circle cx="12" cy="13" r="3.4" />
    </>
  ),
  image: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="1.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m20 15.5-4.5-4.5L7 19" />
    </>
  ),
  download: <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" />,
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M2.8 20a6.2 6.2 0 0 1 12.4 0" />
      <path d="M15.6 5.6a3.2 3.2 0 0 1 0 5.8M17.4 14.4A6.2 6.2 0 0 1 21.2 20" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  zone: (
    <>
      <path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2L8.2 3Z" />
      <path d="M12 7.5v5.5M12 16.2v.1" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="6" r="2.2" />
      <path d="M8 18h6.5a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H16" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15L6 16.5Z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  pause: <path d="M8 5v14M16 5v14" />,
  crosshair: (
    <>
      <circle cx="12" cy="12" r="6.5" />
      <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
    </>
  ),
  upload: <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 19.5h14" />,
  record: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
  drone: (
    <>
      <circle cx="6" cy="6" r="2.6" />
      <circle cx="18" cy="6" r="2.6" />
      <circle cx="6" cy="18" r="2.6" />
      <circle cx="18" cy="18" r="2.6" />
      <path d="M8 8l2.2 2.2M16 8l-2.2 2.2M8 16l2.2-2.2M16 16l-2.2-2.2" />
      <rect x="10" y="10" width="4" height="4" rx="1" />
    </>
  ),
  battery: (
    <>
      <rect x="2.5" y="8" width="16" height="8.5" rx="2" />
      <path d="M21.5 11v3M6 11.2v2.6" />
    </>
  ),
  signalOff: (
    <>
      <path d="M4.5 9.2a10.5 10.5 0 0 1 3-2.1M19.5 9.2a10.5 10.5 0 0 0-8-3.1M7.5 13a6 6 0 0 1 2-1.4M16.5 13a6 6 0 0 0-3.4-1.7" />
      <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
      <path d="m4 4 16 16" />
    </>
  ),
  list: <path d="M8.5 6.5H20M8.5 12H20M8.5 17.5H20M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
  laptop: (
    <>
      <rect x="5" y="5" width="14" height="10" rx="1.4" />
      <path d="M2.5 19h19" />
    </>
  ),
  folder: (
    <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l1.8 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" />
  ),
  server: (
    <>
      <rect x="3" y="3.5" width="18" height="7" rx="1.6" />
      <rect x="3" y="13.5" width="18" height="7" rx="1.6" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
}

export default function Icon({
  name,
  className = '',
  ...rest
}: SVGProps<SVGSVGElement> & { name: IconName }) {
  // The 18 px default is also a CSS rule in base.css, but that rule only applies once the
  // stylesheet has loaded. The attributes keep icons at 18 px during the first paint
  // instead of the SVG intrinsic 300x150. `{...rest}` is spread last, so callers win.
  return (
    <svg
      className={cn(
        'block flex-none fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.6]',
        className,
      )}
      data-icon=""
      viewBox="0 0 24 24"
      width={18}
      height={18}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths[name]}
    </svg>
  )
}
