/**
 * Guarded service worker registration (vite-plugin-pwa's own injection is
 * disabled with injectRegister: false). Served by the leader over plain HTTP
 * the page is an insecure context: service workers do not exist there, so
 * nothing is registered and nothing is logged (contract section 8).
 */

import { PageContext, currentPageContext, shouldRegisterServiceWorker } from './connectionGuard'

export interface ServiceWorkerDeps {
  page?: PageContext
  isProd?: boolean
  register?: (url: string, scope: string) => Promise<unknown>
  onLoad?: (fn: () => void) => void
}

/** Returns true when a registration was scheduled. Never throws, never leaves an unhandled rejection. */
export function registerServiceWorkerSafely(deps: ServiceWorkerDeps = {}): boolean {
  try {
    const page = deps.page ?? currentPageContext()
    const isProd = deps.isProd ?? import.meta.env.PROD
    if (!shouldRegisterServiceWorker(page, isProd)) return false
    const register =
      deps.register ?? ((url: string, scope: string) => navigator.serviceWorker.register(url, { scope }))
    const run = () => {
      try {
        void register('./sw.js', './').catch(() => undefined)
      } catch {
        // Ignore: the app works without offline caching.
      }
    }
    const onLoad =
      deps.onLoad ??
      ((fn: () => void) => {
        if (document.readyState === 'complete') fn()
        else window.addEventListener('load', fn, { once: true })
      })
    onLoad(run)
    return true
  } catch {
    return false
  }
}
