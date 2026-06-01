import { test } from '@playwright/test';

/**
 * Setup project para follower.
 * Puede usarse para inicializar estado compartido antes de los tests.
 */

test('setup follower', async ({ page }) => {
  // Verificar que el servidor esta disponible
  await page.goto('http://localhost:5174');
  // Si llega aqui, el servidor esta corriendo
});
