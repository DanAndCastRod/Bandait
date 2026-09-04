import { test, expect } from '@playwright/test';

/**
 * Tests E2E para la Landing Page estatica de Bandait.
 * Se sirve via file:// ya que es HTML/CSS/JS plano.
 * La baseURL se configura en playwright.config.ts
 */

test.describe('Landing Page', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL || 'file:///C:/proyectos_personales/Bandait/landing/index.html');
  });

  test('carga correctamente y tiene el titulo esperado', async ({ page }) => {
    await expect(page).toHaveTitle(/Bandait/);
  });

  test('muestra el hero con el texto principal', async ({ page }) => {
    const heroHeading = page.locator('h1');
    await expect(heroHeading).toContainText('Sincroniza tu');
    await expect(heroHeading).toContainText('escenario');
  });

  test('tiene la seccion de Features visible', async ({ page }) => {
    const featuresSection = page.locator('#features');
    await expect(featuresSection).toBeVisible();
    await expect(featuresSection.locator('h2')).toContainText('Diseñado para el escenario');
  });

  test('muestra las 4 tarjetas de features', async ({ page }) => {
    const cards = page.locator('.feature-card');
    await expect(cards).toHaveCount(4);

    const expectedFeatures = [
      'Sync de Relojes NTP',
      'Setlist Inteligente',
      'Metrónomo Visual',
      'Multiplataforma',
    ];

    for (const feature of expectedFeatures) {
      await expect(page.locator('.feature-card', { hasText: feature })).toBeVisible();
    }
  });

  test('tiene la seccion Como Funciona', async ({ page }) => {
    const howSection = page.locator('#how-it-works');
    await expect(howSection).toBeVisible();
    await expect(howSection.locator('h2')).toContainText('Cómo funciona');
  });

  test('muestra el diagrama de flujo Lider-Seguidor', async ({ page }) => {
    const flowNodes = page.locator('.flow-node');
    await expect(flowNodes).toHaveCount(3);

    const leaderNode = page.locator('.flow-node.leader');
    await expect(leaderNode).toContainText('Líder');

    const followerNodes = page.locator('.flow-node.follower');
    await expect(followerNodes).toHaveCount(2);
  });

  test('tiene la seccion de Tech Specs', async ({ page }) => {
    const specsSection = page.locator('#specs');
    await expect(specsSection).toBeVisible();

    const specItems = page.locator('.spec-item');
    await expect(specItems).toHaveCount(6);
  });

  test('tiene la seccion de Descargar con links funcionales', async ({ page }) => {
    const downloadSection = page.locator('#download');
    await expect(downloadSection).toBeVisible();

    const downloadLinks = downloadSection.locator('a[href*="github.com"]');
    await expect(downloadLinks).toHaveCount(2);

    // Verificar que los botones de descarga tienen IDs correctos
    await expect(page.locator('#downloadAndroid')).toBeVisible();
    await expect(page.locator('#downloadWindows')).toBeVisible();
  });

  test('tiene el footer con links a GitHub', async ({ page }) => {
    const footer = page.locator('.site-footer');
    await expect(footer).toBeVisible();

    const githubLink = footer.locator('a[href="https://github.com/DanAndCastRod/Bandait"]');
    await expect(githubLink).toBeVisible();
  });

  test('aplica el tema oscuro correctamente', async ({ page }) => {
    const body = page.locator('body');
    const bgColor = await body.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });
    // Verificar que el fondo es oscuro (rgb(0, 0, 0) o similar)
    expect(bgColor).toMatch(/rgb\(0,\s*0,\s*0\)|rgb\(10,\s*10,\s*14\)|#0a0a0e/);
  });

  test('el logo es visible en el header', async ({ page }) => {
    const logo = page.locator('.logo');
    await expect(logo).toBeVisible();
    await expect(logo).toContainText('BAND');
    await expect(logo).toContainText('AIT');
  });

  test('la navegacion tiene los links correctos', async ({ page }) => {
    const navLinks = page.locator('.nav-links a');
    await expect(navLinks).toHaveCount(4);

    const expectedLinks = ['Features', 'Cómo Funciona', 'Specs', 'Descargar'];
    for (const text of expectedLinks) {
      await expect(page.locator('.nav-links a', { hasText: text })).toBeVisible();
    }
  });

  test('el badge de version es visible', async ({ page }) => {
    const badge = page.locator('.hero-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('Stage Ready');
  });
});
