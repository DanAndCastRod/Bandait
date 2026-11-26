import { test, expect, type Page } from '@playwright/test';

/**
 * E2E de la practica del ENSAYO (Web 3.0, seccion 5 de docs/REQUERIMIENTOS_WEB_3.0.md):
 * velocidad (0,50x..1,25x) y tono (+-6 st) sobre el AudioWorklet GranularPitchShifter, tono
 * vinculado a la transposicion de acordes ChordPro, y Speed Ramp por vuelta en un bucle A-B.
 * Los WAV se generan en la prueba. La calidad audible no se mide aqui (ver
 * scripts/verify-stem-practice.ts para el DSP).
 */

function wav(seconds: number, freq: number, rate = 8000): Buffer {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), i * 2);
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

async function rehearseMedianoche(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-toggle').click();
  await page.getByTestId('demo-profiles').getByRole('button', { name: /Carlos Mendoza/ }).click();
  await expect(page.getByText('BANDAIT', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'PISTAS', exact: true }).click();
  await page.getByTestId('stem-song-select').selectOption({ label: 'Medianoche en Pereira' });
  await page.getByTestId('stem-file-input').setInputFiles([
    { name: 'Medianoche - Drums.wav', mimeType: 'audio/wav', buffer: wav(40, 110) },
    { name: 'Medianoche - Bass.wav', mimeType: 'audio/wav', buffer: wav(40, 82) },
  ]);
  await page.getByTestId('stem-save').click();
  await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(2, { timeout: 15000 });
  await page.getByRole('button', { name: 'ENSAYO', exact: true }).click();
  await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(2, { timeout: 15000 });
}

