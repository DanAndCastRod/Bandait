import { test, expect } from '@playwright/test';

/**
 * Tests E2E para la aplicacion del Seguidor (bandait-follower).
 * App React + Vite para dispositivos moviles de los musicos.
 */

test.describe('Follower App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5174');
  });

  test('carga la pantalla de conexion', async ({ page }) => {
    // Verificar que se muestra la pantalla de conexion inicial
    await expect(page.locator('text=BANDAIT').first()).toBeVisible();
    await expect(page.locator('text=Stage Monitor').first()).toBeVisible();
  });

  test('tiene el formulario de conexion con campos correctos', async ({ page }) => {
    // Verificar campos del formulario
    await expect(page.locator('text=Leader IP').first()).toBeVisible();
    await expect(page.locator('text=Port').first()).toBeVisible();
    await expect(page.locator('text=Session ID').first()).toBeVisible();

    // Verificar inputs
    const inputs = page.locator('input[type="text"]');
    await expect(inputs).toHaveCount(3);

    // Verificar boton de conectar
    await expect(page.locator('text=CONNECT').first()).toBeVisible();
  });

  test('tiene el boton de escanear QR', async ({ page }) => {
    const qrButton = page.locator('text=/SCAN QR CODE|SCANNING/i').first();
    await expect(qrButton).toBeVisible();
  });

  test('tiene el separador OR', async ({ page }) => {
    await expect(page.locator('text=OR').first()).toBeVisible();
  });

  test('puede conectarse y navegar a la vista Stage', async ({ page }) => {
    // Llenar el formulario
    await page.locator('input[type="text"]').nth(0).fill('192.168.1.100');
    await page.locator('input[type="text"]').nth(1).fill('4040');
    await page.locator('input[type="text"]').nth(2).fill('test-session');

    // Click en conectar
    await page.locator('text=CONNECT').first().click();

    // Verificar que navega a la vista de stage
    // El stage muestra informacion de la sesion
    await expect(page.locator('text=/CONECTADO|OFFLINE|SYNC OK/i').first()).toBeVisible();
  });

  test('la vista stage muestra elementos de UI correctamente', async ({ page }) => {
    // Navegar a stage primero
    await page.locator('input[type="text"]').nth(0).fill('192.168.1.100');
    await page.locator('input[type="text"]').nth(1).fill('4040');
    await page.locator('text=CONNECT').first().click();

    // Verificar elementos del stage
    // BPM display
    await expect(page.locator('text=BPM').first()).toBeVisible();

    // Beat indicator (4 dots)
    const beatDots = page.locator('.beat-dot');
    await expect(beatDots).toHaveCount(4);

    // Botones de navegacion
    await expect(page.locator('text=☰').first()).toBeVisible(); // Biblioteca
    await expect(page.locator('text=⛶').first()).toBeVisible(); // Fullscreen
    await expect(page.locator('text=✕').first()).toBeVisible(); // Desconectar
  });

  test('tiene el control de emergencia deslizable', async ({ page }) => {
    // Navegar a stage
    await page.locator('input[type="text"]').nth(0).fill('192.168.1.100');
    await page.locator('input[type="text"]').nth(1).fill('4040');
    await page.locator('text=CONNECT').first().click();

    // Verificar el control de emergencia
    await expect(page.locator('text=/DESLIZAR|DETENER/i').first()).toBeVisible();
  });

  test('aplica el tema oscuro', async ({ page }) => {
    const appContainer = page.locator('body, #root, .app-container').first();
    const bgColor = await appContainer.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    const rgb = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgb) {
      const [, r, g, b] = rgb.map(Number);
      const brightness = (r + g + b) / 3;
      expect(brightness).toBeLessThan(128);
    }
  });

  test('es responsive en viewport movil', async ({ page }) => {
    // Cambiar a viewport movil
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload();

    // La app deberia seguir mostrando la pantalla de conexion
    await expect(page.locator('text=BANDAIT').first()).toBeVisible();
    await expect(page.locator('text=CONNECT').first()).toBeVisible();

    // Restaurar viewport
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('mantiene los valores en localStorage', async ({ page }) => {
    // Llenar el formulario
    await page.locator('input[type="text"]').nth(0).fill('192.168.1.50');
    await page.locator('input[type="text"]').nth(1).fill('8080');

    // Recargar la pagina
    await page.reload();

    // Verificar que los valores se mantienen
    const ipValue = await page.locator('input[type="text"]').nth(0).inputValue();
    expect(ipValue).toBe('192.168.1.50');
  });
});
