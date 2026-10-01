/// <reference types="vite/client" />

/** Variables de compilacion del Hub (ver .env.example). Todas son publicas: van dentro del bundle. */
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_GOOGLE_CLIENT_ID?: string
}

/** API minima de Google Identity Services que usa el Hub (perfil local con Google). */
interface Window {
  google?: {
    accounts: {
      id: {
        initialize: (config: {
          client_id: string
          callback: (response: { credential: string }) => void
          auto_select?: boolean
        }) => void
        renderButton: (
          parent: HTMLElement,
          options: {
            theme?: string
            size?: string
            width?: number | string
            text?: string
            shape?: string
          }
        ) => void
        prompt?: () => void
      }
    }
  }
}
