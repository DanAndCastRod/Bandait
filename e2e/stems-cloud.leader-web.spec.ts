import { test, expect, type Page, type Route } from '@playwright/test';
import { FakeSupabase, USER, signInWithFakeCloud, workspaceWith } from './support/fakeSupabase';

/**
 * E2E de la nube de stems del hub: el Worker bandait-stems se SIMULA con page.route sobre la URL
 * que playwright.config.ts compila en el servidor de desarrollo (https://stems.e2e.invalid) y la
 * sesion de Supabase es la simulada de support/fakeSupabase.ts. Nunca toca R2 ni Supabase reales.
 * Los WAV se generan en la prueba.
 */

const STEMS = 'https://stems.e2e.invalid';
const SHARED_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function wav(seconds: number, freq: number): Buffer {
  const rate = 8000;
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

interface LoggedCall {
  method: string;
  path: string;
  auth: string | undefined;
  contentLength: number | null;
  bodySize: number;
}

type Failure = { status: number; error: string } | null;

/** Worker bandait-stems en memoria: rutas, codigos de error y commit del manifiesto del README. */
class FakeStemsWorker {
  files = new Map<string, Buffer>();
  manifests = new Map<string, any>();
  calls: LoggedCall[] = [];
  /** Devuelve un error para la peticion (metodo, 'manifest' | 'file' | 'song'), o null. */
  fail: (method: string, kind: string) => Failure = () => null;

  async install(page: Page) {
    await page.route(`${STEMS}/**`, (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const req = route.request();
    const origin = (await req.headerValue('origin')) ?? 'http://localhost:5173';
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-expose-headers': 'Content-Length, ETag',
      vary: 'Origin',
    };
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const headers = await req.allHeaders();
    const body = req.postDataBuffer();
    this.calls.push({
      method,
      path: decodeURIComponent(url.pathname),
      auth: headers['authorization'],
      contentLength: headers['content-length'] !== undefined ? Number(headers['content-length']) : null,
      bodySize: body ? body.length : 0,
    });
    const json = (status: number, payload: unknown) =>
      route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!/^Bearer \S{20,}$/.test(headers['authorization'] ?? '')) return json(401, { error: 'missing_token' });
    const m = /^\/v1\/bands\/([^/]+)\/songs\/([^/]+)(?:\/(manifest|files\/([^/]+)))?$/.exec(url.pathname);
    if (!m) return json(404, { error: 'not_found' });
    const kind = m[3] === 'manifest' ? 'manifest' : m[3] ? 'file' : 'song';
    const failure = this.fail(method, kind);
    if (failure) return json(failure.status, { error: failure.error });
    const song = `${m[1]}/${m[2]}`;

    if (method === 'DELETE') {
      let n = 0;
      for (const key of [...this.files.keys()]) if (key.startsWith(`${song}/`)) (this.files.delete(key), n++);
      if (this.manifests.delete(song)) n++;
      return json(200, { deleted: n });
    }
    if (kind === 'manifest') {
      if (method === 'GET') return this.manifests.has(song) ? json(200, this.manifests.get(song)) : json(404, { error: 'no_stems' });
      const manifest = req.postDataJSON();
      for (const s of manifest.stems) if (this.files.get(`${song}/${s.file}`)?.length !== s.size) return json(409, { error: 'missing_file' });
      const saved = { ...manifest, updated_at: '2026-10-31T12:00:00.000Z' };
      this.manifests.set(song, saved);
      return json(200, saved);
    }
    const file = decodeURIComponent(m[4]);
    const key = `${song}/${file}`;
    if (method === 'GET') {
      const data = this.files.get(key);
      if (!data) return json(404, { error: 'no_file' });
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'audio/wav' }, body: data });
    }
    // La intercepcion de Chromium entrega la peticion ANTES de que la pila de red agregue
    // Content-Length (que el navegador calcula del Blob). Si viene, debe coincidir con el cuerpo.
    if (!body || body.length < 1) return json(411, { error: 'length_required' });
    if (headers['content-length'] !== undefined && Number(headers['content-length']) !== body.length) {
      return json(400, { error: 'incomplete_upload' });
    }
    this.files.set(key, body);
    return json(200, { file, size: body.length });
  }
}

