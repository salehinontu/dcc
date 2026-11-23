import { useState } from 'react'
import type { VideoSourceInfo } from '@dji/protocol'
import Button from '../ui/Button'
import { cn } from '../ui/cn'
import Icon from './Icon'

/** One value the pilot copies into DJI Fly, with a Copy button that says it worked. */
function CopyRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // Without clipboard access the field is still selectable by hand.
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="grid gap-1.5 sm:grid-cols-[130px_minmax(0,1fr)_auto] sm:items-center">
      <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-3">{label}</span>
      <input
        readOnly
        value={value}
        data-testid={testId}
        aria-label={label}
        onFocus={(event) => event.currentTarget.select()}
        className="h-9 min-w-0 rounded-md border border-line-strong bg-surface-2 px-2.5 font-mono text-[12px] text-ink outline-none focus:border-pine"
      />
      <Button variant="secondary" onClick={() => void copy()} aria-label={`Copy ${label}`}>
        <Icon name={copied ? 'check' : 'link'} />
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

/**
 * The address a pilot types into DJI Fly's livestream settings for one video-only drone. DJI Fly
 * has two boxes (RTMP Address and Stream Key), so both are shown, and the joined address too for
 * the one-box case.
 */
export default function VideoSourcePanel({
  source,
  onClose,
  onNewKey,
  className,
}: {
  source: VideoSourceInfo
  onClose: () => void
  onNewKey?: () => void
  className?: string
}) {
  return (
    <section
      className={cn(
        'rounded-lg border border-line bg-white p-4 [box-shadow:var(--shadow-card)]',
        className,
      )}
      aria-label={`DJI Fly address for ${source.name}`}
      data-testid="video-source-panel"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-[14px] font-semibold">Send video from {source.name}</h2>
          <p className="m-0 mt-1 text-[12px] leading-[1.55] text-ink-3">
            In DJI Fly open <strong className="font-medium text-ink-2">Livestream</strong>, choose
            RTMP, then copy these two boxes. Pick 720P. The video shows on the Live wall as soon as
            you press Start Livestream.
          </p>
        </div>
        <button
          type="button"
          className="grid size-7 flex-none place-items-center rounded-sm text-ink-3 hover:bg-sunken hover:text-ink [&_svg]:size-3.5"
          aria-label="Close"
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </div>

      <div className="grid gap-2.5">
        <CopyRow label="RTMP Address" value={source.address} testId="video-source-address" />
        <CopyRow label="Stream Key" value={source.key} testId="video-source-key" />
        <CopyRow label="Both in one box" value={source.url} testId="video-source-url" />
      </div>

      <p className="m-0 mt-3 text-[11.5px] leading-[1.55] text-ink-3">
        Anyone with this address can send video to this drone, so treat it like a password. If it
        leaks, make a new key: the old one stops working at once.
      </p>
      {onNewKey && (
        <div className="mt-2.5">
          <Button variant="secondary" onClick={onNewKey}>
            <Icon name="refresh" />
            Make a new key
          </Button>
        </div>
      )}
    </section>
  )
}
