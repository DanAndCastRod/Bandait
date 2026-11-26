import { readFileSync } from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';
import { FakeSupabase, USER, signInWithFakeCloud, workspaceWith } from './support/fakeSupabase';
import { openView } from './support/hubNav';

/**
 * E2E del Estudio Bandait (pestana ESTUDIO del hub, detras del interruptor `bandait_studio`).
 *
 * - Los WAV se generan en la prueba: no hay binarios versionados.
 * - La grabacion usa el microfono simulado de Chrome (playwright.config.ts lanza el proyecto
 *   leader-web con --use-fake-device-for-media-stream y --use-fake-ui-for-media-stream).
 * - El Worker bandait-stems se SIMULA con page.route sobre https://stems.e2e.invalid, igual que en
 *   stems-cloud.leader-web.spec.ts. Ninguna prueba toca R2, Supabase ni un proveedor de IA reales.
 * - Sesiones y audios quedan en IndexedDB y OPFS del contexto aislado de Playwright.
 */

const STEMS = 'https://stems.e2e.invalid';
const SAMPLE_RATE = 8000;
/** Pixeles por segundo de la linea de tiempo al abrir (DEFAULT_ZOOM de StudioTimeline). */
const ZOOM = 36;
/** Una altura dentro del carril de la primera pista del canvas (regla de 46 px + carril de 112). */
const ROW_Y = 100;

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

interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  bits: number;
  dataBytes: number;
  seconds: number;
  /** Mayor valor absoluto de las muestras, en la escala del formato. */
  peak: number;
}

