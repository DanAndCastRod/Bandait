import { test, expect, type Page, type Route } from '@playwright/test';
import { FakeSupabase, USER, signInWithFakeCloud, workspaceWith } from './support/fakeSupabase';

/**
 * E2E de la correccion de 2.3: el hub usa los stems y el borrador de analisis que estan en la
 * NUBE aunque este navegador no los tenga en IndexedDB (caso de "Dame tu aire", lanzado desde el
 * lider). Worker bandait-stems SIMULADO con page.route sobre https://stems.e2e.invalid y Supabase
 * simulado (support/fakeSupabase.ts). Los WAV se generan en la prueba.
 */

const STEMS = 'https://stems.e2e.invalid';
const SHARED_ID = '32056489-a555-48bb-bb5b-c92ea7995c8f';

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

const DRAFT = {
  source: 'music.ai',
  bpm: 96,
  key: 'Bm',
  beats_per_bar: 4,
  sections: [
    { kind: 'intro', label: 'Intro', bars: 4, start_bar: 1, chordpro: '[Bm]    [G]    [D]    [A]', cue_text: null },
    { kind: 'verse', label: 'Estrofa 1', bars: 8, start_bar: 5, chordpro: '[Bm]    [G]\n[D]    [A]', cue_text: null },
  ],
  lyrics_unplaced: ['Dame tu aire'],
  notes: [],
};

/** Worker en memoria: manifiestos, archivos y analisis por `${band}/${song}`; registra cada llamada. */
class FakeWorker {
  manifests = new Map<string, any>();
  files = new Map<string, Buffer>();
  analysis = new Map<string, Array<{ status: number; body: unknown }>>();
  postReply: { status: number; body: unknown } = { status: 202, body: { status: 'STARTED', job_id: 'job-e2e' } };
  calls: string[] = [];
  /** POST de analisis: URL con su query (?separate=1), Content-Type y tamano del cuerpo. */
  posts: Array<{ search: string; type: string; size: number }> = [];

  seedStems(band: string, song: string, files: Array<{ file: string; role: string; label: string; data: Buffer }>) {
    for (const f of files) this.files.set(`${band}/${song}/${f.file}`, f.data);
    this.manifests.set(`${band}/${song}`, {
      version: 1,
      song_id: song,
      offset_ms: 0,
      stems: files.map((f) => ({ file: f.file, role: f.role, label: f.label, size: f.data.length })),
      updated_at: '2026-10-31T22:00:00.000Z',
    });
  }

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
    const m = /^\/v1\/bands\/([^/]+)\/songs\/([^/]+)(?:\/(manifest|analysis|files\/([^/]+)))?$/.exec(new URL(req.url()).pathname);
    if (!m) return json(404, { error: 'not_found' });
    const key = `${m[1]}/${m[2]}`;
    const what = m[3]?.startsWith('files/') ? `files/${decodeURIComponent(m[4])}` : m[3] ?? '';
    this.calls.push(`${method} ${what}`);
    if (what === 'analysis') {
      if (method === 'POST') {
        this.posts.push({ search: new URL(req.url()).search, type: (await req.headerValue('content-type')) ?? '', size: (req.postDataBuffer() ?? Buffer.alloc(0)).length });
        return json(this.postReply.status, this.postReply.body);
      }
      const replies = this.analysis.get(key) ?? [{ status: 404, body: { error: 'no_analysis' } }];
      const reply = replies.length > 1 ? replies.shift()! : replies[0];
      // Como el Worker real: al terminar una separacion, el manifiesto nuevo ya esta en la nube.
      const stems = (reply.body as { stems?: unknown } | null)?.stems;
      if (reply.status === 200 && stems) this.manifests.set(key, stems);
      return json(reply.status, reply.body);
    }
    if (what === 'manifest') {
      if (method === 'GET') return this.manifests.has(key) ? json(200, this.manifests.get(key)) : json(404, { error: 'no_stems' });
      const body = req.postDataJSON();
      this.manifests.set(key, body);
      return json(200, body);
    }
    if (what.startsWith('files/')) {
      const fileKey = `${key}/${what.slice(6)}`;
      if (method === 'GET') {
        const data = this.files.get(fileKey);
        return data ? route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'audio/wav' }, body: data }) : json(404, { error: 'no_file' });
      }
      const body = req.postDataBuffer() ?? Buffer.alloc(0);
      this.files.set(fileKey, body);
      return json(200, { file: what.slice(6), size: body.length });
    }
    return json(404, { error: 'not_found' });
  }
}

