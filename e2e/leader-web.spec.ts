import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * E2E del Web Admin Hub (bandait-leader-web), la app publicada en /hub/.
 * Interfaz actual: pantalla de acceso (nube Supabase / Google perfil local / perfil local /
 * MODO DEMO) y 6 pestanas (PLAYLISTS, CANCIONES, VOZ Y CONTEOS, PISTAS & STEMS, INTEGRANTES,
 * EQUIPAMIENTO). El workspace es v2 (bandait-protocol/WORKSPACE_V2.md).
 *
 * No toca ningun proyecto Supabase ni Google real: cualquier peticion a *.supabase.co o a
 * accounts.google.com se registra y hace fallar la prueba que no la espera.
 */

function trackExternal(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (/supabase\.co|accounts\.google\.com/.test(url)) hits.push(url);
  });
  return hits;
}

async function enterDemo(page: Page, name: RegExp) {
  await page.goto('/');
  await page.getByTestId('demo-toggle').click();
  await page.getByTestId('demo-profiles').getByRole('button', { name }).click();
  await expect(page.getByText('BANDAIT', { exact: true }).first()).toBeVisible();
}

async function enterLocal(page: Page, name: string, email: string) {
  await page.goto('/');
  await page.getByLabel('NOMBRE O ALIAS DE MÚSICO').fill(name);
  await page.getByLabel('CORREO (ETIQUETA, NO SE VERIFICA)').fill(email);
  await page.getByRole('button', { name: 'ENTRAR CON PERFIL LOCAL' }).click();
  await expect(page.getByRole('heading', { name: 'Programación de Setlists & Transiciones' })).toBeVisible();
}

/** Workspace guardado en localStorage del perfil activo (el unico bandait_workspace_* de la prueba). */
async function storedWorkspace(page: Page): Promise<any> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('bandait_workspace_'));
    return key ? JSON.parse(localStorage.getItem(key) as string) : null;
  });
}