/** Lee un WAV PCM y falla si la cabecera no es coherente con el tamano del archivo. */
function readWav(file: Buffer): WavInfo {
  expect(file.toString('latin1', 0, 4)).toBe('RIFF');
  expect(file.toString('latin1', 8, 12)).toBe('WAVE');
  expect(file.readUInt32LE(4)).toBe(file.length - 8);
  let at = 12;
  let fmt: { format: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bits: number } | null = null;
  while (at + 8 <= file.length) {
    const id = file.toString('latin1', at, at + 4);
    const size = file.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      fmt = {
        format: file.readUInt16LE(at + 8),
        channels: file.readUInt16LE(at + 10),
        sampleRate: file.readUInt32LE(at + 12),
        byteRate: file.readUInt32LE(at + 16),
        blockAlign: file.readUInt16LE(at + 20),
        bits: file.readUInt16LE(at + 22),
      };
    }
    if (id === 'data') {
      if (!fmt) throw new Error('el bloque data llego antes que fmt');
      expect(at + 8 + size).toBe(file.length);
      expect(fmt.blockAlign).toBe((fmt.channels * fmt.bits) / 8);
      expect(fmt.byteRate).toBe(fmt.sampleRate * fmt.blockAlign);
      expect(size % fmt.blockAlign).toBe(0);
      const bytes = fmt.bits / 8;
      let peak = 0;
      for (let i = at + 8; i + bytes <= file.length; i += bytes) {
        const v = bytes === 3 ? file.readIntLE(i, 3) : file.readInt16LE(i);
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
      return { format: fmt.format, channels: fmt.channels, sampleRate: fmt.sampleRate, bits: fmt.bits, dataBytes: size, seconds: size / fmt.byteRate, peak };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('el WAV no tiene bloque data');
}

async function enterDemo(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-toggle').click();
  await page.getByTestId('demo-profiles').getByRole('button', { name: /Carlos Mendoza/ }).click();
  await expect(page.getByTestId('hub-logo')).toBeVisible();
}

/** Enciende el interruptor del Estudio en este navegador, antes de que cargue el hub. */
async function enableStudio(page: Page) {
  await page.addInitScript(() => localStorage.setItem('bandait_studio', '1'));
}

async function openStudioHome(page: Page) {
  await openView(page, 'studio');
  await expect(page.getByTestId('studio-home')).toBeVisible();
}

/** Crea una maqueta libre y espera a que la sesion quede lista para importar o grabar. */
async function createFreeSession(page: Page, title: string) {
  await expect(page.getByTestId('studio-create')).toBeEnabled();
  await page.getByTestId('studio-new-title').fill(title);
  await page.getByTestId('studio-create').click();
  await expect(page.getByTestId('studio-workspace')).toBeVisible();
  await expect(page.getByTestId('studio-title')).toHaveValue(title);
  await expect(page.getByTestId('studio-status')).toHaveText('DETENIDO');
  await expect(page.getByTestId('studio-import')).toBeEnabled();
}

async function importWav(page: Page, name: string, seconds: number, freq: number) {
  await page.getByTestId('studio-import-input').setInputFiles({ name, mimeType: 'audio/wav', buffer: wav(seconds, freq) });
  await expect(page.locator('[data-testid^="studio-track-"]')).toHaveCount(1);
}

interface WorkerCall {
  method: string;
  path: string;
  ifMatch: string | undefined;
  ifNoneMatch: string | undefined;
}

/** Rutas /studio del Worker bandait-stems en memoria (STUDIO_V1.md): lista, audios y documento con ETag. */
class FakeStudioWorker {
  sessions = new Map<string, { doc: any; etag: string }>();
  assets = new Map<string, number>();
  calls: WorkerCall[] = [];
  private versions = 0;

  async install(page: Page) {
    await page.route(`${STEMS}/**`, (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const req = route.request();
    const origin = (await req.headerValue('origin')) ?? 'http://localhost:5173';
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, If-Match, If-None-Match, Range',
      'access-control-expose-headers': 'Content-Length, ETag, Content-Range, Accept-Ranges',
      vary: 'Origin',
    };
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const headers = await req.allHeaders();
    this.calls.push({ method, path: url.pathname, ifMatch: headers['if-match'], ifNoneMatch: headers['if-none-match'] });
    const json = (status: number, payload: unknown, extra: Record<string, string> = {}) =>
      route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json', ...extra }, body: JSON.stringify(payload) });
    if (!/^Bearer \S{20,}$/.test(headers['authorization'] ?? '')) return json(401, { error: 'missing_token' });
    const m = /^\/v1\/bands\/([^/]+)\/studio(?:\/([^/]+)(?:\/(session|assets\/([^/]+)))?)?$/.exec(url.pathname);
    // Lo que no es del Estudio (manifiestos de stems de otras vistas) responde "no hay".
    if (!m) return json(404, { error: 'no_stems' });
    const band = m[1];
    if (m[2] === undefined) {
      if (method !== 'GET') return json(405, { error: 'method_not_allowed' });
      const sessions = [...this.sessions.entries()]
        .filter(([key]) => key.startsWith(`${band}/`))
        .map(([, s]) => ({ id: s.doc.id, title: s.doc.title, song_id: s.doc.song_id, updated_at: s.doc.updated_at }));
      return json(200, { sessions });
    }
    const key = `${band}/${m[2]}`;
    if (m[3] === 'session') {
      const current = this.sessions.get(key);
      if (method === 'GET') return current ? json(200, current.doc, { etag: current.etag }) : json(404, { error: 'no_session' });
      if (method !== 'PUT') return json(405, { error: 'method_not_allowed' });
      const create = headers['if-none-match'] === '*';
      if (!create && !headers['if-match']) return json(428, { error: 'precondition_required' });
      if (create ? current !== undefined : !current || current.etag !== headers['if-match']) return json(412, { error: 'session_conflict' });
      const doc = req.postDataJSON();
      for (const asset of doc.assets) if (this.assets.get(`${key}/${asset.file}`) !== asset.size) return json(409, { error: 'missing_asset' });
      const saved = { ...doc, updated_at: '2026-11-19T15:00:00.000Z', updated_by: USER.id };
      const etag = `"v${++this.versions}"`;
      this.sessions.set(key, { doc: saved, etag });
      return json(200, saved, { etag });
    }
    if (m[4] !== undefined && method === 'PUT') {
      const body = req.postDataBuffer();
      if (!body || body.length < 1) return json(411, { error: 'length_required' });
      const assetKey = `${key}/${m[4]}`;
      const existing = this.assets.get(assetKey);
      if (existing !== undefined && existing !== body.length) return json(409, { error: 'asset_exists' });
      this.assets.set(assetKey, body.length);
      return json(200, { file: m[4], size: body.length });
    }
    return json(404, { error: 'not_found' });
  }
}

test.describe('Web Admin Hub - Estudio Bandait', () => {
  test('el Estudio aparece por defecto, sin tocar el interruptor', async ({ page }) => {
    await enterDemo(page);
    await expect(page.getByTestId('tab-songs')).toBeVisible();
    await expect(page.getByTestId('tab-studio')).toBeVisible();
  });

  test('con el apagado local (bandait_studio = 0) el Estudio no aparece en el hub', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('bandait_studio', '0'));
    await enterDemo(page);
    await expect(page.getByTestId('tab-songs')).toBeVisible();
    await expect(page.getByTestId('tab-studio')).toHaveCount(0);
    await expect(page.getByTestId('studio-home')).toHaveCount(0);
  });

  test('con el interruptor: sesión libre, importar un WAV, dividir, mover, deshacer y exportar una mezcla válida', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    const worker = new FakeStudioWorker();
    await worker.install(page);

    await enableStudio(page);
    await enterDemo(page);
    await openStudioHome(page);
    await createFreeSession(page, 'Maqueta e2e');
    await expect(page.getByText('MAQUETA LIBRE', { exact: true })).toBeVisible();

    await importWav(page, 'Riff.wav', 3, 440);
    const canvas = page.getByTestId('studio-canvas');
    const selection = page.getByTestId('studio-selection');
    const undo = page.getByTestId('studio-undo');
    await expect(undo).toHaveAttribute('title', /Importar audio/);

    // El audio entra como un clip de 3 s en el segundo 0.
    await canvas.click({ position: { x: 20, y: ROW_Y } });
    await expect(selection).toContainText('0:00.000');
    await expect(selection).toContainText('3.00 s');

    // Sin clip elegido, la flecha mueve el cabezal un compas (2 s a 120 BPM) y S divide ahi.
    await canvas.press('Escape');
    await expect(selection).toHaveText('Sin clip elegido');
    await canvas.press('ArrowRight');
    await expect(page.getByTestId('studio-position-time')).toHaveText('0:02.000');
    await page.getByTestId('studio-split').click();
    await expect(undo).toHaveAttribute('title', /Dividir clip/);

    // La segunda mitad: empieza en 2 s y dura 1 s.
    await canvas.click({ position: { x: 2.5 * ZOOM, y: ROW_Y } });
    await expect(selection).toContainText('0:02.000');
    await expect(selection).toContainText('1.00 s');
    await canvas.click({ position: { x: 20, y: ROW_Y } });
    await expect(selection).toContainText('2.00 s');

    // Mover la segunda mitad un tiempo a la derecha, y deshacerlo.
    await canvas.click({ position: { x: 2.5 * ZOOM, y: ROW_Y } });
    await page.getByTestId('studio-snap-beat').click();
    await canvas.press('ArrowRight');
    await expect(selection).toContainText('0:02.500');
    await expect(undo).toHaveAttribute('title', /Mover clip/);
    await undo.click();
    await expect(selection).toContainText('0:02.000');
    await expect(page.getByTestId('studio-redo')).toBeEnabled();
    await expect(undo).toHaveAttribute('title', /Dividir clip/);

    // Exportar la mezcla: la descarga es un WAV PCM de 24 bits coherente y con audio.
    await page.getByTestId('studio-export-open').click();
    await expect(page.getByTestId('studio-export-missing')).toHaveCount(0);
    await page.getByTestId('studio-export-run').click();
    const downloadButton = page.getByTestId('studio-export-download');
    await expect(downloadButton).toBeVisible({ timeout: 30_000 });
    const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);
    expect(download.suggestedFilename()).toMatch(/_mezcla_24bit\.wav$/);
    const info = readWav(readFileSync(await download.path()));
    expect(info.format).toBe(1);
    expect(info.bits).toBe(24);
    expect([1, 2]).toContain(info.channels);
    expect([44100, 48000, 88200, 96000]).toContain(info.sampleRate);
    // Dos mitades contiguas de un clip de 3 s: la mezcla dura 3 s, no mas ni menos.
    expect(info.seconds).toBeGreaterThan(2.95);
    expect(info.seconds).toBeLessThan(3.6);
    // El seno entra a -12 dB aprox.: la mezcla no puede salir en silencio ni saturada.
    expect(info.peak).toBeGreaterThan(0.05 * 0x7fffff);
    expect(info.peak).toBeLessThan(0x7fffff);

    // En modo demo no hay sesion de nube: el Estudio no le pide nada al Worker.
    expect(worker.calls.filter((c) => c.path.includes('/studio'))).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('graba una toma con el micrófono simulado de Chrome y queda como clip de la pista armada', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await enableStudio(page);
    await enterDemo(page);
    await openStudioHome(page);
    await createFreeSession(page, 'Toma e2e');

    // Abrir la entrada: Chrome entrega su dispositivo simulado sin pedir permiso.
    await page.getByTestId('studio-tab-device').click();
    await expect(page.getByTestId('studio-playback-only')).toHaveCount(0);
    await page.getByTestId('studio-device-list').click();
    await expect(page.getByTestId('studio-device-select')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('studio-device-open').click();
    await expect(page.getByTestId('studio-device-status')).toHaveText('ABIERTA', { timeout: 15_000 });
    await expect(page.getByTestId('studio-device-max-take')).toContainText('min mono');

    // Una pista armada con la entrada 1.
    await page.getByTestId('studio-add-track').click();
    const arm = page.locator('[data-testid^="studio-arm-"]');
    await expect(arm).toHaveCount(1);
    await arm.click();
    await expect(arm).toHaveAttribute('aria-pressed', 'true');

    // Grabar: un compas de conteo y luego la toma. Se detiene con mas de 1 s grabado.
    const record = page.getByTestId('studio-record');
    await expect(record).toBeEnabled();
    await record.click();
    await expect(record).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('studio-status')).toHaveText('GRABANDO', { timeout: 20_000 });
    await expect(page.getByTestId('studio-position-time')).toHaveText(/^0:0[1-9]\./, { timeout: 20_000 });
    await record.click();
    await expect(record).toHaveAttribute('aria-pressed', 'false', { timeout: 20_000 });

    // La toma entro a la sesion como un paso que se puede deshacer, y es un clip de la pista.
    await expect(page.getByTestId('studio-undo')).toHaveAttribute('title', /Grabar toma/);
    await page.getByTestId('studio-canvas').click({ position: { x: 12, y: ROW_Y } });
    const selection = page.getByTestId('studio-selection');
    await expect(selection).toContainText('CLIP');
    const seconds = Number(/· (\d+\.\d\d) s$/.exec((await selection.textContent()) ?? '')?.[1] ?? '0');
    expect(seconds).toBeGreaterThan(0.5);
    expect(seconds).toBeLessThan(15);
    // Sin bloques perdidos ni toma cortada: el unico aviso admitido es el de "sin calibrar".
    const notice = page.getByTestId('studio-notice');
    if (await notice.count()) await expect(notice).not.toContainText(/perdió|se cortó|incompleta|vacía/);
    expect(pageErrors).toEqual([]);
  });

  test('AJUSTES > ESTUDIO: por defecto la toma sigue al salir del Estudio; con "Detener la toma" se cierra como clip', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await enableStudio(page);
    await enterDemo(page);

    // La opcion vive en AJUSTES > ESTUDIO y por defecto la toma sigue.
    await openView(page, 'settings');
    await page.getByTestId('settings-section-studio').click();
    await expect(page.getByTestId('studio-settings-on-leave-continue')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('studio-settings-on-leave-stop')).toHaveAttribute('aria-checked', 'false');

    await openStudioHome(page);
    await createFreeSession(page, 'Toma al salir');
    await page.getByTestId('studio-tab-device').click();
    await page.getByTestId('studio-device-list').click();
    await expect(page.getByTestId('studio-device-select')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('studio-device-open').click();
    await expect(page.getByTestId('studio-device-status')).toHaveText('ABIERTA', { timeout: 15_000 });
    await page.getByTestId('studio-add-track').click();
    await page.locator('[data-testid^="studio-arm-"]').click();

    const record = page.getByTestId('studio-record');
    const startTake = async () => {
      await expect(record).toBeEnabled();
      await record.click();
      await expect(page.getByTestId('studio-status')).toHaveText('GRABANDO', { timeout: 20_000 });
      await expect(page.getByTestId('studio-position-time')).toHaveText(/^0:0[1-9]\./, { timeout: 20_000 });
    };

    // Por defecto: salir y volver no corta la toma.
    await startTake();
    await openView(page, 'setlists');
    await page.waitForTimeout(500);
    await openView(page, 'studio');
    await expect(page.getByTestId('studio-status')).toHaveText('GRABANDO');
    await expect(record).toHaveAttribute('aria-pressed', 'true');
    await record.click();
    await expect(record).toHaveAttribute('aria-pressed', 'false', { timeout: 20_000 });
    await expect(page.getByTestId('studio-undo')).toHaveAttribute('title', /Grabar toma/);

    // Con "Detener la toma": salir cierra la toma y queda como paso que se puede deshacer.
    await openView(page, 'settings');
    await page.getByTestId('settings-section-studio').click();
    await page.getByTestId('studio-settings-on-leave-stop').click();
    await expect(page.getByTestId('studio-settings-on-leave-stop')).toHaveAttribute('aria-checked', 'true');
    await openView(page, 'studio');
    await expect(page.getByTestId('studio-workspace')).toBeVisible();
    await page.getByTestId('studio-undo').click();
    await expect(page.getByTestId('studio-undo')).not.toHaveAttribute('title', /Grabar toma/);
    await startTake();
    await openView(page, 'setlists');
    await openView(page, 'studio');
    await expect(record).toHaveAttribute('aria-pressed', 'false', { timeout: 20_000 });
    await expect(page.getByTestId('studio-status')).not.toHaveText('GRABANDO');
    await expect(page.getByTestId('studio-undo')).toHaveAttribute('title', /Grabar toma/);

    // La eleccion se recuerda en este navegador.
    await page.reload();
    await openView(page, 'settings');
    await page.getByTestId('settings-section-studio').click();
    await expect(page.getByTestId('studio-settings-on-leave-stop')).toHaveAttribute('aria-checked', 'true');
    expect(pageErrors).toEqual([]);
  });

  test('con sesión de nube: GUARDAR sube el audio y después el documento al Worker simulado', async ({ page }) => {
    const worker = new FakeStudioWorker();
    const fake = new FakeSupabase();
    fake.workspaces.push({ user_id: USER.id, workspace: workspaceWith('band_daniel_01', 'Banda de Daniel', ['Tema A']), updated_at: fake.now() });
    await worker.install(page);
    await enableStudio(page);
    await signInWithFakeCloud(page, fake);
    await expect(page.getByTestId('band-switcher')).toContainText('Banda de Daniel');

    await openStudioHome(page);
    await expect.poll(() => worker.calls.some((c) => c.method === 'GET' && /\/studio$/.test(c.path))).toBe(true);
    await createFreeSession(page, 'Maqueta en la nube');
    await importWav(page, 'Riff.wav', 2, 330);

    const save = page.getByTestId('studio-save');
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(() => worker.sessions.size, { timeout: 20_000 }).toBe(1);
    await expect(page.getByTestId('studio-save-status')).toHaveText('GUARDADO EN LA NUBE');
    await expect(page.getByTestId('studio-conflict')).toHaveCount(0);
    await expect(page.getByTestId('studio-cloud-error')).toHaveCount(0);

    const puts = worker.calls.filter((c) => c.method === 'PUT');
    expect(puts.length).toBe(2);
    expect(puts[0].path).toMatch(/\/assets\/ast_[A-Za-z0-9_-]+\.wav$/);
    expect(puts[1].path).toMatch(/\/session$/);
    // Crear es condicional: nunca se pisa una sesion que ya exista en la nube.
    expect(puts[1].ifNoneMatch).toBe('*');
    const [stored] = [...worker.sessions.values()];
    expect(stored.doc.title).toBe('Maqueta en la nube');
    expect(stored.doc.assets).toHaveLength(1);
    expect(stored.doc.tracks).toHaveLength(1);
    expect([...worker.assets.values()]).toEqual([stored.doc.assets[0].size]);
    // Ningun trabajo de IA se lanza por guardar.
    expect(worker.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
