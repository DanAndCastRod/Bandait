import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * E2E del Web Admin Hub (bandait-leader-web), la app publicada en /hub/.
 * Interfaz actual: pantalla de acceso (nube Supabase / Google perfil local / perfil local /
 * MODO DEMO) y 4 pestanas (PLAYLISTS, PISTAS & STEMS, INTEGRANTES, EQUIPAMIENTO).
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
  test('muestra datos demo y navega por las 4 pestañas actuales', async ({ page }) => {
    await enterDemo(page, /Carlos Mendoza/);
    await expect(page.getByText('Medianoche en Pereira').first()).toBeVisible();
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync-state', 'local_only');

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
