import { readFileSync } from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';
import { FakeSupabase, USER, signInWithFakeCloud, workspaceWith } from './support/fakeSupabase';

/**
 * E2E del Estudio Bandait v2 (bandait-protocol/STUDIO_V2.md): pistas de instrumento, piano roll,
 * archivos .mid, paleta de comandos, atajos editables y los trabajos `compose` y `chat`.
 *
 * - El .mid se arma en la prueba: no hay binarios versionados.
 * - El Worker bandait-stems se SIMULA con page.route sobre https://stems.e2e.invalid (como en
 *   studio.leader-web.spec.ts). Ninguna prueba toca R2, Supabase, URiT IA ni Music.AI reales.
 * - Sin teclado MIDI fisico: la entrada Web MIDI se prueba en scripts/verify-studio-v2-input.ts.
 */

const STEMS = 'https://stems.e2e.invalid';

/** WAV PCM leido de la descarga: formato, duracion y pico (escala del formato). */
function readWav(file: Buffer): { bits: number; channels: number; seconds: number; peak: number } {
  expect(file.toString('latin1', 0, 4)).toBe('RIFF');
  expect(file.toString('latin1', 8, 12)).toBe('WAVE');
  let at = 12;
  let fmt: { channels: number; byteRate: number; bits: number } | null = null;
  while (at + 8 <= file.length) {
    const id = file.toString('latin1', at, at + 4);
    const size = file.readUInt32LE(at + 4);
    if (id === 'fmt ') fmt = { channels: file.readUInt16LE(at + 10), byteRate: file.readUInt32LE(at + 16), bits: file.readUInt16LE(at + 22) };
    if (id === 'data') {
      if (!fmt) throw new Error('el bloque data llego antes que fmt');
      const bytes = fmt.bits / 8;
      let peak = 0;
      for (let i = at + 8; i + bytes <= Math.min(file.length, at + 8 + size); i += bytes) {
        const v = bytes === 3 ? file.readIntLE(i, 3) : file.readInt16LE(i);
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
      return { bits: fmt.bits, channels: fmt.channels, seconds: size / fmt.byteRate, peak };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('el WAV no tiene bloque data');
}

/** Cantidad de longitud variable de SMF (7 bits por byte, el alto indica que sigue otro). */
function vlq(value: number): number[] {
  const out = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

/** .mid tipo 0, 480 ticks por negra, 120 BPM, 4/4: tres negras (Do, Mi, Sol) en el canal 1. */
function midiFile(): Buffer {
  const events: number[] = [
    ...vlq(0), 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    ...vlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    ...vlq(0), 0xff, 0x03, 0x04, ...Buffer.from('Riff'),
  ];
  for (const pitch of [60, 64, 67]) {
    events.push(...vlq(0), 0x90, pitch, 100, ...vlq(480), 0x80, pitch, 64);
  }
  events.push(...vlq(0), 0xff, 0x2f, 0x00);
  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(events.length);
  return Buffer.concat([header, Buffer.from('MTrk'), len, Buffer.from(events)]);
}

async function enterDemo(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-toggle').click();
  await page.getByTestId('demo-profiles').getByRole('button', { name: /Carlos Mendoza/ }).click();
  await expect(page.getByText('BANDAIT', { exact: true }).first()).toBeVisible();
}

async function openStudioHome(page: Page) {
  await page.getByRole('button', { name: 'ESTUDIO', exact: true }).first().click();
  await expect(page.getByTestId('studio-home')).toBeVisible();
}

async function createFreeSession(page: Page, title: string) {
  await expect(page.getByTestId('studio-create')).toBeEnabled();
  await page.getByTestId('studio-new-title').fill(title);
  await page.getByTestId('studio-create').click();
  await expect(page.getByTestId('studio-workspace')).toBeVisible();
  await expect(page.getByTestId('studio-status')).toHaveText('DETENIDO');
  await expect(page.getByTestId('studio-import')).toBeEnabled();
}

/** Suelta el foco (queda en el body): los atajos del Estudio valen ahi. */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const tracks = (page: Page) => page.locator('[data-testid^="studio-track-"]:not([data-testid^="studio-track-instrument-"])');

interface PostedJob {
  kind: string;
  body: any;
  estimate: boolean;
  jobId: string | null;
}

/**
 * Worker /studio en memoria: lista vacia, y trabajos `compose` y `chat` (STUDIO_V2.md 4) con la
 * respuesta que fija la prueba. Guarda cada POST para comprobar lo que mando el Hub.
 */
class FakeStudioV2Worker {
  posts: PostedJob[] = [];
  results = new Map<string, unknown>();
  composeReply: (jobId: string) => unknown = (jobId) => ({
    job_id: jobId, kind: 'compose', status: 'SUCCEEDED', length_beats: 16, cost_usd: 0.05,
    description: 'Acordes de Do, Fa y Sol en blancas.',
    notes: [
      { pitch: 60, start: 0, length: 2, velocity: 90 }, { pitch: 64, start: 0, length: 2, velocity: 90 },
      { pitch: 65, start: 4, length: 2, velocity: 90 }, { pitch: 67, start: 8, length: 2, velocity: 90 },
    ],
  });
  chatReply: (jobId: string, body: any) => unknown = (jobId) => ({
    job_id: jobId, kind: 'chat', status: 'SUCCEEDED', cost_usd: 0.03,
    reply: 'Propongo marcar **el coro** en el compás 2.',
    tool_calls: [{ id: 'call_1', name: 'add_marker', arguments: { beat: 4, label: 'Coro', kind: 'chorus' }, signature: 'firma-e2e' }],
  });

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
    const json = (status: number, payload: unknown) =>
      route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const headers = await req.allHeaders();
    if (!/^Bearer \S{20,}$/.test(headers['authorization'] ?? '')) return json(401, { error: 'missing_token' });
    const url = new URL(req.url());
    const m = /^\/v1\/bands\/[^/]+\/studio(?:\/([^/]+)(?:\/(jobs)(?:\/([^/]+))?|\/session)?)?$/.exec(url.pathname);
    if (!m) return json(404, { error: 'no_stems' });
    if (m[1] === undefined) return json(200, { sessions: [] });
    if (m[2] !== 'jobs') return json(404, { error: 'no_session' });
    if (method === 'POST' && m[3] === undefined) {
      const body = req.postDataJSON();
      const estimate = url.searchParams.get('estimate') === '1';
      const jobId = url.searchParams.get('job_id');
      this.posts.push({ kind: body.kind, body, estimate, jobId });
      if (body.kind !== 'compose' && body.kind !== 'chat') return json(400, { error: 'bad_job' });
      if (estimate) return json(200, { kind: body.kind, estimated_cost_usd: body.kind === 'chat' ? 0.03 : 0.05, spent_usd: 0, budget_usd: 20, allowed: true });
      const id = jobId ?? `job_e2e${this.posts.length}`;
      this.results.set(id, body.kind === 'compose' ? this.composeReply(id) : this.chatReply(id, body));
      return json(202, { job_id: id, status: 'STARTED', kind: body.kind });
    }
    if (method === 'GET' && m[3] !== undefined) {
      const result = this.results.get(decodeURIComponent(m[3]));
      return result ? json(200, result) : json(404, { error: 'no_job' });
    }
    return json(405, { error: 'method_not_allowed' });
  }
}

/** Muestra la ventana del asistente con Ctrl+J (arranca minimizado: solo la pastilla). */
async function openAssistant(page: Page) {
  await expect(page.getByTestId('studio-assistant-pill')).toBeVisible();
  await blur(page);
  await page.keyboard.press('Control+j');
  await expect(page.getByTestId('studio-assistant')).toBeVisible();
}

async function enterCloudStudio(page: Page, worker: FakeStudioV2Worker, title: string) {
  const fake = new FakeSupabase();
  fake.workspaces.push({ user_id: USER.id, workspace: workspaceWith('band_daniel_01', 'Banda de Daniel', ['Tema A']), updated_at: fake.now() });
  await worker.install(page);
  await signInWithFakeCloud(page, fake);
  await expect(page.getByTestId('band-switcher')).toContainText('Banda de Daniel');
  await openStudioHome(page);
  await createFreeSession(page, title);
  await page.getByTestId('studio-tab-jobs').click();
  await expect(page.getByTestId('studio-jobs-blocked')).toHaveCount(0);
}

test.describe('Web Admin Hub - Estudio Bandait v2', () => {
  test('pista de synth: dibujar notas en el piano roll, deshacer y exportar una mezcla con sonido', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await enterDemo(page);
    await openStudioHome(page);
    await createFreeSession(page, 'Synth e2e');

    await page.getByTestId('studio-add-instrument').selectOption('synth');
    await expect(tracks(page)).toHaveCount(1);
    const undo = page.getByTestId('studio-undo');
    await expect(undo).toHaveAttribute('title', /Agregar pista de instrumento/);

    await page.getByTestId('studio-add-midi-clip').click();
    await expect(undo).not.toHaveAttribute('title', /Agregar pista de instrumento/);
    await page.getByTestId('studio-open-piano').click();
    await expect(page.getByTestId('studio-piano-roll')).toBeVisible();
    const status = page.getByTestId('studio-piano-status');
    await expect(status).toContainText('0 notas');

    // Dos notas con la herramienta de dibujo, en tiempos distintos.
    await page.getByTestId('studio-piano-tool-draw').click();
    const roll = page.getByTestId('studio-piano-canvas');
    await roll.click({ position: { x: 90, y: 90 } });
    await expect(status).toContainText('1 notas');
    await roll.click({ position: { x: 260, y: 120 } });
    await expect(status).toContainText('2 notas');

    // Deshacer quita la ultima nota (Ctrl+Z con el foco en el piano roll).
    await page.keyboard.press('Control+z');
    await expect(status).toContainText('1 notas');

    // Volver a la linea de tiempo y exportar: la mezcla de una pista de instrumento no es silencio.
    await page.getByTestId('studio-piano-back').click();
    await expect(page.getByTestId('studio-canvas')).toBeVisible();
    await page.getByTestId('studio-export-open').click();
    const run = page.getByTestId('studio-export-run');
    await expect(run).toBeEnabled();
    await run.click();
    const downloadButton = page.getByTestId('studio-export-download');
    await expect(downloadButton).toBeVisible({ timeout: 30_000 });
    const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);
    const info = readWav(readFileSync(await download.path()));
    expect(info.bits).toBe(24);
    // Clip MIDI de 4 compases a 120 BPM: 8 s mas la cola del instrumento.
    expect(info.seconds).toBeGreaterThan(7.9);
    expect(info.peak).toBeGreaterThan(0.01 * 0x7fffff);
    expect(info.peak).toBeLessThan(0x7fffff);
    expect(pageErrors).toEqual([]);
  });

  test('importar un .mid armado en la prueba: una pista de instrumento con sus notas', async ({ page }) => {
    await enterDemo(page);
    await openStudioHome(page);
    await createFreeSession(page, 'MIDI e2e');
    await page.getByTestId('studio-import-midi-input').setInputFiles({ name: 'riff.mid', mimeType: 'audio/midi', buffer: midiFile() });
    await expect(tracks(page)).toHaveCount(1);
    await expect(page.getByTestId('studio-undo')).toHaveAttribute('title', /Importar pista MIDI/);
    await expect(tracks(page).first()).toHaveAttribute('aria-label', /Riff \(Sintetizador\)/);
    await page.getByTestId('studio-canvas').click({ position: { x: 20, y: 100 } });
    await page.getByTestId('studio-open-piano').click();
    await expect(page.getByTestId('studio-piano-status')).toContainText('3 notas');
  });

  test('paleta de comandos (Ctrl+K) busca y ejecuta un comando', async ({ page }) => {
    await enterDemo(page);
    await openStudioHome(page);
    await createFreeSession(page, 'Paleta e2e');
    await blur(page);
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('studio-palette')).toBeVisible();
    await page.getByTestId('studio-palette-input').fill('pista de audio nueva');
    await expect(page.getByTestId('studio-palette-row').first()).toContainText('Pista de audio nueva');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('studio-palette')).toHaveCount(0);
    await expect(tracks(page)).toHaveCount(1);
  });

  test('un atajo editado funciona, y no se dispara al escribir en un campo de texto', async ({ page }) => {
    await enterDemo(page);
    await openStudioHome(page);
    await createFreeSession(page, 'Atajos e2e');
    await blur(page);
    await page.keyboard.press('?');
    const sheet = page.getByTestId('studio-shortcuts');
    await expect(sheet).toBeVisible();
    const row = sheet.locator('[data-testid="studio-shortcut-row"][data-command="track.add_audio"]');
    await row.getByTestId('studio-shortcut-change').click();
    await page.keyboard.press('j');
    await expect(row).toContainText('J');
    await page.getByTestId('studio-shortcuts-save').click();
    await expect(page.getByTestId('studio-shortcuts-message')).toContainText('guardados');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    await blur(page);
    await page.keyboard.press('j');
    await expect(tracks(page)).toHaveCount(1);

    // En el titulo de la sesion, J es una letra: no agrega otra pista.
    const title = page.getByTestId('studio-title');
    await title.click();
    await title.press('End');
    await page.keyboard.type('j');
    await expect(title).toHaveValue(/j$/);
    await expect(tracks(page)).toHaveCount(1);
  });

  test('atajos de DAW: copiar y pegar en la misma pista, Ctrl+D, selección múltiple y borrar', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await enterDemo(page);
    await openStudioHome(page);
    await createFreeSession(page, 'Atajos DAW e2e');
    await page.getByTestId('studio-add-instrument').selectOption('synth');
    await expect(tracks(page)).toHaveCount(1);
    const track = tracks(page).first();
    const selection = page.getByTestId('studio-selection');
    const undo = page.getByTestId('studio-undo');

    // Un clip MIDI de 4 compases en el compás 1 (120 BPM: 8 s), elegido.
    await page.getByTestId('studio-add-midi-clip').click();
    await expect(track).toHaveAttribute('data-clips', '1');
    await expect(selection).toContainText('· 1.1 ·');

    // Ctrl+C y Ctrl+V sin mover el cabezal: la copia va en la MISMA pista, justo detrás (compás 5).
    await blur(page);
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    await expect(track).toHaveAttribute('data-clips', '2');
    await expect(undo).toHaveAttribute('title', /Pegar clip MIDI/);
    await expect(selection).toContainText('· 5.1 ·');
    // Otro Ctrl+V encadena: compás 9.
    await page.keyboard.press('Control+v');
    await expect(track).toHaveAttribute('data-clips', '3');
    await expect(selection).toContainText('· 9.1 ·');

    // Ctrl+D duplica la copia elegida detrás de ella: compás 13.
    await page.keyboard.press('Control+d');
    await expect(track).toHaveAttribute('data-clips', '4');
    await expect(undo).toHaveAttribute('title', /Duplicar clip MIDI/);
    await expect(selection).toContainText('· 13.1 ·');

    // Selección múltiple: clic en el primer clip y Shift + clic en el segundo (36 px por segundo).
    const canvas = page.getByTestId('studio-canvas');
    await canvas.click({ position: { x: 4 * 36, y: 100 } });
    await expect(selection).toHaveAttribute('data-count', '1');
    await canvas.click({ position: { x: 12 * 36, y: 100 }, modifiers: ['Shift'] });
    await expect(selection).toHaveAttribute('data-count', '2');
    await expect(selection).toContainText('2 CLIPS ELEGIDOS');

    // Supr borra los dos en un solo paso de deshacer.
    await page.keyboard.press('Delete');
    await expect(track).toHaveAttribute('data-clips', '2');
    await expect(undo).toHaveAttribute('title', /Borrar 2 clips/);
    await expect(selection).toHaveAttribute('data-count', '0');

    // Ctrl+A elige todos los que quedan; Ctrl+Z trae de vuelta los borrados.
    await page.keyboard.press('Control+a');
    await expect(selection).toHaveAttribute('data-count', '2');
    await page.keyboard.press('Control+z');
    await expect(track).toHaveAttribute('data-clips', '4');
    expect(pageErrors).toEqual([]);
  });

  test('COMPONER contra el Worker simulado: confirma el costo y el clip entra solo al aceptar', async ({ page }) => {
    const worker = new FakeStudioV2Worker();
    await enterCloudStudio(page, worker, 'Componer e2e');
    const job = page.getByTestId('studio-job-compose');
    await job.locator('summary').click();
    await page.getByTestId('studio-compose-prompt').fill('Acordes de balada');
    await page.getByTestId('studio-compose-start').click();
    await expect(page.getByTestId('studio-compose-confirm')).toBeVisible();
    expect(worker.posts.filter((p) => p.estimate).map((p) => p.kind)).toEqual(['compose']);
    await page.getByTestId('studio-compose-launch').click();
    await expect(page.getByTestId('studio-compose-result')).toBeVisible({ timeout: 15_000 });
    const launched = worker.posts.find((p) => !p.estimate)!;
    expect(launched.body).toMatchObject({ kind: 'compose', prompt: 'Acordes de balada', role: 'chords', length_bars: 4 });
    expect(launched.jobId).toMatch(/^job_/);
    // El resultado no toco la sesion todavia.
    await expect(tracks(page)).toHaveCount(0);
    await page.getByTestId('studio-compose-accept').click();
    await expect(tracks(page)).toHaveCount(1);
    await expect(page.getByTestId('studio-undo')).toHaveAttribute('title', /Agregar clip compuesto por IA/);
  });

  test('chat: el comando propuesto queda pendiente y solo se aplica al aceptarlo', async ({ page }) => {
    const worker = new FakeStudioV2Worker();
    await enterCloudStudio(page, worker, 'Chat e2e');
    await openAssistant(page);
    const undo = page.getByTestId('studio-undo');
    const before = await undo.getAttribute('title');
    await page.getByTestId('studio-chat-input').fill('Marca el coro en el compás 2');
    await page.getByTestId('studio-chat-input').press('Enter');
    await expect(page.getByTestId('studio-chat-confirm')).toBeVisible();
    await page.getByTestId('studio-chat-launch').click();
    const call = page.getByTestId('studio-chat-call');
    await expect(call).toHaveCount(1, { timeout: 15_000 });
    await expect(call).toHaveAttribute('data-state', 'pending');
    await expect(page.getByTestId('studio-chat-log')).toContainText('Propongo marcar el coro');
    // El Markdown del modelo se pinta con formato, sin asteriscos.
    await expect(page.getByTestId('studio-chat-log').locator('.stu-md strong', { hasText: 'el coro' })).toBeVisible();
    await expect(page.getByTestId('studio-chat-log')).not.toContainText('**');
    const sent = worker.posts.find((p) => !p.estimate)!;
    expect(sent.body.kind).toBe('chat');
    expect(sent.body.messages.at(-1)).toMatchObject({ role: 'user', text: 'Marca el coro en el compás 2' });
    expect(sent.body.session_summary).toBeTruthy();
    // Nada se aplico solo: el ultimo paso de deshacer es el mismo de antes.
    expect(await undo.getAttribute('title')).toBe(before);
    await page.getByTestId('studio-chat-apply').click();
    await expect(call).toHaveAttribute('data-state', 'applied');
    await expect(undo).not.toHaveAttribute('title', before ?? '');
    await expect(page.getByTestId('studio-chat-continue')).toBeVisible();
  });

  test('asistente: Ctrl+J lo muestra y lo oculta, pasa a flotante, se arrastra sin salir de la ventana y recuerda el modo', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await enterDemo(page);
    await openStudioHome(page);
    await createFreeSession(page, 'Ventana e2e');
    const assistant = page.getByTestId('studio-assistant');
    const pill = page.getByTestId('studio-assistant-pill');
    await expect(pill).toBeVisible();
    await expect(assistant).toBeHidden();

    await blur(page);
    await page.keyboard.press('Control+j');
    await expect(assistant).toBeVisible();
    await expect(assistant).toHaveAttribute('data-mode', 'docked');
    await expect(pill).toHaveCount(0);
    // Sin nube el asistente lo dice en su ventana, y los pedidos rapidos quedan bloqueados.
    await expect(page.getByTestId('studio-chat-blocked')).toBeVisible();
    await expect(page.getByTestId('studio-chat-quick-mix')).toBeDisabled();
    await expect(page.getByTestId('studio-chat-chip-view')).toContainText('LÍNEA DE TIEMPO');

    // Con el foco adentro del asistente, Ctrl+J lo oculta y el foco pasa a la pastilla.
    await page.keyboard.press('Control+j');
    await expect(assistant).toBeHidden();
    await expect(pill).toBeFocused();
    await pill.click();
    await expect(assistant).toHaveAttribute('data-mode', 'docked');

    await page.getByTestId('studio-assistant-float').click();
    await expect(assistant).toHaveAttribute('data-mode', 'floating');
    // Arrastrada por la barra muy afuera arriba a la izquierda: queda pegada al borde, entera.
    const bar = page.getByTestId('studio-assistant-bar');
    const box = (await bar.boundingBox())!;
    await page.mouse.move(box.x + 90, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 2500, box.y - 2500, { steps: 6 });
    await page.mouse.up();
    const moved = (await assistant.boundingBox())!;
    expect(moved.x).toBeGreaterThanOrEqual(0);
    expect(moved.y).toBeGreaterThanOrEqual(0);
    expect(moved.x).toBeLessThan(20);
    expect(moved.y).toBeLessThan(20);
    // Y hacia abajo a la derecha tampoco se sale.
    await page.mouse.move(moved.x + 90, moved.y + 18);
    await page.mouse.down();
    await page.mouse.move(5000, 5000, { steps: 6 });
    await page.mouse.up();
    const corner = (await assistant.boundingBox())!;
    expect(corner.x + corner.width).toBeLessThanOrEqual(1440);
    expect(corner.y + corner.height).toBeLessThanOrEqual(900);

    // Esc minimiza el flotante (sin texto escrito en el mensaje).
    await page.getByTestId('studio-assistant-dock').focus();
    await page.keyboard.press('Escape');
    await expect(pill).toBeVisible();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('bandait_studio_assistant') ?? 'null'));
    expect(saved).toMatchObject({ mode: 'minimized', lastOpen: 'floating' });
    expect(saved.float.x + saved.float.w).toBeLessThanOrEqual(1440);
    // La pastilla lo devuelve flotante, en la misma esquina.
    await pill.click();
    await expect(assistant).toHaveAttribute('data-mode', 'floating');
    const again = (await assistant.boundingBox())!;
    expect(Math.abs(again.x - corner.x)).toBeLessThan(2);
  });

  test('chat: ESCUCHAR aplica de forma provisional y DESHACER deja la sesion como estaba; la conversacion vuelve tras recargar', async ({ page }) => {
    const worker = new FakeStudioV2Worker();
    await enterCloudStudio(page, worker, 'Escuchar e2e');
    await openAssistant(page);
    const undo = page.getByTestId('studio-undo');
    const before = await undo.getAttribute('title');
    await page.getByTestId('studio-chat-input').fill('Marca el coro en el compás 2');
    await page.getByTestId('studio-chat-input').press('Enter');
    await page.getByTestId('studio-chat-launch').click();
    const call = page.getByTestId('studio-chat-call');
    await expect(call).toHaveAttribute('data-state', 'pending', { timeout: 15_000 });

    // ESCUCHAR: el cambio entra como un paso de deshacer y suena en loop la zona de la marca.
    await page.getByTestId('studio-chat-listen').click();
    await expect(page.getByTestId('studio-chat-keep')).toBeVisible();
    await expect(call).toHaveAttribute('data-state', 'listening');
    await expect(page.getByTestId('studio-chat-listening')).toContainText('c. 2-9');
    await expect(undo).not.toHaveAttribute('title', before ?? '');
    await expect(page.getByTestId('studio-loop')).toHaveAttribute('aria-pressed', 'true');
    // Mientras se escucha no se puede mandar otro mensaje ni empezar otra conversacion.
    await expect(page.getByTestId('studio-chat-restart')).toBeDisabled();

    // DESHACER: la sesion vuelve a la de antes, sin loop, y el cambio sigue propuesto.
    await page.getByTestId('studio-chat-undo').click();
    await expect(call).toHaveAttribute('data-state', 'pending');
    expect(await undo.getAttribute('title')).toBe(before);
    await expect(page.getByTestId('studio-loop')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('studio-status')).toHaveText('DETENIDO');

    // Recargar: la conversacion de esta sesion vuelve, con el cambio todavia por decidir y el
    // costo ya confirmado (el boton dice cuanto cuesta, sin volver a pedir confirmacion).
    await page.reload();
    await openStudioHome(page);
    await page.getByTestId('studio-open').first().click();
    await expect(page.getByTestId('studio-workspace')).toBeVisible();
    // La ventana tambien se recuerda: vuelve acoplada, como estaba.
    await expect(page.getByTestId('studio-assistant')).toHaveAttribute('data-mode', 'docked');
    await expect(page.getByTestId('studio-chat-restored')).toBeVisible();
    await expect(page.getByTestId('studio-chat-log')).toContainText('Propongo marcar el coro');
    await expect(call).toHaveAttribute('data-state', 'pending');
    await expect(page.getByTestId('studio-assistant-pill')).toHaveCount(0);
    await expect(page.getByTestId('studio-chat-send')).toContainText('ENVIAR ·');
    await page.getByTestId('studio-chat-apply').click();
    await expect(call).toHaveAttribute('data-state', 'applied');

    // NUEVA empieza de cero, y eso tambien queda guardado.
    await page.getByTestId('studio-chat-restart').click();
    await expect(page.getByTestId('studio-chat-log')).toHaveCount(0);
    await expect(page.getByTestId('studio-chat-send')).toContainText('ENVIAR...');
  });
});
