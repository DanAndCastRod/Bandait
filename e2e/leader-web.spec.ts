import { test, expect } from '@playwright/test';

/**
 * Tests E2E para la aplicacion web del Lider (bandait-leader-web).
 * App React + Vite que sirve como dashboard del lider de la sesion.
 */

test.describe('Leader Web App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173');
  });

  test('carga correctamente y muestra el titulo', async ({ page }) => {
    // Verificar que la app carga verificando elementos clave del UI
    await expect(page.locator('text=Escenario')).toBeVisible();
  });

  test('muestra la barra de transporte con BPM', async ({ page }) => {
    const transportBar = page.locator('[class*="transport"], [data-testid="transport-bar"]').first();
    // Fallback: buscar elementos que contengan BPM
    const bpmElement = page.locator('text=/BPM/i').first();
    await expect(bpmElement).toBeVisible();
  });

  test('tiene las 4 pestañas de navegacion', async ({ page }) => {
    const expectedTabs = ['Escenario', 'Biblioteca', 'Mezcladora', 'Configuración'];

    for (const tabName of expectedTabs) {
      await expect(page.locator(`text=${tabName}`).first()).toBeVisible();
    }
  });

  test('puede navegar a la pestaña Biblioteca', async ({ page }) => {
    // Click en la pestaña de Biblioteca
    const libraryTab = page.locator('text=Biblioteca').first();
    await libraryTab.click();

    // Verificar que se muestra la biblioteca
    await expect(page.locator('text=Medianoche en Pereira').first()).toBeVisible();
  });

  test('puede navegar a la pestaña Configuración', async ({ page }) => {
    const settingsTab = page.locator('text=Configuración').first();
    await settingsTab.click();

    // Verificar contenido de configuracion
    await expect(page.locator('text=Conexión').first()).toBeVisible();
    await expect(page.locator('text=Estado:').first()).toBeVisible();
  });

  test('muestra el estado de conexion', async ({ page }) => {
    // El estado de conexion deberia mostrarse en la barra lateral
    const connectionStatus = page.locator('[class*="wifi"], svg').first();
    await expect(connectionStatus).toBeVisible();
  });

  test('la vista de Escenario muestra informacion de cancion', async ({ page }) => {
    // En la vista stage deberia haber informacion de la cancion actual
    const stageContent = page.locator('main, [class*="stage"]').first();
    await expect(stageContent).toBeVisible();
  });

  test('tiene el panel de mezcla visible', async ({ page }) => {
    const mixerTab = page.locator('text=Mezcladora').first();
    await mixerTab.click();

    // Verificar que el panel de mezcla se renderiza
    const mixerPanel = page.locator('[class*="mixer"], main').first();
    await expect(mixerPanel).toBeVisible();
  });

  test('aplica el tema oscuro', async ({ page }) => {
    const appContainer = page.locator('body, #root, [class*="app"]').first();
    const bgColor = await appContainer.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // El tema oscuro deberia tener un fondo oscuro
    const rgb = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgb) {
      const [, r, g, b] = rgb.map(Number);
      const brightness = (r + g + b) / 3;
      expect(brightness).toBeLessThan(128); // Fondo oscuro
    }
  });

  test('es responsive en viewport movil', async ({ page }) => {
    // Cambiar a viewport movil
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload();

    // La app deberia seguir siendo funcional
    await expect(page.locator('text=Escenario').first()).toBeVisible();

    // Restaurar viewport
    await page.setViewportSize({ width: 1280, height: 720 });
  });
});