/** Ancho que sobra fuera de la ventana: > 0 significa scroll horizontal de la pagina. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.firma`;
}

test.describe('Web Admin Hub - acceso', () => {
  test('muestra las opciones de acceso y oculta los perfiles demo hasta elegir MODO DEMO', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Acceso a tu Workspace' })).toBeVisible();
    await expect(page.getByText('CUENTA DE NUBE // GOOGLE VIA SUPABASE')).toBeVisible();
    await expect(page.getByText('GOOGLE // PERFIL LOCAL (SIN NUBE)')).toBeVisible();
    await expect(page.getByText('PERFIL LOCAL // SOLO ESTE NAVEGADOR')).toBeVisible();

    await expect(page.getByTestId('demo-profiles')).toHaveCount(0);
    await expect(page.getByText('Carlos Mendoza')).toHaveCount(0);
    await page.getByTestId('demo-toggle').click();
    await expect(page.getByTestId('demo-profiles')).toBeVisible();
    await expect(page.getByText('Carlos Mendoza')).toBeVisible();
  });

  test('el login de nube refleja la configuracion de Supabase de la compilacion', async ({ page }) => {
    const external = trackExternal(page);
    await page.goto('/');
    const cloudBtn = page.getByTestId('cloud-login');
    await expect(cloudBtn).toBeVisible();
    if (await cloudBtn.isDisabled()) {
      // Compilacion sin VITE_SUPABASE_*: deshabilitado y con explicacion, nunca un acceso silencioso.
      await expect(page.getByTestId('cloud-disabled-reason')).toContainText('Supabase no está configurado');
    } else {
      await expect(page.getByTestId('cloud-disabled-reason')).toHaveCount(0);
    }
    expect(external, 'no debe haber llamadas a Supabase/Google al cargar').toEqual([]);
  });

  test('sin Client ID de Google el boton GIS esta deshabilitado y el script de Google no se carga', async ({ page }) => {
    const external = trackExternal(page);
    await page.goto('/');
    const gis = page.getByTestId('gis-login-disabled');
    await expect(gis).toBeVisible();
    await expect(gis).toBeDisabled();
    await expect(page.getByText('no hay un Google Client ID configurado')).toBeVisible();
    // El Client ID de relleno anterior ya no existe en la interfaz.
    expect(await page.content()).not.toContain('123456789-abcdef');
    expect(external.filter((u) => u.includes('accounts.google.com'))).toEqual([]);
  });

  test('el perfil local entra al Hub etiquetado como local y la nube queda en SOLO LOCAL', async ({ page }) => {
    const external = trackExternal(page);
    await page.goto('/');
    await page.getByLabel('NOMBRE O ALIAS DE MÚSICO').fill('Daniel Prueba');
    await page.getByLabel('CORREO (ETIQUETA, NO SE VERIFICA)').fill('daniel.prueba@example.com');
    await page.getByRole('button', { name: 'ENTRAR CON PERFIL LOCAL' }).click();

    await expect(page.getByRole('heading', { name: 'Programación de Setlists & Transiciones' })).toBeVisible();
    const sync = page.getByTestId('sync-status');
    await expect(sync).toHaveAttribute('data-sync-state', 'local_only');
    await expect(sync).toContainText('SOLO LOCAL');

    await page.getByTitle(/Usuario: Daniel Prueba/).click();
    await expect(page.getByTestId('profile-provider')).toHaveText('PERFIL LOCAL (SIN VERIFICAR)');
    await expect(page.getByText('CUENTA VERIFICADA')).toHaveCount(0);

    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys.some((k) => k.startsWith('bandait_workspace_local_'))).toBe(true);
    expect(keys.some((k) => k.startsWith('sb-'))).toBe(false);
    expect(external).toEqual([]);
  });

  test('el modal NUBE rechaza una clave service_role sin guardarla', async ({ page }) => {
    const external = trackExternal(page);
    await page.goto('/');
    await page.getByRole('button', { name: /Configurar Supabase|Ver configuración/ }).first().click();
    await page.getByLabel('SUPABASE PROJECT URL').fill('https://proyectoejemplo.supabase.co');
    await page.getByLabel('SUPABASE ANON / PUBLISHABLE KEY').fill(fakeJwt({ iss: 'supabase', ref: 'proyectoejemplo', role: 'service_role' }));
    await page.getByRole('button', { name: 'GUARDAR Y RECARGAR' }).click();

    await expect(page.getByTestId('cloud-form-message')).toContainText('service_role rechazada');
    const stored = await page.evaluate(() => [localStorage.getItem('bandait_supabase_url'), localStorage.getItem('bandait_supabase_anon_key')]);
    expect(stored).toEqual([null, null]);
    expect(external).toEqual([]);
  });
});

test.describe('Web Admin Hub - workspace (MODO DEMO)', () => {
  test('muestra datos demo y navega por las 6 pestañas actuales', async ({ page }) => {
    await enterDemo(page, /Carlos Mendoza/);
    await expect(page.getByText('Medianoche en Pereira').first()).toBeVisible();
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync-state', 'local_only');

    await page.getByRole('button', { name: 'CANCIONES', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Librería de Canciones' })).toBeVisible();

    await page.getByRole('button', { name: 'VOZ Y CONTEOS', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Voz y Conteos' })).toBeVisible();

    await page.getByRole('button', { name: 'PISTAS & STEMS' }).click();
    await expect(page.getByRole('heading', { name: 'Gestión de Pistas & Stems Multicanal' })).toBeVisible();

    await page.getByRole('button', { name: 'INTEGRANTES' }).click();
    await expect(page.getByRole('heading', { name: 'Integrantes & Matriz de Roles' })).toBeVisible();

    await page.getByRole('button', { name: 'EQUIPAMIENTO' }).click();
    await expect(page.getByRole('heading', { name: 'Rider Técnico & Ruteo de Equipos' })).toBeVisible();

    await page.getByRole('button', { name: 'PLAYLISTS' }).click();
    await expect(page.getByRole('heading', { name: 'Programación de Setlists & Transiciones' })).toBeVisible();
  });

  test('roles: el Owner cambia el rol de otro integrante pero no el suyo', async ({ page }) => {
    await enterDemo(page, /Carlos Mendoza/);
    await page.getByRole('button', { name: 'INTEGRANTES' }).click();
    await expect(page.getByTestId('role-guard-note')).toBeVisible();

    const own = page.getByLabel('Rol de Carlos Mendoza');
    await expect(own).toBeDisabled();
    await expect(own).toHaveAttribute('title', 'No puedes cambiar tu propio rol.');

    const other = page.getByLabel('Rol de Mateo Gómez');
    await expect(other).toBeEnabled();
    await other.selectOption('Substitute');
    await expect(other).toHaveValue('Substitute');
    await expect(page.getByTestId('role-error')).toHaveCount(0);
  });

  test('roles: quien no es Owner no puede cambiar ningun rol', async ({ page }) => {
    await enterDemo(page, /Alejandro Vélez/);
    await page.getByRole('button', { name: 'INTEGRANTES' }).click();
    const selects = page.locator('select[aria-label^="Rol de "]');
    await expect(selects).toHaveCount(5);
    for (const s of await selects.all()) {
      await expect(s).toBeDisabled();
    }
    await expect(page.getByLabel('Rol de Mateo Gómez')).toHaveAttribute('title', 'Solo un Owner puede cambiar roles.');
  });

  test('EXPORTAR JSON descarga un archivo .json con el workspace de la banda', async ({ page }) => {
    await enterDemo(page, /Carlos Mendoza/);
    await expect(page.getByText('XLSX', { exact: false })).toHaveCount(0);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'EXPORTAR JSON' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^bandait_los_inquietos_del_rock_\d{4}-\d{2}-\d{2}\.json$/);
    const path = await download.path();
    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(data.formato).toBe('json');
    expect(data.agrupacion.name).toBe('Los Inquietos del Rock');
    // Documento v2 completo: el mismo que descarga el lider.
    expect(data.workspace.schemaVersion).toBe(2);
    expect(data.workspace.bands).toHaveLength(3);
    expect(Object.keys(data.workspace.songsMap)).toEqual(expect.arrayContaining(['band_01', 'band_02', 'band_03']));
    expect(data.workspace.voiceMap.band_01.voice).toBe('es-CO-SalomeNeural');
    expect(data.canciones.length).toBeGreaterThan(0);
    const songIds = new Set(data.canciones.map((c: { id: string }) => c.id));
    for (const pl of data.setlists) for (const it of pl.songs) expect(songIds.has(it.songId)).toBe(true);
  });

  test('aplica el tema oscuro', async ({ page }) => {
    await enterDemo(page, /Carlos Mendoza/);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const rgb = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(rgb, `fondo inesperado: ${bg}`).not.toBeNull();
    const [, r, g, b] = (rgb as RegExpMatchArray).map(Number);
    expect((r + g + b) / 3).toBeLessThan(40);
  });

  test('en movil muestra la barra inferior de navegacion', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await enterDemo(page, /Carlos Mendoza/);
    const bottom = page.locator('nav.hub-mobile-nav');
    await expect(bottom).toBeVisible();
    await bottom.getByRole('button', { name: 'BANDA' }).click();
    await expect(page.getByRole('heading', { name: 'Integrantes & Matriz de Roles' })).toBeVisible();
  });
});

const PASTED_CHORDPRO = [
  '{title: Luz de Neón}',
  '{artist: Banda E2E}',
  '{start_of_verse: Estrofa 1}',
  '[Am]Hoy vuelvo a [F]casa',
  '{end_of_verse}',
  '',
  'Coro:',
  '[F]Canta [G]fuerte, [Am]canta',
].join('\n');

test.describe('Web Admin Hub - librería v2 (CANCIONES, setlist, VOZ)', () => {
  test('crea una canción de 2 secciones pegando ChordPro, la añade al setlist con auto_count_in y persiste al recargar', async ({ page }) => {
    const external = trackExternal(page);
    await enterLocal(page, 'Directora E2E', 'directora.e2e@example.com');

    await page.getByRole('button', { name: 'CANCIONES', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Librería de Canciones' })).toBeVisible();
    // La migracion v1 -> v2 ya puso en la libreria el tema del setlist semilla.
    await expect(page.getByTestId('song-card').filter({ hasText: 'Tema 1 (Apertura Show)' })).toBeVisible();

    await page.getByRole('button', { name: 'NUEVA CANCIÓN' }).click();
    const editor = page.getByTestId('song-editor');
    await editor.getByRole('button', { name: 'PEGAR CHORDPRO COMPLETO' }).click();
    await editor.getByLabel(/PEGA LA CANCIÓN EN CHORDPRO/).fill(PASTED_CHORDPRO);
    await expect(editor.getByTestId('chordpro-paste-result')).toContainText('2 SECCIÓN(ES) DETECTADA(S): Estrofa 1 · Coro');
    await editor.getByRole('button', { name: 'APLICAR SECCIONES' }).click();

    await expect(editor.getByTestId('section-row')).toHaveCount(2);
    await expect(editor.getByLabel('TÍTULO', { exact: true })).toHaveValue('Luz de Neón');
    await expect(editor.getByLabel('ARTISTA / AUTOR')).toHaveValue('Banda E2E');
    await expect(editor.getByLabel('Tipo de la sección 2')).toHaveValue('chorus');
    await expect(editor.getByLabel('ChordPro de la sección 1')).toHaveValue('[Am]Hoy vuelvo a [F]casa');
    await expect(editor.getByTestId('song-total-bars')).toHaveText('16');

    await editor.getByLabel('Compases de la sección 1').fill('4');
    await editor.getByLabel(/^BPM/).fill('100');
    await expect(editor.getByTestId('song-total-bars')).toHaveText('12');
    await expect(editor.getByTestId('section-start').nth(1)).toHaveText('COMPÁS 5-12');
    await expect(editor.getByTestId('song-duration')).toHaveText('0:29'); // 12 * 4 * 60 / 100 = 28.8 s

    await editor.getByLabel('Aviso de voz de la sección 2').selectOption('custom');
    await editor.getByLabel('Texto del aviso de la sección 2').fill('Coro, todos');
    await editor.getByRole('button', { name: 'VISTA PREVIA' }).first().click();
    await expect(editor.getByTestId('chordpro-chords').first()).toHaveText(/^Am\s+F$/);

    await editor.getByTestId('song-save').click();
    await expect(page.getByTestId('song-editor')).toHaveCount(0);
    const card = page.getByTestId('song-card').filter({ hasText: 'Luz de Neón' });
    await expect(card.getByTestId('song-card-sections')).toContainText('2 secciones · 12 compases');

    await page.getByRole('button', { name: 'PLAYLISTS', exact: true }).click();
    await page.getByRole('button', { name: 'AÑADIR CANCIÓN', exact: true }).click();
    const picker = page.getByTestId('setlist-add-song');
    await picker.getByLabel('Buscar en la librería').fill('neon'); // sin tilde: la busqueda la ignora
    await expect(picker.getByTestId('library-pick')).toHaveCount(1);
    await picker.getByRole('button', { name: 'Añadir Luz de Neón' }).click();
    await expect(picker.getByTestId('setlist-add-feedback')).toContainText('Luz de Neón');
    await picker.getByRole('button', { name: 'CERRAR', exact: true }).click();

    const row = page.getByTestId('setlist-row').filter({ hasText: 'Luz de Neón' });
    await expect(row).toHaveCount(1);
    await row.getByTestId('item-transition').selectOption('auto_count_in');
    await expect(row.getByTestId('item-transition-help')).toContainText('arranca solo');
    await row.getByTestId('item-countin').selectOption('2');
    await row.getByTestId('item-gap').fill('3');
    await row.getByTestId('item-gap').press('Enter');
    // La anterior ("Tema 1") no tiene secciones: su final es desconocido.
    await expect(row.getByTestId('item-transition-warning')).toContainText('no tiene secciones');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Programación de Setlists & Transiciones' })).toBeVisible();
    const after = page.getByTestId('setlist-row').filter({ hasText: 'Luz de Neón' });
    await expect(after.getByTestId('item-transition')).toHaveValue('auto_count_in');
    await expect(after.getByTestId('item-countin')).toHaveValue('2');
    await expect(after.getByTestId('item-gap')).toHaveValue('3');
    await expect(after.getByTestId('item-bpm')).toHaveValue('100');

    const ws = await storedWorkspace(page);
    expect(ws.schemaVersion).toBe(2);
    const band = ws.activeBandId;
    const song = ws.songsMap[band].find((s: { title: string }) => s.title === 'Luz de Neón');
    expect(song.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(song.sections.map((s: { kind: string; bars: number }) => [s.kind, s.bars])).toEqual([
      ['verse', 4],
      ['chorus', 8],
    ]);
    expect(song.sections[0].chordpro).toBe('[Am]Hoy vuelvo a [F]casa');
    expect('cueText' in song.sections[0]).toBe(false);
    expect(song.sections[1].cueText).toBe('Coro, todos');
    const item = ws.playlistsMap[band][0].songs.find((i: { songId: string }) => i.songId === song.id);
    expect(item).toMatchObject({ transitionMode: 'auto_count_in', countInBars: 2, countInVoice: true, gapSec: 3, bpm: 100, title: 'Luz de Neón' });

    await page.getByRole('button', { name: 'CANCIONES', exact: true }).click();
    await expect(page.getByTestId('song-card').filter({ hasText: 'Luz de Neón' }).getByTestId('song-card-sections')).toContainText(
      '2 secciones · 12 compases'
    );
    expect(external).toEqual([]);
  });

  test('editar conserva los ids de la canción y de sus secciones', async ({ page }) => {
    await enterDemo(page, /Carlos Mendoza/);
    const before = await storedWorkspace(page);
    const original = before.songsMap.band_01.find((s: { title: string }) => s.title === 'Medianoche en Pereira');

    await page.getByRole('button', { name: 'CANCIONES', exact: true }).click();
    await page.getByTestId('song-card').filter({ hasText: 'Medianoche en Pereira' }).getByRole('button', { name: 'EDITAR' }).click();
    const editor = page.getByTestId('song-editor');
    await expect(editor.getByTestId('section-row')).toHaveCount(5);
    await editor.getByRole('button', { name: 'Bajar la sección 1' }).click();
    await editor.getByLabel('Compases de la sección 1').fill('16');
    await editor.getByTestId('song-save').click();

    const after = await storedWorkspace(page);
    const saved = after.songsMap.band_01.find((s: { id: string }) => s.id === original.id);
    expect(saved).toBeTruthy();
    const ids = (song: { sections: Array<{ id: string }> }) => song.sections.map((s) => s.id);
    expect(ids(saved)).toEqual([ids(original)[1], ids(original)[0], ...ids(original).slice(2)]);
    expect(saved.sections[0].bars).toBe(16);
  });

  test('borrar una canción usada en un setlist pide confirmación y muestra qué setlists la usan', async ({ page }) => {
    await enterDemo(page, /Carlos Mendoza/);
    await page.getByRole('button', { name: 'CANCIONES', exact: true }).click();
    await page.getByRole('button', { name: 'Eliminar Ruta del Café' }).click();
    const dialog = page.getByTestId('song-delete-confirm');
    await expect(dialog.getByTestId('song-delete-usage')).toContainText('Gira Nacional 2026');
    await dialog.getByRole('button', { name: 'CANCELAR' }).click();
    await expect(page.getByTestId('song-card').filter({ hasText: 'Ruta del Café' })).toHaveCount(1);

    await page.getByRole('button', { name: 'Eliminar Ruta del Café' }).click();
    await page.getByTestId('song-delete-confirm').getByRole('button', { name: 'ELIMINAR Y QUITAR DE LOS SETLISTS' }).click();
    await expect(page.getByTestId('song-card').filter({ hasText: 'Ruta del Café' })).toHaveCount(0);

    await page.getByRole('button', { name: 'PLAYLISTS', exact: true }).click();
    await expect(page.getByTestId('setlist-row')).toHaveCount(3);
    await expect(page.getByTestId('setlist-row').filter({ hasText: 'Ruta del Café' })).toHaveCount(0);
    const ws = await storedWorkspace(page);
    const ids = new Set(ws.songsMap.band_01.map((s: { id: string }) => s.id));
    for (const it of ws.playlistsMap.band_01[0].songs) expect(ids.has(it.songId)).toBe(true);
  });

  test('VOZ Y CONTEOS guarda la configuración de la banda y avisa que el audio se genera antes del show', async ({ page }) => {
    const external = trackExternal(page);
    await enterDemo(page, /Carlos Mendoza/);
    await page.getByRole('button', { name: 'VOZ Y CONTEOS', exact: true }).click();
    await expect(page.getByTestId('voice-note')).toContainText('antes del show');
    await expect(page.getByTestId('voice-note')).toContainText('versión posterior');

    await page.getByLabel('Activar voz en el show').check();
    await page.getByLabel('VOZ (AZURE, ES-CO)').selectOption('es-CO-GonzaloNeural');
    await page.getByLabel(/^VELOCIDAD/).selectOption('35');
    await page.getByLabel('AVISO ANTES DE CADA SECCIÓN').selectOption('2');
    await page.getByLabel('SALIDA DEL LÍDER').selectOption('all_in_ear');
    await page.getByLabel('Avisar cada sección').uncheck();

    await page.reload();
    await page.getByRole('button', { name: 'VOZ Y CONTEOS', exact: true }).click();
    await expect(page.getByLabel('Activar voz en el show')).toBeChecked();
    await expect(page.getByLabel('VOZ (AZURE, ES-CO)')).toHaveValue('es-CO-GonzaloNeural');
    const ws = await storedWorkspace(page);
    expect(ws.voiceMap.band_01).toEqual({
      enabled: true,
      provider: 'azure',
      voice: 'es-CO-GonzaloNeural',
      rate: '+35%',
      countIn: true,
      sectionCues: false,
      cueLeadBars: 2,
      output: 'all_in_ear',
    });
    expect(ws.voiceMap.band_02.enabled).toBe(false);
    expect(external).toEqual([]);
  });

  test('importar un JSON v1 lo migra a v2 al cargarlo', async ({ page }) => {
    await enterDemo(page, /Carlos Mendoza/);
    const v1 = {
      bands: [{ id: 'band_imp', name: 'Banda Importada', ownerId: 'usr_director_01', currentUserRole: 'Owner', membersCount: 1, createdAt: '2026-09-01' }],
      activeBandId: 'band_imp',
      membersMap: { band_imp: [] },
      playlistsMap: {
        band_imp: [
          {
            id: 'pl_imp',
            bandId: 'band_imp',
            name: 'Show importado',
            createdAt: '2026-09-01',
            updatedAt: '2026-09-02',
            songs: [
              { id: 'it_1', orderIndex: 1, title: 'Tema Viejo', artist: 'Banda Importada', bpm: 110, key: 'G', showKey: 'G', camelot: '9B', durationSec: 200, transitionMode: 'manual_cue', countInBars: 1 },
            ],
          },
        ],
      },
      equipmentMap: { band_imp: [] },
      stemsMap: {},
    };
    await page.getByTitle(/Usuario: Carlos Mendoza/).click();
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('import-workspace-file').setInputFiles({
      name: 'workspace_v1.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(v1)),
    });
    await expect(page.getByTestId('import-workspace-message')).toContainText('Workspace importado: 1 banda(s)');
    const ws = await storedWorkspace(page);
    expect(ws.schemaVersion).toBe(2);
    const [song] = ws.songsMap.band_imp;
    expect(song).toMatchObject({ title: 'Tema Viejo', bpm: 110, key: 'G', beatsPerBar: 4, sections: [] });
    expect(ws.playlistsMap.band_imp[0].songs[0]).toMatchObject({ id: 'it_1', songId: song.id, countInVoice: true, gapSec: 0 });
  });

  test('móvil 375 px: CANCIONES, editor, VOZ y SETLISTS sin scroll horizontal', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await enterDemo(page, /Carlos Mendoza/);
    const bottom = page.locator('nav.hub-mobile-nav');

    await bottom.getByRole('button', { name: 'CANCIONES' }).click();
    await expect(page.getByRole('heading', { name: 'Librería de Canciones' })).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await page.getByTestId('song-card').filter({ hasText: 'Medianoche en Pereira' }).getByRole('button', { name: 'EDITAR' }).click();
    const editor = page.getByTestId('song-editor');
    await expect(editor.getByTestId('section-row')).toHaveCount(5);
    // Cada clic cambia el boton a OCULTAR: abrir siempre el primero que queda.
    const previews = editor.getByRole('button', { name: 'VISTA PREVIA' });
    while ((await previews.count()) > 0) await previews.first().click();
    await expect(editor.getByTestId('chordpro-preview')).toHaveCount(5);
    await editor.getByRole('button', { name: 'PEGAR CHORDPRO COMPLETO' }).click();
    await editor.getByLabel(/PEGA LA CANCIÓN EN CHORDPRO/).fill(PASTED_CHORDPRO);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const box = await editor.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
    await editor.getByRole('button', { name: 'CANCELAR' }).first().click();
    await editor.getByRole('button', { name: 'CANCELAR' }).click();

    await bottom.getByRole('button', { name: 'VOZ' }).click();
    await expect(page.getByRole('heading', { name: 'Voz y Conteos' })).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await bottom.getByRole('button', { name: 'SETLISTS' }).click();
    await expect(page.getByRole('heading', { name: 'Programación de Setlists & Transiciones' })).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'AÑADIR CANCIÓN', exact: true }).click();
    await expect(page.getByTestId('setlist-add-song')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});
