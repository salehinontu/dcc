import { useEffect, useRef, useState, type RefObject } from 'react'
import { acquireFeed, releaseFeed, type FeedStatus } from '../feeds'

/**
 * WHEP player. It shows the page's shared connection for the stream (`feeds.ts`), so a
 * recorder or another view of the same stream adds no second media session. The element
 * stays mounted across reconnects so a retry does not flash or lose layout.
 */
export default function WhepPlayer({
  streamId,
  className = 'block size-full',
  variant = 'tile',
  videoRef,
}: {
  streamId: string
  className?: string
  variant?: 'tile' | 'focus'
  /** Receives the rendered <video>, e.g. to capture a still frame from it. */
  videoRef?: RefObject<HTMLVideoElement | null>
}) {
  const ownRef = useRef<HTMLVideoElement>(null)
  const video = videoRef ?? ownRef
  const [status, setStatus] = useState<FeedStatus>('connecting')

  useEffect(() => {
    const element = video.current
    if (!element) return undefined

    const feed = acquireFeed(streamId)
    const sync = (): void => {
      setStatus(feed.status)
      if (element.srcObject === feed.stream) return
      element.srcObject = feed.stream
      if (feed.stream) void element.play().catch(() => undefined)
    }
    sync()
    const unsubscribe = feed.subscribe(sync)

    return () => {
      unsubscribe()
      element.srcObject = null
      releaseFeed(feed)
    }
  }, [streamId, video])

  const chip =
    status === 'playing'
      ? null
      : status === 'failed'
        ? 'Video unavailable'
        : status === 'reconnecting'
          ? 'Reconnecting…'
          : 'Connecting…'

  return (
    <>
      <video ref={video} className={className} autoPlay playsInline muted />
      {chip && (
        <span
          className={`pointer-events-none absolute left-1/2 z-[3] whitespace-nowrap rounded-[999px] px-[9px] py-[3px] text-[10.5px] tracking-[0.02em] text-white backdrop-blur-[6px] [transform:translateX(-50%)] ${
            variant === 'focus' ? 'bottom-[18px]' : 'bottom-2.5'
          } ${status === 'failed' ? 'bg-[var(--whep-failed-bg)]' : 'bg-[var(--whep-bg)]'}`}
          role="status"
        >
          {chip}
        </span>
      )}
    </>
  )
}
