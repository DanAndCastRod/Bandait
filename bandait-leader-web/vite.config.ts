import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    // 5173 coincide con playwright.config.ts (proyecto leader-web). strictPort evita que Vite
    // salte a otro puerto en silencio y las pruebas golpeen otro servidor.
    port: 5173,
    strictPort: true,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
