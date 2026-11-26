import { test, expect, type Page } from '@playwright/test';

/**
 * E2E del Estudio en la ola 2 de Web 3.0 (maqueta Estudio.dc.html): consola y panel lateral
 * plegables a un clic con el estado recordado, riel de iconos del panel lateral, acceso rapido a
 * la forma de onda (boton de la linea de tiempo y paleta Ctrl+K) y medidores LED en las cabeceras.
 * Sin red ni nube: modo demo.
 */

function wav(seconds: number, freq: number, rate = 8000): Buffer {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function enterStudio(page: Page, title: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('demo-toggle').click();
  await page.getByTestId('demo-profiles').getByRole('button', { name: /Carlos Mendoza/ }).click();
  await expect(page.getByText('BANDAIT', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'ESTUDIO', exact: true }).first().click();
  await expect(page.getByTestId('studio-create')).toBeEnabled();
  await page.getByTestId('studio-new-title').fill(title);
  await page.getByTestId('studio-create').click();
  await expect(page.getByTestId('studio-workspace')).toBeVisible();
  await expect(page.getByTestId('studio-status')).toHaveText('DETENIDO');
}

async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const panels = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('bandait_studio_panels') ?? 'null'));

test.describe('Web Admin Hub - Estudio, ola 2 de Web 3.0', () => {
  test('consola y panel lateral: se pliegan a un clic o con Alt+M / Alt+P y se recuerdan al volver', async ({ page }) => {
    await enterStudio(page, 'Paneles e2e');
    const mixer = page.getByTestId('studio-mixer');
    const dock = page.getByTestId('studio-dock');
    await expect(mixer).toHaveAttribute('data-collapsed', 'false');
    await expect(dock).toBeVisible();

    // Botones visibles: la barra de la consola y el boton de la cabecera.
    await page.getByTestId('studio-mixer-toggle').click();
    await expect(mixer).toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('studio-strip-master')).toHaveCount(0);
    await expect(page.getByTestId('studio-export-open')).toBeVisible();
    await page.getByTestId('studio-console-toggle').click();
    await expect(mixer).toHaveAttribute('data-collapsed', 'false');

    // El riel queda a la vista con el panel plegado; un icono lo vuelve a abrir en su pestana.
    await page.getByTestId('studio-dock-collapse').click();
    await expect(dock).toBeHidden();
    await expect(page.getByTestId('studio-tab-inspector')).toBeVisible();
    await page.getByTestId('studio-tab-inspector').click();
    await expect(dock).toBeVisible();
    await expect(page.getByTestId('studio-tab-inspector')).toHaveAttribute('aria-selected', 'true');

    // Atajos (con el foco en el body).
    await blur(page);
    await page.keyboard.press('Alt+m');
    await expect(mixer).toHaveAttribute('data-collapsed', 'true');
    await page.keyboard.press('Alt+p');
    await expect(dock).toBeHidden();
    await expect.poll(() => panels(page)).toEqual({ sideOpen: false, sideTab: 'inspector', mixerOpen: false });

    // Volver a la sesion: la disposicion sigue como quedo, y la linea de tiempo toma el alto libre.
    await page.reload();
    await page.getByRole('button', { name: 'ESTUDIO', exact: true }).first().click();
    await page.getByTestId('studio-open').first().click();
    await expect(page.getByTestId('studio-workspace')).toBeVisible();
    await expect(page.getByTestId('studio-mixer')).toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('studio-dock')).toBeHidden();
    await expect(page.getByTestId('studio-workspace')).toHaveAttribute('data-console', 'closed');
    await page.getByTestId('studio-side-toggle').click();
    await expect(page.getByTestId('studio-dock')).toBeVisible();
  });

  test('forma de onda: boton ONDA y comando de la paleta abren el acceso rapido; lo elegido llega a APARIENCIA', async ({ page }) => {
    await enterStudio(page, 'Onda e2e');
    await page.getByTestId('studio-import-input').setInputFiles([{ name: 'Guitarra.wav', mimeType: 'audio/wav', buffer: wav(4, 220) }]);
    await expect(page.locator('[data-testid^="studio-led-"]')).toHaveCount(1, { timeout: 15000 });

    const canvas = page.getByTestId('studio-canvas');
    const shot = () => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
    await page.waitForTimeout(500);
    const before = await shot();

    await page.getByTestId('studio-waveform-open').click();
    const popover = page.getByTestId('studio-waveform-popover');
    await expect(popover).toBeVisible();
    await page.getByTestId('studio-waveform-style-bars').click();
    await page.getByTestId('studio-waveform-data-peak-rms').click();
    // El lienzo se repinta con el estilo nuevo, sin recargar.
    await expect.poll(shot).not.toBe(before);
    // Esc lo cierra y devuelve el foco al boton.
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(page.getByTestId('studio-waveform-open')).toBeFocused();

    // Desde la paleta (Ctrl+K).
    await blur(page);
    await page.keyboard.press('Control+k');
    await page.getByTestId('studio-palette-input').fill('forma de onda');
    await expect(page.getByTestId('studio-palette-row').first()).toContainText('Forma de onda');
    await page.keyboard.press('Enter');
    await expect(popover).toBeVisible();
    await expect(page.getByTestId('studio-waveform-style-bars')).toHaveAttribute('aria-checked', 'true');
    // Un clic afuera lo cierra.
    await page.getByTestId('studio-save-status').click();
    await expect(popover).toHaveCount(0);

    // Es la misma preferencia que APARIENCIA.
    await page.locator('nav.hub-desktop-nav').getByRole('button', { name: 'AJUSTES' }).click();
    await page.getByRole('tab', { name: 'APARIENCIA' }).click();
    await expect(page.getByTestId('appearance-waveform-style-bars')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('appearance-waveform-data-peak-rms')).toHaveAttribute('aria-checked', 'true');
  });

  test('comandos nuevos en la paleta y en la hoja de atajos, sin teclas del navegador', async ({ page }) => {
    await enterStudio(page, 'Comandos e2e');
    await blur(page);
    await page.keyboard.press('Control+k');
    for (const [query, label] of [
      ['consola', 'Mostrar u ocultar la consola de mezcla'],
      ['panel lateral', 'Mostrar u ocultar el panel lateral'],
      ['inspector', 'Abrir el inspector'],
    ]) {
      await page.getByTestId('studio-palette-input').fill(query);
      await expect(page.getByTestId('studio-palette-row').first()).toContainText(label);
    }
    await page.keyboard.press('Escape');
    await blur(page);
    await page.keyboard.press('?');
    await expect(page.getByTestId('studio-shortcuts')).toContainText('Alt+M');
    await expect(page.getByTestId('studio-shortcuts')).toContainText('Alt+P');
  });
});
