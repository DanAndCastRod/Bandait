import { test } from '@playwright/test';

/**
 * Setup project para leader-web.
 * Puede usarse para inicializar estado compartido antes de los tests.
 */

test('setup leader-web', async ({ page }) => {
  // Verificar que el servidor esta disponible
  await page.goto('http://localhost:5173');
  // Si llega aqui, el servidor esta corriendo
});
