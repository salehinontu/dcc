import { useEffect } from 'react'
import { unwatch, watch } from './socket'

/** Watches aircraft for as long as the component asks for them. */
export function useWatch(sns: readonly string[]): void {
  const key = [...new Set(sns)].sort().join('\n')

  useEffect(() => {
    const list = key ? key.split('\n') : []
    for (const sn of list) watch(sn)
    return () => {
      for (const sn of list) unwatch(sn)
    }
  }, [key])
}
