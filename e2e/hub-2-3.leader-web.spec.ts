import { test, expect, type Page, type Route } from '@playwright/test';
import { FakeSupabase, USER, signInWithFakeCloud, workspaceWith } from './support/fakeSupabase';

/**
 * E2E del hub 2.3: navegacion con los nombres y el orden del lider, ENSAYO (prompter que sigue la
 * posicion del reproductor), editar equipos en AJUSTES y ANALIZAR CON IA contra el Worker
 * bandait-stems SIMULADO con page.route (https://stems.e2e.invalid, ver playwright.config.ts).
 * Los WAV se generan en la prueba.
 */

const STEMS = 'https://stems.e2e.invalid';
const TABS = ['SETLISTS', 'CANCIONES', 'ENSAYO', 'PISTAS', 'BANDA', 'AJUSTES'];

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

async function enterDemo(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-toggle').click();
  await page.getByTestId('demo-profiles').getByRole('button', { name: /Carlos Mendoza/ }).click();
  await expect(page.getByText('BANDAIT', { exact: true }).first()).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('Web Admin Hub 2.3 - navegacion', () => {
  test('escritorio: las 6 vistas del lider en orden, sin Escenario, y AJUSTES agrupa voz y equipos', async ({ page }) => {
    await enterDemo(page);
    const nav = page.locator('nav.hub-desktop-nav');
    await expect(nav.getByRole('button')).toHaveText(TABS);
    await expect(page.getByRole('button', { name: /ESCENARIO|PLAYLISTS|INTEGRANTES|EQUIPAMIENTO/ })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'SETLISTS' })).toHaveAttribute('aria-current', 'page');

    await nav.getByRole('button', { name: 'AJUSTES' }).click();
    await expect(nav.getByRole('button', { name: 'AJUSTES' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('tab')).toHaveText(['VOZ Y CONTEOS', 'EQUIPAMIENTO']);
    await expect(page.getByRole('heading', { name: 'Voz y Conteos' })).toBeVisible();
    await page.getByRole('tab', { name: 'EQUIPAMIENTO' }).click();
    await expect(page.getByRole('tab', { name: 'EQUIPAMIENTO' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Rider Técnico & Ruteo de Equipos' })).toBeVisible();
  });

  test('movil 390 px: la barra inferior trae las mismas 6 vistas sin scroll horizontal', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await enterDemo(page);
    const bottom = page.locator('nav.hub-mobile-nav');
    await expect(bottom.getByRole('button')).toHaveText(TABS);
    for (const name of TABS) {
      await bottom.getByRole('button', { name, exact: true }).click();
      await expect(bottom.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    }
  });

  test('AJUSTES > EQUIPAMIENTO: editar un equipo conserva su id y se guarda', async ({ page }) => {
    await enterDemo(page);
    await page.getByRole('button', { name: 'AJUSTES', exact: true }).click();
    await page.getByRole('tab', { name: 'EQUIPAMIENTO' }).click();
    const card = page.getByTestId('equipment-card').filter({ hasText: 'Interfaz ASIO FOH Master' });
    await card.getByRole('button', { name: 'Editar Interfaz ASIO FOH Master' }).click();
    const editor = page.getByTestId('equipment-editor');
    await expect(editor.getByLabel('NOMBRE DEL EQUIPO')).toHaveValue('Interfaz ASIO FOH Master');
    await editor.getByLabel('NOMBRE DEL EQUIPO').fill('Interfaz FOH Principal');
    await editor.getByLabel('FRECUENCIA RF (SI APLICA)').fill('600.000 MHz');
    await editor.getByTestId('equipment-save').click();
    await expect(page.getByTestId('equipment-card').filter({ hasText: 'Interfaz FOH Principal' })).toContainText('600.000 MHz');
    await expect(page.getByTestId('equipment-card')).toHaveCount(4);
    const stored = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('bandait_workspace_'));
      return key ? JSON.parse(localStorage.getItem(key) as string).equipmentMap.band_01 : null;
    });
    expect(stored.find((e: any) => e.id === 'eq_01')).toMatchObject({ name: 'Interfaz FOH Principal', rfFrequency: '600.000 MHz', bandId: 'band_01' });
  });
});

test.describe('Web Admin Hub 2.3 - ENSAYO', () => {
  test('el prompter sigue la posicion: seccion actual con su ChordPro, la siguiente, y ACORDES / LETRA', async ({ page }) => {
    await enterDemo(page);
    await page.getByRole('button', { name: 'ENSAYO', exact: true }).click();
    await expect(page.getByTestId('rehearsal-empty')).toBeVisible();
    await page.getByTestId('rehearsal-empty').getByRole('button', { name: 'IR A PISTAS' }).click();
    await expect(page.getByRole('heading', { name: 'Estudio de Stems' })).toBeVisible();

    // Medianoche en Pereira: 124 BPM 4/4, Intro 4 compases (7.74 s) y Estrofa 1 de 8.
    await page.getByTestId('stem-song-select').selectOption({ label: 'Medianoche en Pereira' });
    await page.getByTestId('stem-file-input').setInputFiles([
      { name: 'Medianoche - Drums.wav', mimeType: 'audio/wav', buffer: wav(20, 110) },
      { name: 'Medianoche - Bass.wav', mimeType: 'audio/wav', buffer: wav(20, 82) },
    ]);
    await page.getByTestId('stem-save').click();
    await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(2, { timeout: 15000 });

    await page.getByRole('button', { name: 'ENSAYO', exact: true }).click();
    await expect(page.getByTestId('rehearsal-song-select')).toHaveValue(/.+/);
    await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(2, { timeout: 15000 });
    const current = page.getByTestId('rehearsal-current');
    await expect(current).toHaveAttribute('data-label', 'Intro');
    await expect(page.getByTestId('rehearsal-next')).toHaveAttribute('data-label', 'Estrofa 1');
    await expect(page.getByTestId('rehearsal-bar')).toHaveText('COMPÁS 1');

    // 9 s a 124 BPM = compas 5.65: Estrofa 1, con el Coro como siguiente.
    await page.getByLabel('Posición').fill('9');
    await expect(current).toHaveAttribute('data-label', 'Estrofa 1');
    await expect(page.getByTestId('rehearsal-bar')).toHaveText('COMPÁS 5');
    await expect(page.getByTestId('rehearsal-next')).toHaveAttribute('data-label', 'Coro');
    const chordpro = page.getByTestId('rehearsal-current-chordpro');
    await expect(chordpro).toHaveAttribute('data-mode', 'chords');
    await expect(chordpro.getByTestId('chordpro-chords').first()).toContainText('Am');
    await expect(chordpro).toContainText('Medianoche en');

    await page.getByRole('button', { name: 'LETRA', exact: true }).click();
    await expect(chordpro).toHaveAttribute('data-mode', 'lyrics');
    await expect(chordpro.getByTestId('chordpro-chords')).toHaveCount(0);
    await expect(chordpro).toContainText('Medianoche en Pereira,');

    // Reproduciendo, la seccion avanza sola (de Estrofa 1 a Coro en el compas 13 = 23.2 s: se salta con la posicion).
    await page.getByLabel('Posición').fill('7.2');
    await expect(current).toHaveAttribute('data-label', 'Intro');
    await page.getByTestId('stem-play').click();
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'playing');
    await expect(current).toHaveAttribute('data-label', 'Estrofa 1', { timeout: 5000 });
    await page.getByTestId('stem-stop').click();
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'stopped');
    await expect(current).toHaveAttribute('data-label', 'Intro');

    // Riel de secciones: tocar una lleva el audio ahi; la actual queda marcada.
    const chips = page.getByTestId('rehearsal-section-chip');
    await expect(chips).toHaveCount(5);
    await expect(chips.nth(0)).toHaveAttribute('data-state', 'current');
    await chips.nth(1).click();
    await expect(current).toHaveAttribute('data-label', 'Estrofa 1');
    await expect(chips.nth(1)).toHaveAttribute('aria-current', 'step');
    await expect(chips.nth(0)).toHaveAttribute('data-state', 'past');

    // REPETIR SECCION repite la actual (el mismo bucle que el selector REPETIR) y se apaga igual.
    const loopBtn = page.getByTestId('rehearsal-loop-current');
    await loopBtn.click();
    await expect(loopBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('stem-loop-badge')).toBeVisible();
    await expect(page.getByTestId('stem-loop-select')).toHaveValue(/^sec:/);
    await loopBtn.click();
    await expect(page.getByTestId('stem-loop-badge')).toHaveCount(0);
    await expect(page.getByTestId('stem-loop-select')).toHaveValue('none');

    // Mezcla compacta en el panel lateral (abierta en escritorio): sin rol ni quitar, eso vive en PISTAS.
    const mixer = page.getByTestId('rehearsal-mixer');
    await expect(mixer).toHaveAttribute('open', '');
    await expect(mixer.getByRole('button', { name: 'Silenciar Bateria' })).toBeVisible();
    await expect(mixer.getByLabel(/^Rol de /)).toHaveCount(0);
    await expect(mixer.getByRole('button', { name: /^Quitar / })).toHaveCount(0);
  });

  test('movil 390 px: ENSAYO en una columna, la mezcla plegada y las lineas largas ajustan renglon', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await enterDemo(page);
    // Una estrofa con una linea larga de acordes en linea, como la que arma el analisis.
    await page.getByRole('button', { name: 'CANCIONES', exact: true }).click();
    await page.getByTestId('song-card').filter({ hasText: 'Medianoche en Pereira' }).getByRole('button', { name: 'EDITAR' }).click();
    const editor = page.getByTestId('song-editor');
    const long = '[Am]Medianoche en [F]Pereira, la ciudad no duerme y la [C]noche se queda despierta hasta que [G]vuelvas';
    await editor.getByLabel('ChordPro de la sección 2').fill(long);
    await editor.getByTestId('song-save').click();
    await expect(editor).toHaveCount(0);

    await page.getByRole('button', { name: 'PISTAS', exact: true }).click();
    await page.getByTestId('stem-song-select').selectOption({ label: 'Medianoche en Pereira' });
    await page.getByTestId('stem-file-input').setInputFiles([{ name: 'Medianoche - Drums.wav', mimeType: 'audio/wav', buffer: wav(20, 110) }]);
    await page.getByTestId('stem-save').click();
    await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(1, { timeout: 15000 });

    await page.getByRole('button', { name: 'ENSAYO', exact: true }).click();
    await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(1, { timeout: 15000 });
    await expect(page.getByTestId('rehearsal-mixer')).not.toHaveAttribute('open', '');
    await page.getByLabel('Posición').fill('9');
    const chordpro = page.getByTestId('rehearsal-current-chordpro');
    await expect(chordpro).toContainText('noche se queda despierta');
    const box = await chordpro.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    // La linea larga ocupa varios renglones en vez de desplazarse a lo ancho.
    expect(box!.height).toBeGreaterThan(120);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

/** Medianoche en Pereira (124 BPM 4/4, Am) con 40 s de stems, abierta en ENSAYO. */
async function rehearseMedianoche(page: Page) {
  await enterDemo(page);
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

/** Quita el foco de cualquier control (los atajos actuan sobre la pagina). */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test.describe('Web Admin Hub 2.3 - ENSAYO: atajos y prompter', () => {
  test('teclado: espacio, compases, secciones, repetir, tamano, transponer, vista, mezcla, atajos y foco', async ({ page }) => {
    await rehearseMedianoche(page);
    const current = page.getByTestId('rehearsal-current');
    const bar = page.getByTestId('rehearsal-bar');
    const prompter = page.getByTestId('rehearsal-prompter');

    // 9 s = compas 5.65: Estrofa 1, tercer tiempo encendido, compas 1 de 8 de la seccion.
    await page.getByLabel('Posición').fill('9');
    await blur(page);
    await expect(bar).toHaveText('COMPÁS 5');
    await expect(page.getByTestId('rehearsal-pulse').locator('.rh-beat')).toHaveCount(4);
    await expect(page.getByTestId('rehearsal-pulse').locator('.rh-beat').nth(2)).toHaveAttribute('data-on', '1');
    await expect(page.getByTestId('rehearsal-progress-text')).toHaveText('compás 1 de 8');

    // Flechas: un compas; Shift, cuatro.
    await page.keyboard.press('ArrowRight');
    await expect(bar).toHaveText('COMPÁS 6');
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(bar).toHaveText('COMPÁS 2');
    await expect(current).toHaveAttribute('data-label', 'Intro');

    // Secciones: abajo = siguiente; arriba al empezar una = la anterior; numeros = la seccion n.
    await page.keyboard.press('ArrowDown');
    await expect(current).toHaveAttribute('data-label', 'Estrofa 1');
    await page.keyboard.press('ArrowDown');
    await expect(current).toHaveAttribute('data-label', 'Coro');
    await page.keyboard.press('ArrowUp');
    await expect(current).toHaveAttribute('data-label', 'Estrofa 1');
    await page.keyboard.press('3');
    await expect(current).toHaveAttribute('data-label', 'Coro');
    await page.keyboard.press('Home');
    await expect(current).toHaveAttribute('data-label', 'Intro');

    // Aviso de cambio en los 2 ultimos compases de la Estrofa (compases 11 y 12).
    await page.keyboard.press('2');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(bar).toHaveText('COMPÁS 11');
    await expect(page.getByTestId('rehearsal-next-countdown')).toHaveText('Coro en 2');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('rehearsal-next-countdown')).toHaveText('en 1');
    await expect(page.getByTestId('rehearsal-next')).toHaveAttribute('data-warn', '1');
    await page.keyboard.press('2');
    await expect(page.getByTestId('rehearsal-next-countdown')).toHaveCount(0);

    // Espacio: reproduce y pausa (tambien con el foco en un boton, sin activarlo).
    await page.getByRole('button', { name: 'LETRA', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'playing');
    await expect(page.getByTestId('rehearsal-current-chordpro')).toHaveAttribute('data-mode', 'chords');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'paused');
    await blur(page);

    // R: repetir y soltar la seccion actual.
    await page.keyboard.press('r');
    await expect(page.getByTestId('stem-loop-badge')).toBeVisible();
    await expect(page.getByTestId('rehearsal-loop-current')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('r');
    await expect(page.getByTestId('stem-loop-badge')).toHaveCount(0);

    // + y -: tamano guardado en localStorage.
    await expect(prompter).toHaveAttribute('data-font-step', '3');
    await page.keyboard.press('+');
    await expect(prompter).toHaveAttribute('data-font-step', '4');
    expect(await page.evaluate(() => localStorage.getItem('bandait_rehearsal_font_step'))).toBe('4');

    // T: medio tono arriba (Am -> Bbm, con bemoles); Shift+0 vuelve al original.
    const chords = page.getByTestId('rehearsal-current-chordpro').getByTestId('chordpro-chords');
    await expect(chords.first()).toHaveText('Am');
    await page.keyboard.press('t');
    await expect(chords.first()).toHaveText('Bbm');
    await expect(page.getByTestId('rehearsal-key')).toContainText('Bbm');
    await page.keyboard.press('Shift+T');
    await expect(chords.first()).toHaveText('Am');
    await page.keyboard.press('t');
    await page.keyboard.press('t');
    await expect(chords.first()).toHaveText('Bm');
    await page.keyboard.press('Shift+Digit0');
    await expect(chords.first()).toHaveText('Am');

    // L y C: vista de letra y de acordes.
    await page.keyboard.press('l');
    await expect(page.getByTestId('rehearsal-current-chordpro')).toHaveAttribute('data-mode', 'lyrics');
    await page.keyboard.press('c');
    await expect(page.getByTestId('rehearsal-current-chordpro')).toHaveAttribute('data-mode', 'chords');

    // M: plegar y abrir la mezcla.
    const mixer = page.getByTestId('rehearsal-mixer');
    await expect(mixer).toHaveAttribute('open', '');
    await page.keyboard.press('m');
    await expect(mixer).not.toHaveAttribute('open', '');
    await page.keyboard.press('m');
    await expect(mixer).toHaveAttribute('open', '');

    // ?: panel de atajos accesible; mientras esta abierto, las teclas no actuan; Esc lo cierra.
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'ATAJOS DE TECLADO' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Reproducir o pausar');
    await expect(dialog.getByRole('button', { name: 'Cerrar' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cerrar' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(current).toHaveAttribute('data-label', 'Estrofa 1');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // F: modo foco; Esc sale.
    await blur(page);
    await page.keyboard.press('f');
    await expect(prompter).toHaveAttribute('data-focus', 'true');
    await expect(page.getByTestId('rehearsal-focus-play')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(prompter).toHaveAttribute('data-focus', 'false');

    // Escribiendo en un campo, las letras no son atajos.
    await page.getByTestId('stem-offset').focus();
    await page.keyboard.press('f');
    await expect(prompter).toHaveAttribute('data-focus', 'false');
  });

  test.describe('telefono tactil', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('390 px: barra de herramientas sin scroll, foco con transporte minimo y tercios que cambian de seccion', async ({ page }) => {
      await rehearseMedianoche(page);
      const current = page.getByTestId('rehearsal-current');
      await expect(page.getByRole('toolbar', { name: 'Herramientas del prompter' })).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      await page.getByTestId('rehearsal-focus').tap();
      const prompter = page.getByTestId('rehearsal-prompter');
      await expect(prompter).toHaveAttribute('data-focus', 'true');
      const box = (await prompter.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(389);
      await expect(page.getByRole('group', { name: 'Transporte' })).toBeVisible();

      await expect(current).toHaveAttribute('data-label', 'Intro');
      const body = page.locator('.rh-stage-body');
      const area = (await body.boundingBox())!;
      await body.tap({ position: { x: area.width * 0.9, y: 30 } });
      await expect(current).toHaveAttribute('data-label', 'Estrofa 1');
      await body.tap({ position: { x: area.width * 0.9, y: 30 } });
      await expect(current).toHaveAttribute('data-label', 'Coro');
      await body.tap({ position: { x: area.width * 0.1, y: 30 } });
      await expect(current).toHaveAttribute('data-label', 'Estrofa 1');
      // El centro no cambia de seccion.
      await body.tap({ position: { x: area.width * 0.5, y: 30 } });
      await expect(current).toHaveAttribute('data-label', 'Estrofa 1');

      await page.getByRole('button', { name: 'Salir del modo foco' }).tap();
      await expect(prompter).toHaveAttribute('data-focus', 'false');
    });
  });
});

// ------------------------------------------------------------------ Analizar con IA

const DRAFT = {
  source: 'music.ai',
  bpm: 128,
  key: 'C#m',
  beats_per_bar: 4,
  sections: [
    { kind: 'intro', label: 'Intro', bars: 4, start_bar: 1, chordpro: '[C#m]    [A]    [E]    [B]', cue_text: null },
    { kind: 'verse', label: 'Estrofa 1', bars: 8, start_bar: 5, chordpro: '[C#m]    [A]\n[E]    [B]', cue_text: null },
    { kind: 'chorus', label: 'Coro', bars: 8, start_bar: 13, chordpro: '[A]    [B]    [C#m]', cue_text: null },
  ],
  lyrics_unplaced: ['Primera linea sin tiempo', 'Segunda linea sin tiempo'],
  notes: ['La letra llegó sin tiempos: quedó sin ubicar.'],
};

interface AnalysisCall {
  method: string;
  type: string | undefined;
  size: number;
  head: string;
}

/** Worker con lo minimo: manifiestos de stems (subida al guardar) y la ruta de analisis. */
class FakeAnalysisWorker {
  calls: AnalysisCall[] = [];
  /** Respuestas sucesivas del GET .../analysis (la ultima se repite). */
  getReplies: Array<{ status: number; body: unknown }> = [{ status: 404, body: { error: 'no_analysis' } }];
  postReply: { status: number; body: unknown } = { status: 202, body: { status: 'STARTED', job_id: 'job-e2e' } };

  async install(page: Page) {
    await page.route(`${STEMS}/**`, (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const req = route.request();
    const origin = (await req.headerValue('origin')) ?? 'http://localhost:5173';
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
    };
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const path = new URL(req.url()).pathname;
    if (path.endsWith('/analysis')) {
      const body = req.postDataBuffer();
      this.calls.push({ method, type: await req.headerValue('content-type') ?? undefined, size: body?.length ?? 0, head: body ? body.subarray(0, 4).toString('latin1') : '' });
      if (method === 'POST') return json(this.postReply.status, this.postReply.body);
      const reply = this.getReplies.length > 1 ? this.getReplies.shift()! : this.getReplies[0];
      return json(reply.status, reply.body);
    }
    if (path.endsWith('/manifest')) {
      if (method === 'GET') return json(404, { error: 'no_stems' });
      return json(200, { ...req.postDataJSON(), updated_at: '2026-10-31T12:00:00.000Z' });
    }
    if (method === 'PUT') return json(200, { file: 'x', size: req.postDataBuffer()?.length ?? 0 });
    return json(404, { error: 'not_found' });
  }
}

/** Cuenta de nube (Owner de su workspace personal) con stems de "Tema A" en este equipo; abre su editor. */
async function openEditorWithStems(page: Page, worker: FakeAnalysisWorker) {
  const fake = new FakeSupabase();
  fake.workspaces.push({ user_id: USER.id, workspace: workspaceWith('band_daniel_01', 'Banda de Daniel', ['Tema A']), updated_at: fake.now() });
  await worker.install(page);
  await signInWithFakeCloud(page, fake);
  await expect(page.getByTestId('band-switcher')).toContainText('Banda de Daniel');
  await page.getByRole('button', { name: 'PISTAS', exact: true }).click();
  await page.getByTestId('stem-file-input').setInputFiles([
    { name: 'Tema A - Vocals.wav', mimeType: 'audio/wav', buffer: wav(3, 440) },
    { name: 'Tema A - Bass.wav', mimeType: 'audio/wav', buffer: wav(3, 110) },
    { name: 'click.wav', mimeType: 'audio/wav', buffer: wav(3, 1000) },
  ]);
  await page.getByTestId('stem-save').click();
  await expect(page.getByTestId('stem-cloud-status')).toHaveText(/EN LA NUBE/, { timeout: 15000 });
  await page.getByRole('button', { name: 'CANCIONES', exact: true }).click();
  await page.getByTestId('song-card').filter({ hasText: 'Tema A' }).getByRole('button', { name: 'EDITAR' }).click();
  const editor = page.getByTestId('song-editor');
  await expect(editor.getByTestId('song-analysis')).toBeVisible();
  return editor;
}

test.describe('Web Admin Hub 2.3 - ANALIZAR CON IA (Worker simulado)', () => {
  test('sin analisis previo: mezcla WAV, POST, STARTED, SUCCEEDED y ACEPTAR reemplaza las secciones', async ({ page }) => {
    test.setTimeout(60_000);
    const worker = new FakeAnalysisWorker();
    worker.getReplies = [
      { status: 404, body: { error: 'no_analysis' } },
      { status: 200, body: { status: 'STARTED', job_id: 'job-e2e' } },
      { status: 200, body: { status: 'SUCCEEDED', job_id: 'job-e2e', created_at: '2026-10-31T15:00:00.000Z', draft: DRAFT } },
    ];
    const editor = await openEditorWithStems(page, worker);
    const panel = editor.getByTestId('song-analysis');
    await expect(panel).toHaveAttribute('data-phase', 'none');
    await panel.getByTestId('analysis-start').click();
    await expect(panel).toHaveAttribute('data-phase', 'running', { timeout: 15000 });
    await expect(panel.getByTestId('analysis-draft')).toBeVisible({ timeout: 15000 });

    // GET (no_analysis), POST con la mezcla, GET (STARTED) y GET (SUCCEEDED) a los 5 s.
    expect(worker.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET', 'GET']);
    const post = worker.calls[1];
    expect(post.type).toBe('audio/wav');
    expect(post.head).toBe('RIFF');
    // Mono 16 bits a 22 050 Hz: 3 s = 44 + 2 * 66 150 bytes.
    expect(post.size).toBe(44 + 2 * 3 * 22050);

    await expect(panel.getByTestId('analysis-section')).toHaveCount(3);
    await expect(panel.getByTestId('analysis-draft')).toContainText('Primera linea sin tiempo');
    await expect(panel.getByTestId('analysis-apply-bpm')).not.toBeChecked();
    await expect(panel.getByTestId('analysis-apply-key')).not.toBeChecked();
    await panel.getByTestId('analysis-apply-bpm').check();
    await panel.getByTestId('analysis-accept').click();
    await expect(panel.getByTestId('analysis-accepted')).toContainText('3 secciones');

    await expect(editor.getByTestId('section-row')).toHaveCount(3);
    await expect(editor.getByLabel('Etiqueta de la sección 3')).toHaveValue('Coro');
    await expect(editor.getByLabel('BPM (40-260)')).toHaveValue('128');
    await expect(editor.getByLabel('TONO ORIGINAL')).toHaveValue('Am');
    await expect(editor.getByTestId('song-total-bars')).toHaveText('20');

    await editor.getByTestId('song-save').click();
    await expect(page.getByTestId('song-card').filter({ hasText: 'Tema A' }).getByTestId('song-card-sections')).toContainText('3 secciones · 20 compases');
  });

  test('con un borrador guardado (lanzado desde el lider) lo muestra con su fecha y no sube nada', async ({ page }) => {
    const worker = new FakeAnalysisWorker();
    worker.getReplies = [{ status: 200, body: { status: 'SUCCEEDED', job_id: 'job-lider', created_at: '2026-10-30T20:15:00.000Z', draft: DRAFT } }];
    const editor = await openEditorWithStems(page, worker);
    const panel = editor.getByTestId('song-analysis');
    await expect(panel.getByTestId('analysis-draft')).toBeVisible();
    await expect(panel.getByTestId('analysis-draft')).toContainText(/BORRADOR DEL .*2026/);
    await expect(panel.getByTestId('analysis-start')).toHaveText(/ANALIZAR DE NUEVO/);
    expect(worker.calls.map((c) => c.method)).toEqual(['GET']);
    await panel.getByTestId('analysis-dismiss').click();
    await expect(editor.getByTestId('section-row')).toHaveCount(0);
    expect(worker.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  test('un 403 del analisis muestra que solo Owner o Director pueden analizar', async ({ page }) => {
    const worker = new FakeAnalysisWorker();
    worker.getReplies = [{ status: 404, body: { error: 'no_analysis' } }];
    worker.postReply = { status: 403, body: { error: 'not_an_editor' } };
    const editor = await openEditorWithStems(page, worker);
    const panel = editor.getByTestId('song-analysis');
    await panel.getByTestId('analysis-start').click();
    await expect(panel.getByTestId('analysis-error')).toHaveText(
      'Solo el Owner o el Director musical de la banda pueden analizar canciones con IA.',
      { timeout: 15000 }
    );
    await expect(editor.getByTestId('section-row')).toHaveCount(0);
  });

  test('sin stems en este equipo ni en la nube: ANALIZAR deshabilitado con el motivo', async ({ page }) => {
    const worker = new FakeAnalysisWorker();
    const fake = new FakeSupabase();
    fake.workspaces.push({ user_id: USER.id, workspace: workspaceWith('band_daniel_01', 'Banda de Daniel', ['Tema A']), updated_at: fake.now() });
    await worker.install(page);
    await signInWithFakeCloud(page, fake);
    await page.getByRole('button', { name: 'CANCIONES', exact: true }).click();
    await page.getByTestId('song-card').filter({ hasText: 'Tema A' }).getByRole('button', { name: 'EDITAR' }).click();
    const panel = page.getByTestId('song-editor').getByTestId('song-analysis');
    await expect(panel).toHaveAttribute('data-phase', 'none');
    await expect(panel.getByTestId('analysis-no-stems')).toContainText('ni en la nube');
    await expect(panel.getByTestId('analysis-start')).toBeDisabled();
    expect(worker.calls.map((c) => c.method)).toEqual(['GET']);
  });
});