const SONG_A = workspaceWith('band_daniel_01', 'Banda de Daniel', ['Tema A']).songsMap.band_daniel_01[0].id as string;

async function signInOwner(page: Page, worker: FakeWorker) {
  const fake = new FakeSupabase();
  fake.workspaces.push({ user_id: USER.id, workspace: workspaceWith('band_daniel_01', 'Banda de Daniel', ['Tema A']), updated_at: fake.now() });
  await worker.install(page);
  await signInWithFakeCloud(page, fake);
  await expect(page.getByTestId('band-switcher')).toContainText('Banda de Daniel');
}

async function openEditor(page: Page, title: string) {
  await page.getByRole('button', { name: 'CANCIONES', exact: true }).click();
  await page.getByTestId('song-card').filter({ hasText: title }).getByRole('button', { name: 'EDITAR' }).click();
  return page.getByTestId('song-editor');
}

async function idbFileCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('bandait_stems');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('files')) return resolve(0);
          const count = db.transaction('files', 'readonly').objectStore('files').count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => resolve(-1);
        };
        req.onerror = () => resolve(-1);
      })
  );
}

test.describe('Web Admin Hub - stems y borrador en la nube sin copia local', () => {
  test('el borrador del lider se ve y se acepta aunque este navegador no tenga los stems', async ({ page }) => {
    const worker = new FakeWorker();
    worker.analysis.set(`me/${SONG_A}`, [{ status: 200, body: { status: 'SUCCEEDED', job_id: 'job-lider', created_at: '2026-10-31T22:04:37.000Z', draft: DRAFT } }]);
    await signInOwner(page, worker);
    const editor = await openEditor(page, 'Tema A');
    const panel = editor.getByTestId('song-analysis');
    await expect(panel.getByTestId('analysis-draft')).toBeVisible();
    await expect(panel.getByTestId('analysis-section')).toHaveCount(2);
    // Sin stems en ningun lado: ANALIZAR DE NUEVO deshabilitado, pero el borrador se puede aceptar.
    await expect(panel.getByTestId('analysis-start')).toBeDisabled();
    await panel.getByTestId('analysis-accept').click();
    await expect(editor.getByTestId('section-row')).toHaveCount(2);
    await editor.getByTestId('song-save').click();
    await expect(page.getByTestId('song-card').filter({ hasText: 'Tema A' }).getByTestId('song-card-sections')).toContainText('2 secciones · 12 compases');
    expect(worker.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    expect(await idbFileCount(page)).toBe(0);
  });

  test('ANALIZAR sin stems locales: primero descarga los archivos de la nube y despues hace el POST', async ({ page }) => {
    test.setTimeout(60_000);
    const worker = new FakeWorker();
    worker.seedStems('me', SONG_A, [
      { file: 'Tema A - Vocals.wav', role: 'vocals', label: 'Voz', data: wav(3, 440) },
      { file: 'Tema A - Bass.wav', role: 'bass', label: 'Bajo', data: wav(3, 110) },
    ]);
    worker.analysis.set(`me/${SONG_A}`, [
      { status: 404, body: { error: 'no_analysis' } },
      { status: 200, body: { status: 'SUCCEEDED', job_id: 'job-e2e', created_at: '2026-10-31T23:00:00.000Z', draft: DRAFT } },
    ]);
    await signInOwner(page, worker);
    const editor = await openEditor(page, 'Tema A');
    const panel = editor.getByTestId('song-analysis');
    await expect(panel.getByTestId('analysis-start')).toHaveText(/DESCARGAR STEMS Y ANALIZAR/);
    await expect(panel.getByTestId('analysis-start')).toBeEnabled();
    worker.calls.length = 0;
    await panel.getByTestId('analysis-start').click();
    await expect(panel.getByTestId('analysis-draft')).toBeVisible({ timeout: 20000 });
    expect(worker.calls).toEqual([
      'GET manifest',
      'GET files/Tema A - Vocals.wav',
      'GET files/Tema A - Bass.wav',
      'POST analysis',
      'GET analysis',
    ]);
    expect(await idbFileCount(page)).toBe(2);
  });

  test('PISTAS: SUBIR CANCION Y SEPARAR confirma el reemplazo, sigue STARTED, IMPORTING 1/3 y 2/3, y ofrece descargar los nuevos', async ({ page }) => {
    test.setTimeout(90_000);
    const worker = new FakeWorker();
    worker.seedStems('me', SONG_A, [
      { file: 'Tema A - Drums.wav', role: 'drums', label: 'Bateria', data: wav(2, 100) },
      { file: 'Tema A - Bass.wav', role: 'bass', label: 'Bajo', data: wav(2, 82) },
    ]);
    // Lo que deja la separacion en la nube: 3 stems nuevos (los archivos ya estan en R2 al terminar).
    const split = [
      { file: 'Vocals.wav', role: 'vocals', label: 'Voz', data: wav(2, 440) },
      { file: 'Drums.wav', role: 'drums', label: 'Batería', data: wav(2, 110) },
      { file: 'Bass.wav', role: 'bass', label: 'Bajo', data: wav(2, 82) },
    ];
    for (const f of split) worker.files.set(`me/${SONG_A}/${f.file}`, f.data);
    const newManifest = {
      version: 1,
      song_id: SONG_A,
      offset_ms: 0,
      stems: split.map((f) => ({ file: f.file, role: f.role, label: f.label, size: f.data.length })),
      updated_at: '2026-10-31T23:30:00.000Z',
    };
    await signInOwner(page, worker);
    await page.getByRole('button', { name: 'PISTAS', exact: true }).click();
    const cloudStatus = page.getByTestId('stem-cloud-status');
    await expect(cloudStatus).toContainText('2 STEMS');
    // Primero los stems viejos en este equipo: al terminar, el hub avisa que los de la nube son nuevos.
    await page.getByTestId('stem-cloud-download').click();
    await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(2, { timeout: 15000 });
    await page.getByRole('button', { name: 'IMPORTAR MÁS' }).click();

    const panel = page.getByTestId('split-upload');
    await expect(panel).toContainText('Gasta créditos de Music AI y tarda unos minutos');
    worker.postReply = { status: 202, body: { status: 'STARTED', job_id: 'job-split', separate: true } };
    worker.analysis.set(`me/${SONG_A}`, [
      { status: 200, body: { status: 'STARTED', job_id: 'job-split' } },
      { status: 200, body: { status: 'IMPORTING', done: 1, total: 3 } },
      { status: 502, body: { error: 'stems_copy_failed' } },
      { status: 200, body: { status: 'IMPORTING', done: 2, total: 3 } },
      { status: 200, body: { status: 'SUCCEEDED', job_id: 'job-split', created_at: '2026-10-31T23:30:00.000Z', draft: DRAFT, stems: newManifest } },
    ]);
    await panel.getByTestId('split-file-input').setInputFiles({ name: 'Tema A.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(4096, 7) });

    // Ya hay 2 stems en la nube: pide confirmar el reemplazo; CANCELAR no sube nada.
    const confirm = panel.getByTestId('split-confirm');
    await expect(confirm).toContainText('Reemplaza los 2 stems actuales');
    await confirm.getByRole('button', { name: 'CANCELAR' }).click();
    await expect(confirm).toHaveCount(0);
    expect(worker.posts).toEqual([]);
    await panel.getByTestId('split-file-input').setInputFiles({ name: 'Tema A.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(4096, 7) });
    await panel.getByTestId('split-confirm-ok').click();

    const status = panel.getByTestId('split-status');
    await expect(status).toHaveText('SEPARANDO EN MUSIC AI...', { timeout: 10000 });
    await expect(status).toHaveText('COPIANDO STEMS 1/3...', { timeout: 10000 });
    await expect(status).toHaveText('COPIANDO STEMS 2/3...', { timeout: 15000 });
    await expect(panel.getByTestId('split-done')).toContainText('3 stems', { timeout: 15000 });
    expect(worker.posts).toEqual([{ search: '?separate=1', type: 'audio/mpeg', size: 4096 }]);

    // La vista olvido el manifiesto viejo: la nube muestra la version nueva (distinta de la local).
    await expect(cloudStatus).toHaveText(/LA NUBE TIENE OTRA VERSIÓN/);
    const note = panel.getByTestId('split-local-note');
    await expect(note).toContainText('No se borró nada');
    await expect(page.locator('[data-testid="stem-track"]')).toHaveCount(2);
    await note.getByTestId('split-download-new').click();
    await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(3, { timeout: 15000 });
    await expect(cloudStatus).toHaveText(/EN LA NUBE/);
  });

  test('movil 390 px: la confirmacion de SEPARAR queda a la vista y la barra inferior no tapa sus botones', async ({ page }) => {
    const worker = new FakeWorker();
    worker.seedStems('me', SONG_A, [
      { file: 'Tema A - Drums.wav', role: 'drums', label: 'Bateria', data: wav(2, 100) },
      { file: 'Tema A - Bass.wav', role: 'bass', label: 'Bajo', data: wav(2, 82) },
    ]);
    await signInOwner(page, worker);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.hub-mobile-nav').getByRole('button', { name: /PISTAS/ }).click();
    const panel = page.getByTestId('split-upload');
    await expect(panel).toBeVisible();
    // La pagina arriba del todo: el panel queda bajo el borde y la confirmacion tiene que subir sola.
    await page.evaluate(() => window.scrollTo(0, 0));
    await panel.getByTestId('split-file-input').setInputFiles({ name: 'Tema A.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(4096, 7) });
    const confirm = panel.getByTestId('split-confirm');
    await expect(confirm).toContainText('Reemplaza los 2 stems actuales');
    await expect(confirm.getByRole('button', { name: 'CANCELAR' })).toBeFocused();
    for (const button of [confirm.getByRole('button', { name: 'CANCELAR' }), panel.getByTestId('split-confirm-ok')]) {
      await expect(button).toBeInViewport({ ratio: 1 });
      // El elemento que recibe un toque en el centro del boton es el boton, no la barra inferior.
      await expect
        .poll(() =>
          button.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!hit && el.contains(hit);
          })
        )
        .toBe(true);
    }
    expect(worker.posts).toEqual([]);
  });

  test('CANCIONES: sin stems en ningun lado, el panel de analisis separa la cancion y deja el borrador', async ({ page }) => {
    test.setTimeout(60_000);
    const worker = new FakeWorker();
    await signInOwner(page, worker);
    const editor = await openEditor(page, 'Tema A');
    const analysis = editor.getByTestId('song-analysis');
    await expect(analysis.getByTestId('analysis-no-stems')).toContainText('sube la canción completa');
    const manifest = { version: 1, song_id: SONG_A, offset_ms: 0, stems: [{ file: 'Vocals.wav', role: 'vocals', label: 'Voz', size: 10 }] };
    worker.analysis.set(`me/${SONG_A}`, [
      { status: 200, body: { status: 'IMPORTING', done: 0, total: 1 } },
      { status: 200, body: { status: 'SUCCEEDED', job_id: 'job-split', created_at: '2026-10-31T23:40:00.000Z', draft: DRAFT, stems: manifest } },
    ]);
    const split = analysis.getByTestId('split-upload');
    await split.getByTestId('split-file-input').setInputFiles({ name: 'Tema A.flac', mimeType: 'audio/flac', buffer: Buffer.alloc(2048, 3) });
    // Sin stems en la nube no hay nada que reemplazar: sube directo.
    await expect(split.getByTestId('split-confirm')).toHaveCount(0);
    await expect(split.getByTestId('split-done')).toBeVisible({ timeout: 15000 });
    await expect(split.getByTestId('split-local-note')).toHaveCount(0);
    await expect(analysis.getByTestId('analysis-draft')).toBeVisible({ timeout: 10000 });
    expect(worker.posts).toEqual([{ search: '?separate=1', type: 'audio/flac', size: 2048 }]);

    // Un archivo que no es audio no se sube.
    await split.getByTestId('split-file-input').setInputFiles({ name: 'notas.txt', mimeType: 'text/plain', buffer: Buffer.from('hola') });
    await expect(split.getByTestId('split-error')).toContainText('WAV, FLAC, MP3 o M4A');
    expect(worker.posts).toHaveLength(1);
  });

  test('ENSAYO ofrece la cancion que solo esta en la nube, la descarga y la reproduce; sin secciones lleva a CANCIONES', async ({ page }) => {
    const worker = new FakeWorker();
    worker.seedStems('me', SONG_A, [
      { file: 'Tema A - Drums.wav', role: 'drums', label: 'Bateria', data: wav(4, 100) },
      { file: 'Tema A - Bass.wav', role: 'bass', label: 'Bajo', data: wav(4, 82) },
    ]);
    await signInOwner(page, worker);
    await page.getByRole('button', { name: 'ENSAYO', exact: true }).click();
    await expect(page.getByTestId('rehearsal-context')).toContainText('Ensayo individual, en casa');
    await expect(page.getByTestId('rehearsal-song-select')).toContainText('Tema A · 100 BPM · en la nube');
    const cloudOnly = page.getByTestId('rehearsal-cloud-only');
    await expect(cloudOnly).toContainText('2 stems');
    await cloudOnly.getByTestId('rehearsal-download').click();
    await expect(page.getByTestId('stem-studio')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(2, { timeout: 15000 });
    await expect(page.getByTestId('rehearsal-song-select')).toContainText('Tema A · 100 BPM · en este equipo');
    expect(await idbFileCount(page)).toBe(2);

    await page.getByTestId('stem-play').click();
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'playing');
    await page.getByTestId('stem-stop').click();
    await expect(page.getByTestId('stem-studio')).toHaveAttribute('data-state', 'stopped');

    // "Tema A" no tiene secciones: ENSAYO lo dice y abre su editor en CANCIONES.
    await expect(page.getByTestId('rehearsal-no-sections')).toContainText('no tiene secciones');
    await page.getByTestId('rehearsal-edit-song').click();
    await expect(page.getByTestId('song-editor')).toBeVisible();
    await expect(page.getByTestId('song-editor').getByLabel('TÍTULO')).toHaveValue('Tema A');
    expect(worker.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  test.describe('integrante que no es editor (Musician de una banda compartida)', () => {
    async function signInMusician(page: Page, worker: FakeWorker) {
      const fake = new FakeSupabase();
      fake.workspaces.push({ user_id: USER.id, workspace: workspaceWith('band_daniel_01', 'Banda de Daniel', ['Tema A']), updated_at: fake.now() });
      const shared = workspaceWith(SHARED_ID, "B&O's", ['Dame tu aire']);
      fake.bands.push({ id: SHARED_ID, owner_id: '22222222-2222-4222-8222-222222222222', updated_at: fake.now(), content: shared });
      fake.members.push({ band_id: SHARED_ID, email: USER.email, role: 'Musician', name: 'Daniel Castaneda', instrument: 'Guitarra', created_at: fake.now() });
      await worker.install(page);
      await signInWithFakeCloud(page, fake);
      await page.getByTestId('band-switcher').click();
      await page.getByRole('button', { name: /B&O's/ }).click();
      await expect(page.getByTestId('band-switcher')).toContainText("B&O's");
      return shared.songsMap[SHARED_ID][0].id as string;
    }

    test('ve el borrador en solo lectura, sin ACEPTAR ni ANALIZAR', async ({ page }) => {
      const worker = new FakeWorker();
      const fake = workspaceWith(SHARED_ID, "B&O's", ['Dame tu aire']);
      const song = fake.songsMap[SHARED_ID][0].id as string;
      worker.analysis.set(`${SHARED_ID}/${song}`, [{ status: 200, body: { status: 'SUCCEEDED', job_id: 'job-lider', created_at: '2026-10-31T22:04:37.000Z', draft: DRAFT } }]);
      await signInMusician(page, worker);
      const editor = await openEditor(page, 'Dame tu aire');
      const panel = editor.getByTestId('song-analysis');
      await expect(panel.getByTestId('analysis-draft')).toBeVisible();
      await expect(panel.getByTestId('analysis-readonly')).toContainText('solo el Owner o el Director musical pueden aceptar');
      await expect(panel.getByTestId('analysis-accept')).toHaveCount(0);
      await expect(panel.getByTestId('analysis-dismiss')).toHaveCount(0);
      await expect(panel.getByTestId('analysis-start')).toHaveCount(0);
      await expect(panel.getByTestId('analysis-apply-bpm')).toHaveCount(0);
      expect(worker.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
    });

    test('si el Worker le niega el analisis (403) o no hay borrador, no ve el panel', async ({ page }) => {
      const worker = new FakeWorker();
      const fake = workspaceWith(SHARED_ID, "B&O's", ['Dame tu aire']);
      const song = fake.songsMap[SHARED_ID][0].id as string;
      worker.analysis.set(`${SHARED_ID}/${song}`, [{ status: 403, body: { error: 'not_an_editor' } }]);
      await signInMusician(page, worker);
      const editor = await openEditor(page, 'Dame tu aire');
      await expect.poll(() => worker.calls.includes('GET analysis')).toBe(true);
      await expect(editor.getByTestId('song-analysis')).toHaveCount(0);
    });
  });
});
