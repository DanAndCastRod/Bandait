import { useCallback, useSyncExternalStore } from 'react'

/**
 * true mientras `query` se cumpla. Lee matchMedia en el primer render (sin parpadeo entre la
 * barra movil y el rail) y se suscribe a sus cambios. Sin matchMedia devuelve `fallback`.
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query]
  )
  const getSnapshot = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback)
  return useSyncExternalStore(subscribe, getSnapshot, () => fallback)
}