async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test.describe('Web 3.0 - ENSAYO: velocidad, tono y Speed Ramp', () => {
  test('velocidad y tono con teclado; el tono transpone los acordes y transponer mueve el tono', async ({ page }) => {
    await rehearseMedianoche(page);
    const practice = page.getByTestId('stem-practice');
    // El AudioWorklet cargo: tono real (no el respaldo tipo cinta).
    await expect(practice).toHaveAttribute('data-shifter', 'ready', { timeout: 10000 });
    await expect(page.getByTestId('stem-pitch-unavailable')).toHaveCount(0);

    const speed = page.getByTestId('stem-speed');
    const exact = page.getByTestId('stem-speed-exact');
    const pitch = page.getByTestId('stem-pitch');
    const pitchValue = page.getByTestId('stem-pitch-value');
    const reset = page.getByTestId('stem-practice-reset');
    await expect(exact).toHaveValue('1,00x');
    await expect(pitchValue).toHaveText('0 st');
    await expect(reset).toBeDisabled();

    // Velocidad: flechas del deslizador (pasos de 0,05) y valor exacto escrito.
    await speed.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(exact).toHaveValue('0,90x');
    await expect(page.getByTestId('stem-rate')).toHaveText('0,90x');
    await exact.fill('0,73');
    await exact.press('Enter');
    await expect(exact).toHaveValue('0,73x');
    await exact.fill('2');
    await exact.press('Enter');
    await expect(exact).toHaveValue('0,73x');

    // Tono +2 con el teclado: los acordes del prompter pasan de Am a Bm.
    const chords = page.getByTestId('rehearsal-current-chordpro').getByTestId('chordpro-chords');
    await page.getByLabel('Posición').fill('9');
    await expect(chords.first()).toHaveText('Am');
    await pitch.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(pitchValue).toHaveText('+2 st');
    await expect(chords.first()).toHaveText('Bm');
    await expect(page.getByTestId('rehearsal-key')).toContainText('Bm');

    // Transponer los acordes (T del prompter) mueve el tono del audio.
    await blur(page);
    await page.keyboard.press('t');
    await expect(chords.first()).toHaveText('Cm');
    await expect(pitchValue).toHaveText('+3 st');
    await page.keyboard.press('Shift+Digit0');
    await expect(chords.first()).toHaveText('Am');
    await expect(pitchValue).toHaveText('0 st');

    // Fuera de +-6: acordes +7 (Em), el audio suena -5 (misma tonalidad, otra octava) y se avisa.
    for (let i = 0; i < 7; i++) await page.keyboard.press('t');
    await expect(chords.first()).toHaveText('Em');
    await expect(pitchValue).toHaveText('-5 st');
    await expect(page.getByTestId('stem-pitch-note')).toContainText('una octava abajo');
    await page.keyboard.press('Shift+Digit0');
    await expect(page.getByTestId('stem-pitch-note')).toHaveCount(0);

    // Sueltos: el tono del audio ya no mueve los acordes.
    await page.getByTestId('stem-pitch-link').uncheck();
    await page.getByRole('button', { name: 'Subir el tono del audio medio tono' }).click();
    await expect(pitchValue).toHaveText('+1 st');
    await expect(chords.first()).toHaveText('Am');
    // Al volver a vincular, el audio sigue a los acordes (tono original).
    await page.getByTestId('stem-pitch-link').check();
    await expect(pitchValue).toHaveText('0 st');

    // RESTABLECER: velocidad 1,00x y tono original.
    await pitch.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(pitchValue).toHaveText('-1 st');
    await reset.click();
    await expect(exact).toHaveValue('1,00x');
    await expect(pitchValue).toHaveText('0 st');
    await expect(chords.first()).toHaveText('Am');
    await expect(page.getByTestId('stem-rate')).toHaveText('');
  });

  test('a 0,5x la posicion sigue siendo la de la cancion (avanza a la mitad del reloj)', async ({ page }) => {
    await rehearseMedianoche(page);
    await expect(page.getByTestId('stem-practice')).toHaveAttribute('data-shifter', 'ready', { timeout: 10000 });
    const exact = page.getByTestId('stem-speed-exact');
    await exact.fill('0,5');
    await exact.press('Enter');
    await expect(exact).toHaveValue('0,50x');
    await page.getByLabel('Posición').fill('7.2');
    await expect(page.getByTestId('rehearsal-current')).toHaveAttribute('data-label', 'Intro');

    const t0 = Date.now();
    await page.getByTestId('stem-play').click();
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'playing');
    // 7.74 s de cancion = compas 5: la Estrofa 1 llega aunque a media velocidad tarde el doble.
    await expect(page.getByTestId('rehearsal-current')).toHaveAttribute('data-label', 'Estrofa 1', { timeout: 6000 });
    await page.waitForTimeout(800);
    await page.getByTestId('stem-play').click();
    const elapsed = (Date.now() - t0) / 1000;
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'paused');
    const advanced = Number(await page.getByLabel('Posición').inputValue()) - 7.2;
    expect(advanced).toBeGreaterThan(0.54);
    // A 1x habria avanzado casi `elapsed`; a 0,5x, la mitad (menos la latencia del arranque).
    expect(advanced).toBeLessThan(elapsed * 0.5 + 0.1);
  });

  test('Speed Ramp en un bucle A-B: arranca en 0,70x, sube 0,05 por vuelta y bloquea la velocidad manual', async ({ page }) => {
    await rehearseMedianoche(page);
    await expect(page.getByTestId('stem-practice')).toHaveAttribute('data-shifter', 'ready', { timeout: 10000 });
    const rate = page.getByTestId('stem-rate');

    await page.getByTestId('stem-ramp-toggle').check();
    await expect(page.getByTestId('stem-ramp')).toContainText('Elige una repetición');
    await expect(page.getByTestId('stem-speed')).toBeEnabled();

    // Tramo A-B de 1 s: a 0,70x una vuelta dura ~1,43 s.
    await page.getByTestId('stem-loop-select').selectOption('ab');
    const b = page.getByLabel('Punto B en segundos');
    await b.fill('1');
    await b.press('Enter');
    await expect(page.getByTestId('stem-loop-badge')).toBeVisible();
    await expect(page.getByTestId('stem-speed')).toBeDisabled();
    await expect(page.getByTestId('stem-speed-ramp-note')).toBeVisible();
    await expect(rate).toHaveText('RAMPA VUELTA 1 · 0,70x');
    await expect(page.getByTestId('stem-ramp-start')).toHaveValue('0,70x');
    await expect(page.getByTestId('stem-ramp-step')).toHaveValue('+0,05x');
    await expect(page.getByTestId('stem-ramp-top')).toHaveValue('1,00x');

    await page.getByTestId('stem-play').click();
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'playing');
    await expect(rate).toHaveText('RAMPA VUELTA 2 · 0,75x', { timeout: 5000 });
    await expect(rate).toHaveText('RAMPA VUELTA 3 · 0,80x', { timeout: 5000 });
    await page.getByTestId('stem-play').click();
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'paused');
    // Pausa: se queda en la vuelta en que iba.
    await expect(rate).toHaveText('RAMPA VUELTA 3 · 0,80x');

    // Cambiar la rampa vuelve a la primera vuelta con el nuevo inicio.
    const start = page.getByTestId('stem-ramp-start');
    await start.fill('0,6');
    await start.press('Enter');
    await expect(rate).toHaveText('RAMPA VUELTA 1 · 0,60x');

    // Sin repeticion la rampa no actua: vuelve la velocidad manual.
    await page.getByTestId('stem-loop-select').selectOption('none');
    await expect(page.getByTestId('stem-speed')).toBeEnabled();
    await expect(rate).toHaveText('');
  });

  test.describe('telefono', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('390 px: los controles de velocidad, tono y rampa no generan scroll horizontal', async ({ page }) => {
      await rehearseMedianoche(page);
      await expect(page.getByTestId('stem-practice')).toBeVisible();
      await page.getByTestId('stem-ramp-toggle').check();
      await expect(page.getByTestId('stem-ramp-start')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
