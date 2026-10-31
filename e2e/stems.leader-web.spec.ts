import { test, expect, type Page } from '@playwright/test';
import { deflateRawSync } from 'node:zlib';

/**
 * E2E del estudio de stems del hub (vista PISTAS). Los archivos se generan en la prueba (WAV
 * sinteticos de 3 s y un ZIP armado a mano, con entradas deflate como las de Moises): no hay binarios versionados. Todo corre en
 * MODO DEMO; el audio queda en IndexedDB del contexto aislado de Playwright.
 */

const SAMPLE_RATE = 8000;

/** WAV PCM 16-bit mono con un seno de `freq` Hz. */
function wav(seconds: number, freq: number): Buffer {
  const samples = Math.round(seconds * SAMPLE_RATE);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 8000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP minimo: metodo 8 (deflate, como Moises) o 0 (stored) por entrada. */
function buildZip(entries: Array<{ name: string; data: Buffer; stored?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const method = e.stored ? 0 : 8;
    const body = e.stored ? e.data : deflateRawSync(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nombres UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

async function enterDemoStems(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-toggle').click();
  await page.getByTestId('demo-profiles').getByRole('button', { name: /Carlos Mendoza/ }).click();
  await expect(page.getByText('BANDAIT', { exact: true }).first()).toBeVisible();
  const bottom = page.locator('nav.hub-mobile-nav');
  if (await bottom.isVisible()) await bottom.getByRole('button', { name: 'PISTAS', exact: true }).click();
  else await page.getByRole('button', { name: 'PISTAS', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Estudio de Stems' })).toBeVisible();
}

function moisesZip(): Buffer {
  return buildZip([
    { name: 'Medianoche en Pereira/Medianoche en Pereira - Vocals.wav', data: wav(3, 440) },
    { name: 'Medianoche en Pereira/Medianoche en Pereira - Backing Vocals.wav', data: wav(3, 550), stored: true },
    { name: '__MACOSX/Medianoche en Pereira/._Medianoche en Pereira - Vocals.wav', data: Buffer.from('basura') },
    { name: 'Medianoche en Pereira/cover.jpg', data: Buffer.from('no es imagen') },
  ]);
}

/** Horizontal: > 0 significa scroll horizontal de la pagina. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('Web Admin Hub - estudio de stems', () => {
  test('importa ZIP y archivos sueltos, corrige el rol desconocido, reproduce, repite una sección y borra', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await enterDemoStems(page);
    await page.getByTestId('stem-song-select').selectOption({ label: 'Medianoche en Pereira' });
    const importer = page.getByTestId('stem-importer');
    await expect(importer).toBeVisible();

    await page.getByTestId('stem-file-input').setInputFiles([
      { name: 'Medianoche Moises.zip', mimeType: 'application/zip', buffer: moisesZip() },
      { name: 'Medianoche en Pereira_drums.wav', mimeType: 'audio/wav', buffer: wav(3, 110) },
      { name: 'Medianoche en Pereira (Bass).wav', mimeType: 'audio/wav', buffer: wav(3, 82) },
      { name: 'Track 7.wav', mimeType: 'audio/wav', buffer: wav(3, 660) },
      { name: 'Guitarra Eléctrica.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('esto no es un mp3 valido '.repeat(40)) },
      { name: 'notas.txt', mimeType: 'text/plain', buffer: Buffer.from('apuntes') },
    ]);

    const candidates = importer.getByTestId('stem-candidate');
    await expect(candidates).toHaveCount(6);
    const roles = await candidates.evaluateAll((els) => els.map((e) => `${e.getAttribute('data-file')}=${e.getAttribute('data-role')}`));
    expect(roles.sort()).toEqual(
      [
        'Medianoche en Pereira - Vocals.wav=vocals',
        'Medianoche en Pereira - Backing Vocals.wav=backing_vocals',
        'Medianoche en Pereira_drums.wav=drums',
        'Medianoche en Pereira (Bass).wav=bass',
        'Track 7.wav=unknown',
        'Guitarra Eléctrica.mp3=guitar',
      ].sort()
    );
    await expect(importer.getByTestId('stem-import-ignored')).toContainText('notas.txt');
    await expect(importer.getByTestId('stem-import-ignored')).toContainText('cover.jpg');
    await expect(importer.getByTestId('stem-import-ignored')).not.toContainText('__MACOSX');

    // Con una pista sin rol no se puede guardar; al elegirlo, si.
    const save = importer.getByTestId('stem-save');
    await expect(save).toBeDisabled();
    await importer.getByLabel('Rol de Track 7.wav').selectOption('keys');
    await expect(importer.locator('[data-file="Track 7.wav"]')).toHaveAttribute('data-role', 'keys');
    await expect(save).toBeEnabled();
    await save.click();

    const studio = page.getByTestId('stem-studio');
    await expect(studio).toBeVisible();
    const tracks = studio.getByTestId('stem-track');
    await expect(tracks).toHaveCount(6);
    await expect(studio.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(5, { timeout: 15000 });
    // El "mp3" corrupto muestra su error sin romper la vista.
    const broken = studio.locator('[data-testid="stem-track"][data-role="guitar"]');
    await expect(broken).toHaveAttribute('data-status', 'error');
    await expect(broken.getByTestId('stem-track-error')).toContainText('No se pudo decodificar');

    // Reproduce, avanza y se detiene.
    await expect(studio).toHaveAttribute('data-state', 'stopped');
    await page.getByTestId('stem-play').click();
    await expect(studio).toHaveAttribute('data-state', 'playing');
    await expect(page.getByTestId('stem-position')).not.toHaveText(/^0:00\.0 \//, { timeout: 5000 });
    await page.getByTestId('stem-stop').click();
    await expect(studio).toHaveAttribute('data-state', 'stopped');
    await expect(page.getByTestId('stem-position')).toHaveText(/^0:00\.0 \/ 0:03\.0$/);

    // Mute y solo cambian de estado (aria-pressed).
    const drums = studio.locator('[data-testid="stem-track"][data-role="drums"]');
    await drums.getByRole('button', { name: /^Silenciar/ }).click();
    await expect(drums.getByRole('button', { name: /^Silenciar/ })).toHaveAttribute('aria-pressed', 'true');

    // Repetir la Intro (seccion de la cancion demo): el loop se aplica y sigue sonando.
    const loopSelect = page.getByTestId('stem-loop-select');
    const introValue = await loopSelect.locator('option', { hasText: 'Intro' }).getAttribute('value');
    expect(introValue).toMatch(/^sec:/);
    await loopSelect.selectOption(introValue as string);
    await expect(page.getByTestId('stem-loop-badge')).toBeVisible();
    await page.getByTestId('stem-play').click();
    await expect(studio).toHaveAttribute('data-state', 'playing');
    // La Intro dura mas que el audio de 3 s: el loop se recorta y nunca termina solo.
    await page.waitForTimeout(3600);
    await expect(studio).toHaveAttribute('data-state', 'playing');
    await page.getByTestId('stem-play').click();
    await expect(studio).toHaveAttribute('data-state', 'paused');

    // Persisten al recargar (IndexedDB) y se pueden borrar.
    await page.reload();
    await expect(page.getByText('BANDAIT', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'PISTAS', exact: true }).click();
    await expect(page.getByTestId('stem-song-select')).toContainText('Medianoche en Pereira · 6 stems');
    await expect(page.getByTestId('stem-studio').getByTestId('stem-track')).toHaveCount(6);

    await page.getByTestId('stem-delete-song').click();
    await page.getByTestId('stem-delete-confirm').getByRole('button', { name: 'BORRAR' }).click();
    await expect(page.getByTestId('stem-studio')).toHaveCount(0);
    await expect(page.getByTestId('stem-importer')).toBeVisible();
    const left = await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const req = indexedDB.open('bandait_stems');
          req.onsuccess = () => {
            const tx = req.result.transaction('files', 'readonly');
            const count = tx.objectStore('files').count();
            count.onsuccess = () => resolve(count.result);
            count.onerror = () => reject(count.error);
          };
          req.onerror = () => reject(req.error);
        })
    );
    expect(left).toBe(0);
    expect(consoleErrors).toEqual([]);
  });

  test('un ZIP dañado muestra un error legible y la vista sigue funcionando', async ({ page }) => {
    await enterDemoStems(page);
    await page.getByTestId('stem-file-input').setInputFiles([
      { name: 'roto.zip', mimeType: 'application/zip', buffer: Buffer.from('PK esto no es un zip') },
      { name: 'click track.wav', mimeType: 'audio/wav', buffer: wav(1, 1000) },
    ]);
    await expect(page.getByTestId('stem-import-errors')).toContainText('roto.zip: no se pudo leer el ZIP');
    await expect(page.getByTestId('stem-candidate')).toHaveCount(1);
    await expect(page.getByTestId('stem-candidate')).toHaveAttribute('data-role', 'click');
  });

  test('390 px: importador y estudio sin scroll horizontal; al salir de la vista cierra el AudioContext', async ({ page }) => {
    // Registra cada AudioContext que crea la pagina para comprobar que se cierra al salir.
    await page.addInitScript(() => {
      const Original = window.AudioContext;
      const created: AudioContext[] = [];
      (window as unknown as { __stemCtxs: AudioContext[] }).__stemCtxs = created;
      window.AudioContext = class extends Original {
        constructor(options?: AudioContextOptions) {
          super(options);
          created.push(this);
        }
      };
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await enterDemoStems(page);
    await page.getByTestId('stem-song-select').selectOption({ label: 'Medianoche en Pereira' });
    await page.getByTestId('stem-file-input').setInputFiles([
      { name: 'Medianoche Moises.zip', mimeType: 'application/zip', buffer: moisesZip() },
      { name: 'Track 7.wav', mimeType: 'audio/wav', buffer: wav(2, 660) },
    ]);
    await expect(page.getByTestId('stem-candidate')).toHaveCount(3);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.getByLabel('Rol de Track 7.wav').selectOption('click');
    await page.getByTestId('stem-save').click();
    await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(3, { timeout: 15000 });
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await page.getByTestId('stem-play').click();
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'playing');
    await page.locator('nav.hub-mobile-nav').getByRole('button', { name: 'SETLISTS' }).click();
    await expect(page.getByTestId('stem-studio')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __stemCtxs: AudioContext[] }).__stemCtxs.map((c) => c.state)))
      .toEqual(['closed']);
  });
});
