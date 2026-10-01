import { test, expect, Page, WebSocketRoute } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * E2E del seguidor (bandait-follower) contra la UI actual (protocolo v3).
 *
 * Deterministas: nunca dependen de un lider real. El lider se simula con
 * page.routeWebSocket hablando Engine.IO v4 / Socket.IO v5 sobre WebSocket,
 * con los payloads del contrato (bandait-protocol/fixtures/v3_messages.json).
 * Los tests "sin lider" cierran el WebSocket al abrirlo (lider inalcanzable).
 */

type Json = Record<string, unknown>;

const FIXTURES = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../bandait-protocol/fixtures/v3_messages.json'), 'utf-8'),
) as Record<string, Json>;
const SETLIST = (FIXTURES.state_playing as { setlist: Json[] }).setlist;

const LEADER_IP = '127.0.0.1';
const LEADER_PORT = '4599';
const SOCKET_URL = /\/socket\.io\//;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEADER_INSTANCE_ID = '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** First non-internal IPv4 of this machine (the dev server listens on all interfaces). */
function lanIPv4(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

// ---------------------------------------------------------------- helpers

interface MockLeader {
  received: Array<{ event: string; payload: Json }>;
  joins: () => Json[];
  commands: () => Json[];
}

/** Fake leader: answers join_session, sync_request and control_command per CONTRACT_V3. */
async function mockLeader(page: Page): Promise<MockLeader> {
  const t0 = performance.now();
  // Leader monotonic clock in ns, a safe integer (contract section 2).
  const leaderNs = () => Math.round((5_000_000 + (performance.now() - t0)) * 1e6);
  const received: MockLeader['received'] = [];
  let version = 1;
  let sessionId = 'default';
  let current: Json = {};

  const makeState = (over: Json = {}): Json => ({
    protocol_version: 3,
    leader_instance_id: LEADER_INSTANCE_ID,
    session_id: sessionId,
    status: 'IDLE',
    state_version: version,
    current_song_id: 'song_01',
    current_order_index: 0,
    bpm: 120,
    beats_per_bar: 4,
    anchor_ns: null,
    bar_offset: 1,
    paused_bar: null,
    leader_time_ns: leaderNs(),
    setlist: SETLIST,
    last_command: null,
    ...over,
  });

  await page.routeWebSocket(SOCKET_URL, (ws: WebSocketRoute) => {
    // Engine.IO open packet.
    ws.send('0' + JSON.stringify({ sid: 'e2e-engine', upgrades: [], pingInterval: 60000, pingTimeout: 60000, maxPayload: 1e6 }));
    ws.onMessage((raw) => {
      const m = typeof raw === 'string' ? raw : raw.toString();
      if (m.startsWith('40')) {
        ws.send('40' + JSON.stringify({ sid: 'e2e-socket' })); // Socket.IO CONNECT ok
        return;
      }
      const packet = /^42(\d*)(\[[\s\S]*\])$/.exec(m);
      if (!packet) return;
      const ackId = packet[1];
      const [event, payload] = JSON.parse(packet[2]) as [string, Json];
      received.push({ event, payload });
      const ack = (data: Json) => {
        if (ackId !== '') ws.send(`43${ackId}${JSON.stringify([data])}`);
      };
      const emit = (name: string, data: Json) => ws.send('42' + JSON.stringify([name, data]));

      if (event === 'join_session') {
        sessionId = String(payload.session_id);
        current = makeState();
        ack({
          status: 'joined',
          session_id: sessionId,
          protocol_version: 3,
          leader_instance_id: LEADER_INSTANCE_ID,
          leader_time_ns: leaderNs(),
        });
        emit('full_state', current);
      } else if (event === 'sync_request') {
        ack({ client_send_ms: payload.client_send_ms, leader_time_ns: leaderNs() });
      } else if (event === 'control_command') {
        const type = String(payload.type);
        version += 1;
        const last = { command_id: payload.command_id, type, origin: payload.origin };
        if (type === 'PLAY') {
          current = makeState({ status: 'PLAYING', anchor_ns: leaderNs() + 250_000_000, last_command: last });
        } else if (type === 'STOP' || type === 'PANIC') {
          current = makeState({ status: 'IDLE', last_command: last });
        } else {
          current = makeState({ ...current, state_version: version, leader_time_ns: leaderNs(), last_command: last });
        }
        ack({
          command_id: payload.command_id,
          accepted: true,
          duplicate: false,
          action_taken: type,
          reason: null,
          state_version: version,
          state: current,
        });
        emit('state_update', current);
      }
    });
  });

  return {
    received,
    joins: () => received.filter((r) => r.event === 'join_session').map((r) => r.payload),
    commands: () => received.filter((r) => r.event === 'control_command').map((r) => r.payload),
  };
}

/** Leader unreachable: every connection attempt is closed at once. */
async function offlineLeader(page: Page): Promise<void> {
  await page.routeWebSocket(SOCKET_URL, (ws) => {
    void ws.close();
  });
}

function autoJoinUrl(params: Record<string, string> = {}): string {
  const q = new URLSearchParams({ session: 'ensayo', ip: LEADER_IP, port: LEADER_PORT, auto: '1', ...params });
  return `/?${q.toString()}`;
}

const connectView = (page: Page) => page.locator('.connect-view');
const stageView = (page: Page) => page.locator('.stage-view');
const ipInput = (page: Page) => page.getByPlaceholder('192.168.1.100');
const portInput = (page: Page) => page.locator('.form-group', { hasText: 'PUERTO' }).locator('input');
const sessionInput = (page: Page) => page.locator('.form-group', { hasText: 'ID DE SESIÓN' }).locator('input');
const aliasInput = (page: Page) => page.getByPlaceholder('Ej. Baterista');
const roleSelect = (page: Page) => page.locator('.connect-view select');
const audioBanner = (page: Page) => page.locator('.audio-arm-banner');

async function fillConnect(page: Page, ip: string, port: string, session = 'default') {
  await ipInput(page).fill(ip);
  await portInput(page).fill(port);
  await sessionInput(page).fill(session);
}

/**
 * No horizontal scroll anywhere: the document and the view root fit the
 * viewport, no element that can scroll sideways (overflow-x auto/scroll,
 * e.g. a modal with overflow-y:auto) has wider content, and no fixed overlay
 * sticks out. Elements marked data-allow-hscroll (the setlist ribbon) are
 * intentional horizontal scrollers and are skipped.
 */
async function expectNoHorizontalScroll(page: Page) {
  // Measure the final layout: web fonts (wider than the fallback) may still be loading.
  await page.evaluate(() =>
    Promise.race([document.fonts.ready.then(() => undefined), new Promise<void>((r) => setTimeout(r, 5000))]),
  );
  const report = await page.evaluate(() => {
    const vw = window.innerWidth;
    const describe = (el: Element) => {
      const parent = el.parentElement ? `${el.parentElement.tagName.toLowerCase()}.${el.parentElement.className || '-'}` : '-';
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return `${el.tagName.toLowerCase()}.${(el as HTMLElement).className || '-'} (en ${parent}: "${text}")`;
    };
    const nodes = [
      document.documentElement,
      document.body,
      document.querySelector('.app-container'),
      document.querySelector('.connect-view, .stage-view, .settings-view, .library-view'),
    ].filter((n): n is Element => n !== null);
    const all = [...document.querySelectorAll<HTMLElement>('body *')];
    const allowed = (el: Element) => el.closest('[data-allow-hscroll]') !== null;
    const scrollers = all
      .filter((el) => !allowed(el))
      .filter((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX))
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${describe(el)} ${el.scrollWidth}>${el.clientWidth}`);
    const fixedOut = all
      .filter((el) => getComputedStyle(el).position === 'fixed')
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > vw + 1 || r.left < -1);
      })
      .map((el) => describe(el));
    // Diagnostic: the widest elements sticking out past the viewport.
    const offenders = all
      .filter((el) => !allowed(el))
      .map((el) => ({ el, right: el.getBoundingClientRect().right }))
      .filter((x) => x.right > vw + 1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 4)
      .map((x) => `${describe(x.el)}@${Math.round(x.right)}px`);
    return {
      vw,
      offenders,
      scrollers,
      fixedOut,
      nodes: nodes.map((n) => ({ name: (n as HTMLElement).className || n.nodeName, sw: n.scrollWidth })),
    };
  });
  expect(report.nodes.length).toBeGreaterThanOrEqual(3);
  const hint = `sobresalen: ${report.offenders.join(', ') || '-'}`;
  for (const n of report.nodes) {
    expect(n.sw, `${n.name} desborda en horizontal (${n.sw}px > ${report.vw}px); ${hint}`).toBeLessThanOrEqual(report.vw);
  }
  expect(report.scrollers, `contenedores con scroll horizontal; ${hint}`).toEqual([]);
  expect(report.fixedOut, `overlays fijos fuera del viewport; ${hint}`).toEqual([]);
}

/** Hold the emergency control long enough to fire (800 ms hold). */
async function holdEmergency(page: Page) {
  const track = page.locator('.emergency-track');
  await track.hover();
  await page.mouse.down();
  await page.waitForTimeout(1100);
  await page.mouse.up();
}

// ------------------------------------------------------------------ tests

test.describe('Follower: pantalla de conexion', () => {
  test('muestra los campos IP / puerto / sesion / alias / rol y la entrada QR', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'BANDAIT' })).toBeVisible();
    await expect(ipInput(page)).toBeVisible();
    await expect(portInput(page)).toHaveValue('4040');
    await expect(sessionInput(page)).toHaveValue('default');
    await expect(aliasInput(page)).toBeVisible();
    await expect(roleSelect(page).locator('option', { hasText: 'Director Musical' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'ESTABLECER ENLACE STAGE' })).toBeVisible();

    // Sin Supabase configurado no hay boton de Google.
    await expect(page.getByText('PERFIL LOCAL (NUBE NO CONFIGURADA)')).toBeVisible();
    await expect(page.getByText('VINCULAR CUENTA GOOGLE')).toHaveCount(0);

    // Entrada QR real (no el falso "conectar tras 1.2 s").
    await page.getByRole('button', { name: 'ESCANEAR CÓDIGO QR' }).click();
    await expect(page.getByText('LECTOR DE CREDENCIAL QR')).toBeVisible();
    await expect(page.getByRole('button', { name: /CAMARA EN VIVO/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'FOTO DEL QR' })).toBeVisible();
    await expect(connectView(page)).toBeVisible(); // no se conecta solo
    await page.getByRole('button', { name: 'Cerrar lector QR' }).click();
    await expect(page.getByRole('button', { name: 'ESCANEAR CÓDIGO QR' })).toBeVisible();
  });

  test('una foto sin QR muestra un error legible y no conecta', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'ESCANEAR CÓDIGO QR' }).click();
    await page
      .locator('.qr-scanner-panel input[type="file"]')
      .setInputFiles(path.resolve(__dirname, '../bandait-follower/public/icon-192x192.png'));
    await expect(page.getByText(/NO SE ENCONTRO UN QR LEGIBLE/)).toBeVisible({ timeout: 15_000 });
    await expect(connectView(page)).toBeVisible();
  });

  test('rechaza una IP o un puerto invalidos sin conectar', async ({ page }) => {
    await page.goto('/');
    await fillConnect(page, '192.168.1.100:4040', '4040');
    await page.getByRole('button', { name: 'ESTABLECER ENLACE STAGE' }).click();
    await expect(page.getByRole('alert')).toContainText('IP INVALIDA');
    await expect(connectView(page)).toBeVisible();

    await fillConnect(page, 'http://10.0.0.1', '4040');
    await page.getByRole('button', { name: 'ESTABLECER ENLACE STAGE' }).click();
    await expect(page.getByRole('alert')).toContainText('IP INVALIDA');

    await fillConnect(page, '10.0.0.1', '70000');
    await page.getByRole('button', { name: 'ESTABLECER ENLACE STAGE' }).click();
    await expect(page.getByRole('alert')).toContainText('PUERTO INVALIDO');
    await expect(connectView(page)).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('bandait_last_ip'))).toBeNull();
  });
});

test.describe('Follower: parametros de URL', () => {
  test('prellenan el formulario sin conectar cuando no hay auto', async ({ page }) => {
    await page.goto('/?session=ensayo&ip=10.1.2.3&port=4555&role=director');
    await expect(connectView(page)).toBeVisible();
    await expect(ipInput(page)).toHaveValue('10.1.2.3');
    await expect(portInput(page)).toHaveValue('4555');
    await expect(sessionInput(page)).toHaveValue('ensayo');
    await expect(roleSelect(page)).toHaveValue('director');
  });

  test('auto=1 entra una sola vez, se borra de la URL y SALIR no reconecta', async ({ page }) => {
    const leader = await mockLeader(page);
    await page.goto(autoJoinUrl());
    await expect(stageView(page)).toBeVisible();
    await expect(page.getByText('ENLACE ACTIVO // SESION: ensayo', { exact: false })).toBeVisible();
    const url = new URL(page.url());
    expect(url.searchParams.has('auto')).toBe(false);
    expect(url.searchParams.get('session')).toBe('ensayo');
    expect(leader.joins()).toHaveLength(1);

    await page.getByRole('button', { name: 'Salir de la sesion' }).click();
    await expect(connectView(page)).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(connectView(page)).toBeVisible();
    expect(leader.joins()).toHaveLength(1); // sin bucle de reconexion
  });
});

test.describe('Follower: audio y roles en escenario', () => {
  test('ACTIVAR AUDIO aparece sin gesto (auto) y desaparece al tocarlo', async ({ page }) => {
    await offlineLeader(page);
    await page.goto(autoJoinUrl({ role: 'drums' }));
    await expect(stageView(page)).toBeVisible();
    await expect(audioBanner(page)).toContainText('ACTIVAR AUDIO');
    await audioBanner(page).click();
    await expect(audioBanner(page)).toHaveCount(0);
  });

  test('entrar con el boton (gesto) ya arma el audio', async ({ page }) => {
    await offlineLeader(page);
    await page.goto('/');
    await fillConnect(page, LEADER_IP, LEADER_PORT);
    await page.getByRole('button', { name: 'ESTABLECER ENLACE STAGE' }).click();
    await expect(stageView(page)).toBeVisible();
    await expect(audioBanner(page)).toHaveCount(0);
  });

  test('el rol musico oculta el mando del director y su slide es SILENCIO LOCAL', async ({ page }) => {
    await offlineLeader(page);
    await page.goto(autoJoinUrl({ role: 'drums' }));
    await expect(stageView(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mando director' })).toHaveCount(0);
    await expect(page.getByText('[MANDO DIRECTOR', { exact: false })).toHaveCount(0);
    await expect(page.locator('.emergency-label')).toContainText('SILENCIO LOCAL (SOLO ESTE EQUIPO)');
    await expect(page.getByText('MUSICO:', { exact: false })).toHaveCount(0); // offline: footer muestra reconexion
    await expect(page.getByText(/RECONECTANDO/)).toBeVisible();
  });

  test('el director ve el mando, deshabilitado con motivo si no hay lider', async ({ page }) => {
    await offlineLeader(page);
    await page.goto('/');
    await roleSelect(page).selectOption('director');
    await fillConnect(page, LEADER_IP, LEADER_PORT);
    await page.getByRole('button', { name: 'ESTABLECER ENLACE STAGE' }).click();
    await expect(page.getByRole('button', { name: 'Mando director' })).toBeVisible();
    await expect(page.getByText('MANDO DESHABILITADO: SIN CONEXION CON EL LIDER')).toBeVisible();
    await expect(page.getByRole('button', { name: 'PLAY' })).toBeDisabled();
    await expect(page.locator('.emergency-label')).toContainText('PANIC (DETIENE A TODA LA BANDA)');
  });

  test('QR/URL con role=director y auto=1 entra como director (rol correcto en el cable)', async ({ page }) => {
    // Regresion: el perfil se guardaba dentro del updater de setProfile() y el
    // auto-join leia el rol anterior ("musician").
    const leader = await mockLeader(page);
    await page.goto(autoJoinUrl({ role: 'director' }));
    await expect(stageView(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mando director' })).toBeVisible();
    await expect(page.getByText('[MANDO DIRECTOR', { exact: false })).toBeVisible();
    await expect(page.locator('.emergency-label')).toContainText('PANIC (DETIENE A TODA LA BANDA)');
    await expect.poll(() => leader.joins().length).toBe(1);
    expect(leader.joins()[0]).toMatchObject({ role: 'director', session_id: 'ensayo' });
    // Persistido: tras SALIR el formulario muestra el rol director.
    await page.getByRole('button', { name: 'Salir de la sesion' }).click();
    await expect(roleSelect(page)).toHaveValue('director');
  });

  test('QR/URL con role=drums y auto=1 entra como musico', async ({ page }) => {
    const leader = await mockLeader(page);
    await page.goto(autoJoinUrl({ role: 'drums' }));
    await expect(stageView(page)).toBeVisible();
    await expect.poll(() => leader.joins().length).toBe(1);
    expect(leader.joins()[0]).toMatchObject({ role: 'musician' });
    await expect(page.getByRole('button', { name: 'Mando director' })).toHaveCount(0);
  });

  test('SILENCIO LOCAL del musico: no envia nada al lider y se libera con doble toque', async ({ page }) => {
    const leader = await mockLeader(page);
    await page.goto('/');
    await fillConnect(page, LEADER_IP, LEADER_PORT); // gesto: audio armado
    await page.getByRole('button', { name: 'ESTABLECER ENLACE STAGE' }).click();
    await expect(page.getByText('ENLACE ACTIVO', { exact: false })).toBeVisible();

    await holdEmergency(page);
    await expect(audioBanner(page)).toContainText('SILENCIO LOCAL ACTIVO');
    await expect(page.locator('.stage-rack-bar').getByText('SILENCIO LOCAL')).toBeVisible();
    await expect(page.getByText('LA BANDA SIGUE TOCANDO', { exact: false })).toBeVisible();
    expect(leader.commands()).toHaveLength(0);

    await audioBanner(page).click();
    await expect(audioBanner(page)).toContainText('TOCA OTRA VEZ');
    await audioBanner(page).click();
    await expect(audioBanner(page)).toHaveCount(0);
    expect(leader.commands()).toHaveLength(0);
  });
});

test.describe('Follower: escenario conectado (lider simulado)', () => {
  test('cancion desde el estado del lider, sync y PLAY/STOP con ack', async ({ page }) => {
    const leader = await mockLeader(page);
    await page.goto('/?role=director');
    await aliasInput(page).fill('Dir E2E');
    await fillConnect(page, LEADER_IP, LEADER_PORT, 'show');
    await page.getByRole('button', { name: 'ESTABLECER ENLACE STAGE' }).click();

    await expect(page.locator('.prompter-song-name')).toHaveText('Intro');
    await expect(page.getByText('TEMA 01/03')).toBeVisible();
    await expect(page.getByText('SIGUIENTE: Segunda // 96 BPM')).toBeVisible();
    await expect(page.getByText('SIN LETRA', { exact: true })).toBeVisible();
    await expect(page.locator('.network-beacon')).toContainText(/RTT \d+\.\d \/\/ JIT \d+\.\d ms/, { timeout: 10_000 });

    const join = leader.joins()[0];
    expect(join).toMatchObject({ session_id: 'show', role: 'director', alias: 'Dir E2E', protocol_version: 3 });
    expect(String(join.client_id)).toMatch(UUID_V4);

    await page.getByRole('button', { name: 'PLAY' }).click();
    await expect(page.getByText('PLAY ACEPTADO (PLAY)')).toBeVisible();
    await expect(page.locator('.vfd-display')).toContainText('[EN VIVO]');
    const beat = page.locator('.vfd-beat');
    await expect(beat).toHaveText(/^0[1-4]$/, { timeout: 10_000 });
    const first = await beat.textContent();
    await expect.poll(async () => beat.textContent(), { timeout: 5_000 }).not.toBe(first); // avanza por rAF

    const cmd = leader.commands()[0];
    expect(cmd).toMatchObject({ type: 'PLAY', origin: 'director_mobile', sender_id: join.client_id, session_id: 'show' });
    expect(String(cmd.command_id)).toMatch(UUID_V4);
    expect(JSON.stringify(cmd)).not.toMatch(/timestamp/i);

    await page.getByRole('button', { name: 'STOP' }).click();
    await expect(page.locator('.vfd-display')).toContainText('[DETENIDO]');
    await expect(page.locator('.vfd-digits').first()).toHaveText('---');
  });
});

test.describe('Follower: navegacion', () => {
  test('Ajustes y Biblioteca desde la pantalla de conexion', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Configuraci[oó]n/ }).click();
    await expect(page.getByRole('heading', { name: 'CONFIGURACIÓN DEL TERMINAL' })).toBeVisible();
    await expect(page.getByText(/SIN FUENTE DE AUDIO, PENDIENTE/)).toBeVisible();
    await page.getByRole('button', { name: '[VOLVER]' }).click();
    await expect(connectView(page)).toBeVisible();

    await page.getByRole('button', { name: 'Biblioteca' }).click();
    await expect(page.getByRole('heading', { name: 'BIBLIOTECA // CATÁLOGO' })).toBeVisible();
    await expect(page.getByText('IMPORTACION XLSX: PENDIENTE', { exact: false })).toBeVisible();
    await expect(page.locator('.library-view input[type="file"]')).toHaveAttribute('accept', '.json,application/json');
    await page.getByRole('button', { name: '[VOLVER]' }).click();
    await expect(connectView(page)).toBeVisible();
  });

  test('ir a Ajustes y volver no corta la sesion ni reabre el socket', async ({ page }) => {
    const leader = await mockLeader(page);
    await page.goto(autoJoinUrl());
    await expect(page.getByText('ENLACE ACTIVO', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: /Configuraci[oó]n/ }).click();
    await expect(page.getByRole('heading', { name: 'CONFIGURACIÓN DEL TERMINAL' })).toBeVisible();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: '[VOLVER]' }).click();
    await expect(stageView(page)).toBeVisible();
    await expect(page.getByText('ENLACE ACTIVO // SESION: ensayo', { exact: false })).toBeVisible();

    await page.getByRole('button', { name: 'Biblioteca' }).click();
    await page.getByRole('button', { name: '[VOLVER]' }).click();
    await expect(page.getByText('ENLACE ACTIVO // SESION: ensayo', { exact: false })).toBeVisible();
    expect(leader.joins()).toHaveLength(1);
  });
});

test.describe('Follower: viewport movil 375x812', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  /** Joins as director through the form (full toolbar on screen) against the mock leader. */
  async function directorStage(page: Page) {
    await mockLeader(page);
    await page.goto('/');
    await roleSelect(page).selectOption('director');
    await fillConnect(page, LEADER_IP, LEADER_PORT);
    await page.getByRole('button', { name: 'ESTABLECER ENLACE STAGE' }).click();
    await expect(page.getByText('[MANDO DIRECTOR', { exact: false })).toBeVisible();
    await expect(page.locator('.prompter-song-name')).toHaveText('Intro');
  }

  test('conexion sin scroll horizontal', async ({ page }) => {
    // Regresion: el grid PUERTO / ID DE SESION (1fr 2fr) se ensanchaba a ~459 px.
    await page.goto('/');
    await expect(connectView(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('escenario (director, conectado) sin scroll horizontal', async ({ page }) => {
    await directorStage(page);
    await expectNoHorizontalScroll(page);
  });

  test('ajustes y biblioteca sin scroll horizontal', async ({ page }) => {
    await directorStage(page);
    await page.getByRole('button', { name: /Configuraci[oó]n/ }).click();
    await expect(page.getByRole('heading', { name: 'CONFIGURACIÓN DEL TERMINAL' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: '[VOLVER]' }).click();

    await page.getByRole('button', { name: 'Biblioteca' }).click();
    await expect(page.getByRole('heading', { name: 'BIBLIOTECA // CATÁLOGO' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe('Follower: viewport minimo 320x640', () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });

  test('conexion y lector QR sin scroll horizontal', async ({ page }) => {
    await page.goto('/');
    await expect(connectView(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'ESCANEAR CÓDIGO QR' }).click();
    await expect(page.getByText('LECTOR DE CREDENCIAL QR')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('manual de escenario sin scroll horizontal', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Manual de Escenario' }).click();
    await expect(page.getByText('MANUAL DE ESCENARIO // GUIA DEL MUSICO')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('escenario de director conectado y mezclador sin scroll horizontal', async ({ page }) => {
    await mockLeader(page);
    await page.goto(autoJoinUrl({ role: 'director' }));
    await expect(page.getByText('[MANDO DIRECTOR', { exact: false })).toBeVisible();
    await expect(page.locator('.prompter-song-name')).toHaveText('Intro');
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'Mezclador' }).click();
    await expect(page.getByText('CONSOLA DE MONITOREO PERSONAL')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('ajustes y biblioteca sin scroll horizontal', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Configuraci[oó]n/ }).click();
    await expect(page.getByRole('heading', { name: 'CONFIGURACIÓN DEL TERMINAL' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: '[VOLVER]' }).click();
    await page.getByRole('button', { name: 'Biblioteca' }).click();
    await expect(page.getByRole('heading', { name: 'BIBLIOTECA // CATÁLOGO' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

/** GET ./leader-info.json as the leader serves it (contract section 8). */
async function servedByLeader(page: Page, over: Json = {}) {
  const info = {
    protocol_version: 3,
    leader_instance_id: LEADER_INSTANCE_ID,
    session_id: 'gira',
    ip: LEADER_IP,
    port: Number(LEADER_PORT),
    follower_url: `http://${LEADER_IP}:${LEADER_PORT}/?ip=${LEADER_IP}&port=${LEADER_PORT}&session=gira&auto=1`,
    director_url: `http://${LEADER_IP}:${LEADER_PORT}/?ip=${LEADER_IP}&port=${LEADER_PORT}&session=gira&auto=1&role=director`,
    ...over,
  };
  await page.route('**/leader-info.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(info) }),
  );
}

const servedBanner = (page: Page) => page.locator('.served-banner');

test.describe('Follower: servido por el lider (contrato seccion 8)', () => {
  test('detecta leader-info.json, prellena y une con un toque', async ({ page }) => {
    const leader = await mockLeader(page);
    await servedByLeader(page);
    await page.goto('/');
    await expect(servedBanner(page)).toContainText(`SERVIDO POR EL LIDER ${LEADER_IP}:${LEADER_PORT}`);
    await expect(servedBanner(page)).toContainText('SESION: gira');
    await expect(ipInput(page)).toHaveValue(LEADER_IP);
    await expect(portInput(page)).toHaveValue(LEADER_PORT);
    await expect(sessionInput(page)).toHaveValue('gira');

    await page.getByRole('button', { name: 'UNIRSE CON UN TOQUE' }).click();
    await expect(page.getByText('ENLACE ACTIVO // SESION: gira', { exact: false })).toBeVisible();
    await expect(audioBanner(page)).toHaveCount(0); // the tap armed audio
    expect(leader.joins()[0]).toMatchObject({ session_id: 'gira', protocol_version: 3 });
  });

  test('los parametros de URL (session, role, alias) siguen mandando', async ({ page }) => {
    await servedByLeader(page);
    await page.goto('/?session=otra&role=director&alias=Dir%20URL');
    await expect(servedBanner(page)).toBeVisible();
    await expect(sessionInput(page)).toHaveValue('otra');
    await expect(ipInput(page)).toHaveValue(LEADER_IP); // from leader-info
    await expect(roleSelect(page)).toHaveValue('director');
    await expect(aliasInput(page)).toHaveValue('Dir URL');
  });

  test('auto=1 sin ip/port/session usa leader-info y entra con el rol de la URL', async ({ page }) => {
    const leader = await mockLeader(page);
    await servedByLeader(page);
    await page.goto('/?auto=1&role=director&alias=Director%20QR');
    await expect(page.getByRole('button', { name: 'Mando director' })).toBeVisible();
    await expect.poll(() => leader.joins().length).toBe(1);
    expect(leader.joins()[0]).toMatchObject({ session_id: 'gira', role: 'director', alias: 'Director QR' });
    expect(new URL(page.url()).searchParams.has('auto')).toBe(false);
  });

  test('ignora la reescritura SPA (index.html) y versiones distintas de 3', async ({ page }) => {
    await page.route('**/leader-info.json', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div></body></html>' }),
    );
    await page.goto('/');
    await expect(connectView(page)).toBeVisible();
    await page.waitForTimeout(500);
    await expect(servedBanner(page)).toHaveCount(0);

    await page.unroute('**/leader-info.json');
    await servedByLeader(page, { protocol_version: 2 });
    await page.reload();
    await expect(connectView(page)).toBeVisible();
    await page.waitForTimeout(500);
    await expect(servedBanner(page)).toHaveCount(0);
  });
});

test.describe('Follower: contexto no seguro (HTTP desde la IP LAN)', () => {
  const lan = lanIPv4();
  test.skip(lan === null, 'Este equipo no tiene IPv4 LAN para simular http://<ip-lan>');

  test('sin camara integrada, sin service worker y pantalla por VIDEO', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await mockLeader(page);
    await page.goto(`http://${lan}:5174/`);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    await expect(page.getByText('Escanea el QR del lider con la camara del telefono')).toBeVisible();
    await expect(page.getByRole('button', { name: 'ESCANEAR CÓDIGO QR' })).toHaveCount(0);

    await fillConnect(page, LEADER_IP, LEADER_PORT);
    await page.getByRole('button', { name: 'ESTABLECER ENLACE STAGE' }).click();
    await expect(page.getByText('ENLACE ACTIVO', { exact: false })).toBeVisible();
    await expect(page.getByText('PANTALLA: VIDEO', { exact: false })).toBeVisible();
    await expect(page.getByText('PANTALLA PUEDE APAGARSE')).toHaveCount(0);
    const video = await page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>('video[data-bandait-keepawake]');
      return v ? { muted: v.muted, loop: v.loop, inline: v.hasAttribute('playsinline'), paused: v.paused } : null;
    });
    expect(video).toEqual({ muted: true, loop: true, inline: true, paused: false });
    expect(
      await page.evaluate(async () =>
        'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
      ),
    ).toBe(0);
    expect(errors).toEqual([]);
  });
});

