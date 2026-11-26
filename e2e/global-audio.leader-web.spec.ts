import { test, expect, type Page } from '@playwright/test';

/**
 * E2E del audio global del Hub (docs/REQUERIMIENTOS_WEB_3.0.md, secciones 3 y 5): el reproductor de
 * stems y la sesion del Estudio sobreviven al cambio de vista, se excluyen entre si y la cola
 * Drop & Split recuerda lo que quedo a medias al recargar. Todo en MODO DEMO, con WAV sinteticos
 * generados en la prueba (sin binarios versionados ni red).
 */

const SAMPLE_RATE = 8000;

/** WAV PCM 16-bit mono con un seno de `freq` Hz. */
function wav(seconds: number, freq: number): Buffer {
  const samples = Math.round(seconds * SAMPLE_RATE);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 8000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Registra cada AudioContext que crea la pagina. */
async function trackAudioContexts(page: Page) {
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    const created: AudioContext[] = [];
    (window as unknown as { __ctxs: AudioContext[] }).__ctxs = created;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        created.push(this);
      }
    };
  });
}

function ctxStates(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __ctxs: AudioContext[] }).__ctxs.map((c) => c.state));
}

/** Va a una vista por su boton de navegacion (barra superior o barra inferior movil). */
async function goTo(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).first().click();
}

async function enterDemo(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-toggle').click();
  await page.getByTestId('demo-profiles').getByRole('button', { name: /Carlos Mendoza/ }).click();
  await expect(page.getByText('BANDAIT', { exact: true }).first()).toBeVisible();
}

/** Carga dos stems de 20 s a "Medianoche en Pereira" en PISTAS y espera a que decodifiquen. */
async function loadStems(page: Page) {
  await goTo(page, 'PISTAS');
  await page.getByTestId('stem-song-select').selectOption({ label: 'Medianoche en Pereira' });
  await page.getByTestId('stem-file-input').setInputFiles([
    { name: 'Medianoche en Pereira_drums.wav', mimeType: 'audio/wav', buffer: wav(20, 110) },
    { name: 'Medianoche en Pereira (Bass).wav', mimeType: 'audio/wav', buffer: wav(20, 82) },
  ]);
  await page.getByTestId('stem-save').click();
  await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(2, { timeout: 15000 });
}

/** Segundos de la posicion "m:ss.d / m:ss.d" del transporte de stems. */
async function positionSec(page: Page): Promise<number> {
  const text = (await page.getByTestId('stem-position').textContent()) ?? '';
  const m = /^(\d+):(\d+(?:\.\d+)?)/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
}