const SONG_A = workspaceWith('band_daniel_01', 'Banda de Daniel', ['Tema A']).songsMap.band_daniel_01[0].id as string;

async function openStems(page: Page) {
  await page.getByRole('button', { name: 'PISTAS', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Estudio de Stems' })).toBeVisible();
}

async function signInOwner(page: Page, worker: FakeStemsWorker) {
  const fake = new FakeSupabase();
  fake.workspaces.push({ user_id: USER.id, workspace: workspaceWith('band_daniel_01', 'Banda de Daniel', ['Tema A']), updated_at: fake.now() });
  await worker.install(page);
  await signInWithFakeCloud(page, fake);
  await expect(page.getByTestId('band-switcher')).toContainText('Banda de Daniel');
  await openStems(page);
}

async function idbFileCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('bandait_stems');
        req.onsuccess = () => {
          const count = req.result.transaction('files', 'readonly').objectStore('files').count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(count.error);
        };
        req.onerror = () => reject(req.error);
      })
  );
}

test.describe('Web Admin Hub - nube de stems (Worker simulado)', () => {
  test('Owner: sube archivos antes que el manifiesto, borra solo local, descarga a IndexedDB y borra de la nube', async ({ page }) => {
    const worker = new FakeStemsWorker();
    await signInOwner(page, worker);

    const cloud = page.getByTestId('stem-cloud');
    await expect(cloud.getByTestId('stem-cloud-status')).toHaveText(/SIN STEMS EN LA NUBE/);
    expect(worker.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /v1/bands/me/songs/${SONG_A}/manifest`]);

    const vocals = wav(2, 440);
    const bass = wav(2, 110);
    await page.getByTestId('stem-file-input').setInputFiles([
      { name: 'Tema A - Vocals.wav', mimeType: 'audio/wav', buffer: vocals },
      { name: 'Tema A - Bass.m4a', mimeType: 'audio/mp4', buffer: bass },
    ]);
    await expect(page.getByTestId('stem-import-cloud-note')).toContainText('El líder solo reproduce MP3, WAV, FLAC u OGG (no M4A)');
    worker.calls.length = 0;
    await page.getByTestId('stem-save').click();

    await expect(cloud.getByTestId('stem-cloud-status')).toHaveText(/^\s*EN LA NUBE$/, { timeout: 15000 });
    // Orden del contrato: cada archivo y despues el manifiesto (commit).
    expect(worker.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `PUT /v1/bands/me/songs/${SONG_A}/files/Tema A - Vocals.wav`,
      `PUT /v1/bands/me/songs/${SONG_A}/files/Tema A - Bass.m4a`,
      `PUT /v1/bands/me/songs/${SONG_A}/manifest`,
    ]);
    // Cuerpo = el archivo completo, con tamano fijo (Blob): el navegador manda Content-Length y no
    // chunked. page.route no ve esa cabecera (la agrega la pila de red despues); si la viera, igual.
    expect(worker.calls[0].bodySize).toBe(vocals.length);
    expect(worker.calls[1].bodySize).toBe(bass.length);
    for (const c of worker.calls.slice(0, 2)) expect([null, c.bodySize]).toContain(c.contentLength);
    expect(worker.calls.every((c) => /^Bearer \S+$/.test(c.auth ?? ''))).toBe(true);
    const manifest = worker.manifests.get(`me/${SONG_A}`);
    expect(manifest.stems.map((s: any) => [s.file, s.role, s.label, s.size])).toEqual([
      ['Tema A - Vocals.wav', 'vocals', 'Voz', vocals.length],
      ['Tema A - Bass.m4a', 'bass', 'Bajo', bass.length],
    ]);
    // Aviso del lider: el m4a se sube pero el lider no lo reproduce.
    await expect(cloud.getByTestId('stem-cloud-leader-note')).toContainText('Tema A - Bass.m4a');

    // Quitar solo de este equipo: la nube los conserva y ofrece descargarlos.
    await page.getByTestId('stem-delete-song').click();
    const confirm = page.getByTestId('stem-delete-confirm');
    await expect(confirm.getByTestId('stem-delete-cloud')).toHaveText('ESTE EQUIPO Y LA NUBE');
    await confirm.getByTestId('stem-delete-local').click();
    await expect(page.getByTestId('stem-studio')).toHaveCount(0);
    await expect(cloud.getByTestId('stem-cloud-status')).toHaveText(/EN LA NUBE · 2 STEMS/);
    expect(await idbFileCount(page)).toBe(0);

    worker.calls.length = 0;
    await cloud.getByTestId('stem-cloud-download').click();
    await expect(cloud.getByTestId('stem-cloud-status')).toHaveText(/^\s*EN LA NUBE$/, { timeout: 15000 });
    expect(worker.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /v1/bands/me/songs/${SONG_A}/manifest`,
      `GET /v1/bands/me/songs/${SONG_A}/files/Tema A - Vocals.wav`,
      `GET /v1/bands/me/songs/${SONG_A}/files/Tema A - Bass.m4a`,
    ]);
    expect(await idbFileCount(page)).toBe(2);
    await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(2, { timeout: 15000 });

    // Borrar tambien de la nube.
    worker.calls.length = 0;
    await page.getByTestId('stem-delete-song').click();
    await page.getByTestId('stem-delete-confirm').getByTestId('stem-delete-cloud').click();
    await expect(page.getByTestId('stem-studio')).toHaveCount(0);
    await expect(cloud.getByTestId('stem-cloud-status')).toHaveText(/SIN STEMS EN LA NUBE/);
    expect(worker.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE /v1/bands/me/songs/${SONG_A}`]);
    expect(worker.manifests.size).toBe(0);
    expect(await idbFileCount(page)).toBe(0);
  });

  test('un 403 not_an_editor al subir muestra un motivo legible y los stems quedan en el equipo', async ({ page }) => {
    const worker = new FakeStemsWorker();
    worker.fail = (method, kind) => (method === 'PUT' && kind === 'file' ? { status: 403, error: 'not_an_editor' } : null);
    await signInOwner(page, worker);
    await page.getByTestId('stem-file-input').setInputFiles([{ name: 'Tema A - Drums.wav', mimeType: 'audio/wav', buffer: wav(1, 100) }]);
    await page.getByTestId('stem-save').click();
    const cloud = page.getByTestId('stem-cloud');
    await expect(cloud.getByTestId('stem-cloud-status')).toHaveText(/ERROR/);
    await expect(cloud.getByTestId('stem-cloud-error')).toHaveText(
      'Solo el Owner o el Director musical de la banda pueden subir o borrar stems en la nube.'
    );
    expect(worker.calls.some((c) => c.path.endsWith('/manifest') && c.method === 'PUT')).toBe(false);
    await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(1, { timeout: 15000 });
  });

  test('un 401 al consultar la nube pide volver a entrar; REINTENTAR vuelve a consultar', async ({ page }) => {
    const worker = new FakeStemsWorker();
    let expired = true;
    worker.fail = (method, kind) => (expired && method === 'GET' && kind === 'manifest' ? { status: 401, error: 'invalid_token' } : null);
    await signInOwner(page, worker);
    const cloud = page.getByTestId('stem-cloud');
    await expect(cloud.getByTestId('stem-cloud-status')).toHaveText(/ERROR/);
    await expect(cloud.getByTestId('stem-cloud-error')).toContainText('Tu sesión de nube venció o no es válida');
    expired = false;
    await cloud.getByRole('button', { name: 'REINTENTAR' }).click();
    await expect(cloud.getByTestId('stem-cloud-status')).toHaveText(/SIN STEMS EN LA NUBE/);
  });

  test('un Musician de una banda compartida descarga pero no puede subir', async ({ page }) => {
    const worker = new FakeStemsWorker();
    const fake = new FakeSupabase();
    fake.workspaces.push({ user_id: USER.id, workspace: workspaceWith('band_daniel_01', 'Banda de Daniel', ['Tema A']), updated_at: fake.now() });
    const shared = workspaceWith(SHARED_ID, 'Banda Ajena', ['Tema X']);
    const songX = shared.songsMap[SHARED_ID][0].id as string;
    fake.bands.push({ id: SHARED_ID, owner_id: '22222222-2222-4222-8222-222222222222', updated_at: fake.now(), content: shared });
    fake.members.push({ band_id: SHARED_ID, email: USER.email, role: 'Musician', name: 'Daniel Castaneda', instrument: 'Guitarra', created_at: fake.now() });
    const clickTrack = wav(1, 1000);
    worker.files.set(`${SHARED_ID}/${songX}/click.wav`, clickTrack);
    worker.manifests.set(`${SHARED_ID}/${songX}`, {
      version: 1,
      song_id: songX,
      offset_ms: 120,
      stems: [{ file: 'click.wav', role: 'click', label: 'Clic', size: clickTrack.length }],
      updated_at: '2026-10-31T12:00:00.000Z',
    });
    await worker.install(page);
    await signInWithFakeCloud(page, fake);
    await page.getByTestId('band-switcher').click();
    await page.getByRole('button', { name: /Banda Ajena/ }).click();
    await expect(page.getByTestId('band-switcher')).toContainText('Banda Ajena');
    await openStems(page);

    const cloud = page.getByTestId('stem-cloud');
    await expect(cloud.getByTestId('stem-cloud-status')).toHaveText(/EN LA NUBE · 1 STEMS/);
    await expect(cloud.getByTestId('stem-cloud-upload')).toHaveCount(0);
    await expect(cloud.getByTestId('stem-cloud-delete')).toHaveCount(0);
    await cloud.getByTestId('stem-cloud-download').click();
    await expect(cloud.getByTestId('stem-cloud-status')).toHaveText(/^\s*EN LA NUBE$/, { timeout: 15000 });
    await expect(cloud.getByTestId('stem-cloud-readonly')).toContainText('Solo el Owner o el Director musical pueden subir');
    await expect(page.getByTestId('stem-offset')).toHaveValue('120');
    expect(worker.calls.every((c) => c.path.startsWith(`/v1/bands/${SHARED_ID}/songs/${songX}/`))).toBe(true);
    expect(worker.calls.filter((c) => c.method !== 'GET')).toEqual([]);

    // Quitar: un Musician solo puede borrar lo de su equipo.
    await page.getByTestId('stem-delete-song').click();
    await expect(page.getByTestId('stem-delete-confirm').getByTestId('stem-delete-cloud')).toHaveCount(0);
    await page.getByTestId('stem-delete-confirm').getByTestId('stem-delete-local').click();
    await expect(cloud.getByTestId('stem-cloud-status')).toHaveText(/EN LA NUBE · 1 STEMS/);
  });

  test('sin sesión de nube (MODO DEMO) no aparece la nube ni se llama al Worker', async ({ page }) => {
    const hits: string[] = [];
    page.on('request', (req) => {
      if (req.url().startsWith(STEMS)) hits.push(req.url());
    });
    await page.goto('/');
    await page.getByTestId('demo-toggle').click();
    await page.getByTestId('demo-profiles').getByRole('button', { name: /Carlos Mendoza/ }).click();
    await openStems(page);
    await expect(page.getByText('Los archivos quedan solo en este navegador.')).toBeVisible();
    await page.getByTestId('stem-file-input').setInputFiles([{ name: 'drums.wav', mimeType: 'audio/wav', buffer: wav(1, 100) }]);
    await expect(page.getByTestId('stem-import-cloud-note')).toHaveCount(0);
    await page.getByTestId('stem-save').click();
    await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(1, { timeout: 15000 });
    await expect(page.getByTestId('stem-cloud')).toHaveCount(0);
    expect(hits).toEqual([]);
  });
});