test.describe('Follower: persistencia local', () => {
  test('alias, rol y client_id sobreviven a una recarga', async ({ page }) => {
    const leader = await mockLeader(page);
    await page.goto('/');
    await aliasInput(page).fill('Bajo Ensayo');
    await roleSelect(page).selectOption('bass');
    await page.reload();
    await expect(aliasInput(page)).toHaveValue('Bajo Ensayo');
    await expect(roleSelect(page)).toHaveValue('bass');

    await fillConnect(page, LEADER_IP, LEADER_PORT);
    await page.getByRole('button', { name: 'ESTABLECER ENLACE STAGE' }).click();
    await expect(page.getByText('ENLACE ACTIVO', { exact: false })).toBeVisible();
    const clientId = await page.evaluate(() => localStorage.getItem('bandait_client_id'));
    expect(clientId).toMatch(UUID_V4);
    expect(leader.joins()[0]).toMatchObject({ client_id: clientId, alias: 'Bajo Ensayo', role: 'musician' });

    await page.reload(); // vuelve a la pantalla de conexion con todo guardado
    await expect(ipInput(page)).toHaveValue(LEADER_IP);
    await expect(portInput(page)).toHaveValue(LEADER_PORT);
    await page.getByRole('button', { name: 'ESTABLECER ENLACE STAGE' }).click();
    await expect(page.getByText('ENLACE ACTIVO', { exact: false })).toBeVisible();
    expect(leader.joins()).toHaveLength(2);
    expect(leader.joins()[1].client_id).toBe(clientId); // mismo equipo, mismo client_id
  });
});