test.describe('Web Admin Hub - audio global', () => {
  test('el audio sobrevive al cambio de vista y vuelve con su posicion, velocidad y mezcla', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await trackAudioContexts(page);
    await enterDemo(page);
    await loadStems(page);

    // Velocidad 0,80x y bateria en mute; a sonar.
    await page.getByTestId('stem-speed-exact').fill('0,80');
    await page.getByTestId('stem-speed-exact').press('Enter');
    const drums = page.locator('[data-testid="stem-track"][data-role="drums"]');
    await drums.getByRole('button', { name: /^Silenciar/ }).click();
    await page.getByTestId('stem-play').click();
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'playing');
    await page.waitForTimeout(600);
    const before = await positionSec(page);

    // Otra vista: el reproductor no se desmonta del audio global y su AudioContext sigue abierto.
    await goTo(page, 'SETLISTS');
    await expect(page.getByTestId('stem-studio')).toHaveCount(0);
    await page.waitForTimeout(1200);
    expect(await ctxStates(page)).toEqual(['running']);

    // Volver: la misma cancion, sonando, mas adelante, con la velocidad y el mute de antes.
    await goTo(page, 'PISTAS');
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'playing');
    await expect(page.getByTestId('stem-song-select').locator('option:checked')).toContainText('Medianoche en Pereira');
    // El reloj del AudioContext puede tardar en arrancar bajo automatizacion: se espera a que avance.
    await expect.poll(() => positionSec(page), { timeout: 5000 }).toBeGreaterThan(before + 0.3);
    await expect(page.getByTestId('stem-speed-exact')).toHaveValue('0,80x');
    await expect(drums.getByRole('button', { name: /^Silenciar/ })).toHaveAttribute('aria-pressed', 'true');

    // ENSAYO elige por defecto la cancion que suena y usa el mismo reproductor (no crea otro).
    await goTo(page, 'ENSAYO');
    await expect(page.getByTestId('rehearsal-song-select').locator('option:checked')).toContainText('Medianoche en Pereira');
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'playing');
    await expect(page.getByTestId('stem-speed-exact')).toHaveValue('0,80x');
    // El tono de ENSAYO tambien vuelve al regresar.
    await page.getByRole('button', { name: 'Subir el tono del audio medio tono' }).click();
    await expect(page.getByTestId('stem-pitch-value')).toHaveText('+1 st');
    await page.getByTestId('stem-play').click();
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'paused');
    await goTo(page, 'CANCIONES');
    await goTo(page, 'ENSAYO');
    await expect(page.getByTestId('stem-pitch-value')).toHaveText('+1 st');
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'paused');
    expect(await ctxStates(page)).toEqual(['running']);

    // Borrar los stems libera el reproductor y cierra su AudioContext.
    await goTo(page, 'PISTAS');
    await page.getByTestId('stem-delete-song').click();
    await page.getByTestId('stem-delete-confirm').getByRole('button', { name: 'BORRAR' }).click();
    await expect(page.getByTestId('stem-studio')).toHaveCount(0);
    await expect.poll(() => ctxStates(page)).toEqual(['closed']);
    expect(errors).toEqual([]);
  });

  test('la sesion del Estudio sigue abierta y sonando fuera de su vista; Estudio y stems no suenan a la vez', async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => localStorage.setItem('bandait_studio', '1'));
    await trackAudioContexts(page);
    await enterDemo(page);
    await loadStems(page);

    await goTo(page, 'ESTUDIO');
    await expect(page.getByTestId('studio-home')).toBeVisible();
    await page.getByTestId('studio-new-song').selectOption({ label: 'Medianoche en Pereira' });
    await page.getByTestId('studio-new-title').fill('Audio global');
    await page.getByTestId('studio-create').click();
    await expect(page.getByTestId('studio-workspace')).toBeVisible();
    await expect(page.getByTestId('studio-play')).toBeEnabled({ timeout: 20000 });
    // Espera a que los stems importados queden como clips (la duracion deja de ser 0).
    await page.waitForTimeout(2500);
    await page.getByTestId('studio-play').click();
    await expect(page.getByTestId('studio-status')).toHaveText('REPRODUCIENDO');

    // Fuera de la vista: la sesion no se cierra ni se detiene.
    await goTo(page, 'SETLISTS');
    await page.waitForTimeout(800);
    await goTo(page, 'ESTUDIO');
    await expect(page.getByTestId('studio-workspace')).toBeVisible();
    await expect(page.getByTestId('studio-title')).toHaveValue('Audio global');
    await expect(page.getByTestId('studio-status')).toHaveText('REPRODUCIENDO');

    // Arrancar los stems pausa el Estudio...
    await goTo(page, 'PISTAS');
    await page.getByTestId('stem-play').click();
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'playing');
    await goTo(page, 'ESTUDIO');
    await expect(page.getByTestId('studio-status')).toHaveText('DETENIDO');
    // ... y arrancar el Estudio pausa los stems.
    await page.getByTestId('studio-play').click();
    await expect(page.getByTestId('studio-status')).toHaveText('REPRODUCIENDO');
    await goTo(page, 'PISTAS');
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'paused');

    // Cerrar la sesion explicitamente libera su motor (su AudioContext se cierra); los stems siguen.
    await goTo(page, 'ESTUDIO');
    const closedBefore = (await ctxStates(page)).filter((s) => s === 'closed').length;
    await page.getByTestId('studio-back').click();
    await expect(page.getByTestId('studio-home')).toBeVisible();
    await expect.poll(async () => (await ctxStates(page)).filter((s) => s === 'closed').length).toBeGreaterThan(closedBefore);
    await goTo(page, 'PISTAS');
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'paused');
  });

  test('cola Drop & Split: al recargar, lo que separaba queda interrumpido y se puede limpiar', async ({ page }) => {
    await enterDemo(page);
    // Historial como lo deja la cola si la pagina se cierra a mitad de una separacion (sin archivo).
    await page.evaluate(() => {
      const now = Date.now();
      localStorage.setItem(
        'bandait_split_queue_v1:usr_director_01',
        JSON.stringify([
          { id: 'a', band: 'me', songId: 'x1', songTitle: 'Corazón de neón', fileName: 'corazon.flac', fileSize: 1000, status: 'done', uploaded: true, importLocal: false, local: 'saved', stemCount: 6, localCount: 6, createdAt: now, updatedAt: now },
          { id: 'b', band: 'me', songId: 'x2', songTitle: 'Luz de madrugada', fileName: 'luz.mp3', fileSize: 1000, status: 'uploading', uploaded: false, importLocal: false, local: 'none', createdAt: now, updatedAt: now },
        ])
      );
    });
    await page.reload();
    await goTo(page, 'PISTAS');
    const toggle = page.getByTestId('split-queue-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();
    const items = page.getByTestId('split-queue-item');
    await expect(items).toHaveCount(2);
    await expect(items.first()).toHaveAttribute('data-status', 'interrupted');
    await expect(items.first()).toContainText('Se interrumpió al recargar o cerrar la página.');
    // Sin subir no hay archivo que reintentar: se pide volver a elegirlo.
    await expect(items.first()).toContainText('vuelve a elegir el audio');
    await expect(items.nth(1)).toHaveAttribute('data-status', 'done');
    await page.getByTestId('split-queue-clear').click();
    await expect(page.getByTestId('split-queue')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('bandait_split_queue_v1:usr_director_01'))).toBe('[]');
  });
});
