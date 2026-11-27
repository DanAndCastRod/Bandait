import { test, expect, type Page } from '@playwright/test';
import { openView } from './support/hubNav';

async function enterDemo(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-toggle').click();
  await page.getByTestId('demo-profiles').getByRole('button', { name: /Carlos Mendoza/ }).click();
  await expect(page.getByTestId('hub-logo')).toBeVisible();
}

test.describe('Web Admin Hub - Ola 3 (VCS, Optimizador IO, Universo Canción, DSP LAB y Móvil + Widgets)', () => {
  test('Universo de la Canción + Versiones de Canción/Setlist + Optimizador Simulated Annealing con modo LAB', async ({ page }) => {
    await enterDemo(page);

    // 1. Abrir Libreria de Canciones, fijar una cancion en SongUniverseBar y crear snapshot VCS
    await openView(page, 'songs');
    const firstCard = page.getByTestId('song-card').first();
    await firstCard.click();
    await expect(page.getByTestId('song-universe-bar')).toBeVisible();

    await firstCard.getByTestId('song-versions-btn').click();
    const historyModal = page.getByTestId('entity-history-modal');
    await expect(historyModal).toBeVisible();
    await historyModal.getByTestId('entity-vcs-message').fill('Arreglo original de estudio');
    await historyModal.getByTestId('entity-vcs-commit').click();
    await expect(historyModal.getByTestId('entity-vcs-commit-item')).toHaveCount(1);
    await page.keyboard.press('Escape');

    // 2. Saltar a Setlists en 1 clic desde SongUniverseBar y abrir Optimizador IA/IO + LAB
    await page.getByTestId('universe-jump-setlists').click();
    await expect(page.getByRole('heading', { name: /Programación de Setlists/ })).toBeVisible();

    await page.getByTestId('open-setlist-optimizer').click();
    const optModal = page.getByTestId('setlist-optimizer-modal');
    await expect(optModal).toBeVisible();
    await optModal.getByTestId('setlist-optimizer-lab-toggle').click();
    await expect(optModal.getByTestId('setlist-optimizer-lab-panel')).toBeVisible();
    await optModal.getByTestId('setlist-profile-in_crescendo').click();
    await page.keyboard.press('Escape');
  });

  test('Estudio DAW: Control de Versiones con A/B 0 ms, Analizador DSP LAB y Superficie Móvil + 5 Widgets', async ({ page }) => {
    await enterDemo(page);
    await openView(page, 'studio');
    await page.getByTestId('studio-new-title').fill('Sesión Ola 3 E2E');
    await page.getByTestId('studio-create').click();
    await expect(page.getByTestId('studio-workspace')).toBeVisible();
    // En escritorio no hay boton flotante de herramientas (solo movil).
    await expect(page.getByTestId('mobile-widget-fab')).toHaveCount(0);

    // Abrir panel de Versiones, guardar un snapshot y alternar escucha A/B 0 ms
    await page.getByTestId('studio-versions-open').click();
    const vcsPanel = page.getByTestId('studio-version-panel');
    await expect(vcsPanel).toBeVisible();
    await vcsPanel.getByTestId('studio-vcs-message-input').fill('Mezcla base A');
    await vcsPanel.getByTestId('studio-vcs-commit-btn').click();
    await expect(vcsPanel.getByTestId('studio-vcs-commit-list').locator('li')).toHaveCount(1);
    await expect(page.getByTestId('studio-ab-quick')).toBeVisible();
    await page.getByTestId('studio-ab-quick').click();
    await expect(page.getByTestId('studio-ab-quick')).toContainText('ESCUCHANDO B');
    await page.getByTestId('studio-ab-quick').click();

    // Activar modo LAB en la consola y verificar el Analizador DSP (FFT / STFT / M-S / Bark) en el Inspector
    await page.getByTestId('studio-lab-toggle').click();
    await page.getByTestId('studio-tab-inspector').click();
    await expect(page.getByTestId('studio-analyzer-lab')).toBeVisible();

    // Redimensionar a movil 390x844: verificar conmutador de 5 superficies y bandeja de 5 Widgets
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('studio-mobile-nav')).toBeVisible();
    await expect(page.getByTestId('studio-mobile-quick')).toBeVisible();

    await page.getByTestId('mobile-widget-fab').click();
    const tray = page.getByTestId('mobile-widget-tray');
    await expect(tray).toBeVisible();
    await expect(tray.getByTestId('widget-tuner')).toBeVisible();
    await tray.getByTestId('mobile-widget-tab-metronome').click();
    await expect(tray.getByTestId('widget-metronome')).toBeVisible();
    await tray.getByTestId('mobile-widget-tab-xypad').click();
    await expect(tray.getByTestId('widget-xypad-surface')).toBeVisible();
    await tray.getByTestId('mobile-widget-tab-recorder').click();
    await expect(tray.getByTestId('widget-recorder')).toBeVisible();
    await tray.getByTestId('mobile-widget-tab-ab').click();
    await expect(tray.getByTestId('widget-ab')).toBeVisible();
    await tray.getByTestId('mobile-widget-close').click();
    await expect(tray).toHaveCount(0);
  });

  test('Promover maqueta: agrega al setlist elegido sin cambiar el setlist activo', async ({ page }) => {
    await enterDemo(page);
    await openView(page, 'setlists');
    const activeSelect = page.getByLabel('Setlist activo');
    await expect(activeSelect).toBeVisible();
    const activeId = await activeSelect.inputValue();
    const ids = await activeSelect.locator('option').evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    test.skip(ids.length < 2, 'la demo necesita dos setlists');
    const targetId = ids.find((id) => id !== activeId)!;
    const rowsBefore = await page.getByTestId('setlist-row').count();

    await openView(page, 'studio');
    await page.getByTestId('studio-new-title').fill('Maqueta Promovida E2E');
    await page.getByTestId('studio-create').click();
    await expect(page.getByTestId('studio-workspace')).toBeVisible();
    await page.getByTestId('studio-song-bridge-open').click();
    const modal = page.getByTestId('studio-song-bridge-modal');
    await modal.getByTestId('studio-bridge-promote-playlist').selectOption(targetId);
    await modal.getByTestId('studio-bridge-promote').click();
    await expect(modal).toHaveCount(0);

    await openView(page, 'setlists');
    await expect(activeSelect).toHaveValue(activeId);
    await expect(page.getByTestId('setlist-row')).toHaveCount(rowsBefore);
    await activeSelect.selectOption(targetId);
    await expect(page.getByTestId('setlist-row').filter({ hasText: 'Maqueta Promovida E2E' })).toHaveCount(1);
  });
});
