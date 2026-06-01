import { defineConfig, devices } from '@playwright/test';
import path from 'path';

/**
 * Configuracion de Playwright E2E para todo el proyecto Bandait.
 *
 * Proyectos:
 *  - landing    : Tests de la landing page estatica (file://)
 *  - leader-web : Tests de la app React del lider (Vite dev server)
 *  - follower   : Tests de la app React del seguidor (Vite dev server)
 *
 * Ver: https://playwright.dev/docs/test-configuration
 */

const LANDING_PATH = path.resolve(__dirname, 'landing/index.html');

export default defineConfig({
  testDir: './e2e',

  /* Ejecutar tests en archivos en paralelo */
  fullyParallel: true,

  /* Fallar el build en CI si dejaste test.only */
  forbidOnly: !!process.env.CI,

  /* Reintentos en CI, 0 en local */
  retries: process.env.CI ? 2 : 0,

  /* Workers en paralelo. En CI usa 1 para evitar conflictos de puertos */
  workers: process.env.CI ? 1 : undefined,

  /* Reporter */
  reporter: [['list'], ['html', { open: 'never' }]],

  /* Shared settings for all projects */
  use: {
    /* Collect trace. Ver https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',

    /* Screenshot en fallo */
    screenshot: 'only-on-failure',

    /* Video en fallo */
    video: 'on-first-retry',
  },

  /* Proyectos separados por app */
  projects: [
    {
      name: 'landing',
      testMatch: /landing\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `file://${LANDING_PATH}`,
      },
    },
    {
      name: 'leader-web',
      testMatch: /leader-web\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:5173',
      },
    },
    {
      name: 'follower',
      testMatch: /follower\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:5174',
      },
    },
  ],

  /* Web servers para levantar las apps antes de testear */
  webServer: [
    {
      command: 'cd bandait-leader-web && npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60000,
    },
    {
      command: 'cd bandait-follower && npm run dev',
      url: 'http://localhost:5174',
      reuseExistingServer: true,
      timeout: 60000,
    },
  ],
});
