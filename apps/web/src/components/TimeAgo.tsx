import { useEffect, useState } from 'react'
import { relativeTime } from '../format'

export default function TimeAgo({
  iso,
  prefix,
  fallback = '—',
}: {
  iso: string | null
  prefix?: string
  fallback?: string
}) {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!iso) return undefined
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000)
    return () => clearInterval(timer)
  }, [iso])

  const text = iso ? relativeTime(iso) : fallback
  return <>{prefix ? `${prefix} ${text}` : text}</>
}
