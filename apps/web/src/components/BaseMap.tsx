import { useEffect, useRef } from 'react'
import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl'

export const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'

/** Dhaka, where the fleet starts before any aircraft or zone gives the map a better centre. */
export const DEFAULT_CENTER: [number, number] = [90.4125, 23.8103]

/**
 * The shared MapLibre canvas for the zone editor and a flight replay. `onReady` receives the
 * map once its style has loaded (layers can be added from then on); `onDispose` runs before
 * the map is removed. The parent must be `relative` and sized: the canvas fills it.
 */
export default function BaseMap({
  onReady,
  onDispose,
  testId,
}: {
  onReady: (map: MapLibreMap) => void
  onDispose?: () => void
  testId?: string
}) {
  const container = useRef<HTMLDivElement>(null)
  const ready = useRef(onReady)
  const dispose = useRef(onDispose)

  useEffect(() => {
    ready.current = onReady
    dispose.current = onDispose
  })

  useEffect(() => {
    if (!container.current) return undefined
    const instance = new MapLibreMap({
      container: container.current,
      style: BASEMAP_STYLE,
      center: DEFAULT_CENTER,
      zoom: 11,
    })
    instance.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    instance.on('load', () => ready.current(instance))
    return () => {
      dispose.current?.()
      instance.remove()
    }
  }, [])

  return <div className="map" ref={container} data-testid={testId} />
}
