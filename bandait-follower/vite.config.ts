import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      minify: false,
      registerType: 'autoUpdate',
      // Registered by src/services/serviceWorker.ts only in secure contexts:
      // the follower served by the leader over plain HTTP must not try it.
      injectRegister: false,
      manifest: {
        name: 'Bandait Follower',
        short_name: 'Bandait',
        description: 'Real-time stage monitor for musicians',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {
            src: '/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: '/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        mode: 'development',
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            // Font CSS: serve cached immediately, refresh in the background.
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets',
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            // Font files (woff2) referenced by that CSS: immutable, cache first.
            // Status 0 covers opaque cross-origin responses.
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              cacheableResponse: {
                statuses: [0, 200]
              },
              expiration: {
                maxEntries: 60,
                maxAgeSeconds: 60 * 60 * 24 * 365
              }
            }
          }
        ]
      }
    })
  ],
  server: {
    host: true,
    port: 3000
  }
})
