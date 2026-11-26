import { test, expect, type Page } from '@playwright/test';
import { FakeSupabase, USER, signInWithFakeCloud, workspaceWith } from './support/fakeSupabase';

/**
 * E2E de APARIENCIA (docs/REQUERIMIENTOS_WEB_3.0.md, seccion 1): temas Dark Grafito / Light
 * Estudio, acento libre con tinta de contraste WCAG, redondez de 8 a 999 px, transporte siempre
 * circular y persistencia por musico (workspace personal, nunca la banda compartida).
 */

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

async function openAppearance(page: Page) {
  await page.locator('nav.hub-desktop-nav').getByRole('button', { name: 'AJUSTES' }).click();
  await page.getByRole('tab', { name: 'APARIENCIA' }).click();
  await expect(page.getByTestId('appearance-settings')).toBeVisible();
}

const rootVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const radiusOf = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((el) => getComputedStyle(el).borderTopLeftRadius);

/** Radio minimo (px) entre los botones visibles de la pagina, sin contar el transporte. */
async function minButtonRadius(page: Page): Promise<{ min: number; offenders: string[] }> {
  return page.evaluate(() => {
    const out: string[] = [];
    let min = Infinity;
    for (const el of Array.from(document.querySelectorAll('button, [role="button"]'))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const r = parseFloat(getComputedStyle(el).borderTopLeftRadius);
      min = Math.min(min, r);
      if (r < 8) out.push(`${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${r}px`);
    }
    return { min, offenders: out };
  });
}

test.describe('Web Admin Hub - apariencia', () => {
  test('Light Estudio, acento con tinta WCAG, redondez y persistencia tras recargar', async ({ page }) => {
    await enterDemo(page);
    expect(await theme(page)).toBe('dark-grafito');
    await openAppearance(page);
    await expect(page.getByRole('tab')).toHaveText(['VOZ Y CONTEOS', 'EQUIPAMIENTO', 'APARIENCIA']);

    // Tema
    await page.getByTestId('appearance-theme-light-estudio').click();
    await expect(page.getByTestId('appearance-theme-light-estudio')).toHaveAttribute('aria-checked', 'true');
    expect(await theme(page)).toBe('light-estudio');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(242, 243, 245)');
    // Sin acento propio: el del tema, con tinta blanca.
    expect(await rootVar(page, '--b-accent')).toBe('#1A7F7A');
    expect(await rootVar(page, '--b-on-accent')).toBe('#FFFFFF');

    // Acento claro -> tinta oscura
    const hex = page.getByTestId('appearance-accent-hex');
    await hex.fill('#D9A24E');
    await hex.press('Enter');
    expect(await rootVar(page, '--b-accent')).toBe('#D9A24E');
    expect(await rootVar(page, '--b-on-accent')).toBe('#15181C');
    await expect(page.getByTestId('appearance-contrast')).toContainText('con tinta #15181C');
    await expect(page.getByTestId('appearance-accent-adjusted')).toHaveCount(0);

    // Acento oscuro -> tinta blanca (por el selector de color)
    await page.getByTestId('appearance-accent-picker').fill('#2b62a8');
    expect(await rootVar(page, '--b-accent')).toBe('#2B62A8');
    expect(await rootVar(page, '--b-on-accent')).toBe('#FFFFFF');

    // Gris medio: ninguna tinta llega a 4,5:1 -> se ajusta y se avisa
    await hex.fill('#787878');
    await hex.press('Enter');
    await expect(page.getByTestId('appearance-accent-adjusted')).toContainText('#787878 no llega a 4,5:1');
    expect(await rootVar(page, '--b-accent')).not.toBe('#787878');
    const ratio = await page.getByTestId('appearance-contrast').innerText();
    expect(Number(/(\d+,\d):1/.exec(ratio)![1].replace(',', '.'))).toBeGreaterThanOrEqual(4.5);

    // Acento final para la persistencia
    await hex.fill('#E06C9F');
    await hex.press('Enter');
    expect(await rootVar(page, '--b-on-accent')).toBe('#15181C');

    // Redondez: acotada a 8..999, aplicada a los botones del Hub
    const radius = page.getByTestId('appearance-radius-input');
    await radius.fill('3');
    await radius.press('Enter');
    await expect(radius).toHaveValue('8');
    expect(await rootVar(page, '--b-radius')).toBe('8px');
    const atMin = await minButtonRadius(page);
    expect(atMin.offenders).toEqual([]);
    await radius.fill('999');
    await radius.press('Enter');
    expect(await rootVar(page, '--b-radius')).toBe('999px');
    await expect(page.getByTestId('appearance-radius-value')).toContainText('PÍLDORA');
    expect(await radiusOf(page, 'appearance-reset')).toBe('999px');
    // El selector de banda de la barra (estilo en linea de 4px) tambien sigue la redondez.
    expect(parseFloat(await page.getByTestId('band-switcher').evaluate((el) => getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThanOrEqual(8);
    await page.getByTestId('appearance-radius-slider').fill('4'); // parada 4 = 16 px
    expect(await rootVar(page, '--b-radius')).toBe('16px');

    // Recargar: todo sigue igual y el tema llega antes del primer render
    await page.reload();
    expect(await theme(page)).toBe('light-estudio');
    await expect(page.getByText('BANDAIT', { exact: true }).first()).toBeVisible();
    expect(await rootVar(page, '--b-accent')).toBe('#E06C9F');
    expect(await rootVar(page, '--b-radius')).toBe('16px');
    await openAppearance(page);
    await expect(page.getByTestId('appearance-accent-hex')).toHaveValue('#E06C9F');
    await expect(page.getByTestId('appearance-radius-input')).toHaveValue('16');
    const stored = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('bandait_workspace_'));
      return key ? JSON.parse(localStorage.getItem(key) || '{}').uiPreferences : null;
    });
    expect(stored).toEqual({ version: 1, theme: 'light-estudio', accent: '#E06C9F', radius: 16 });

    // Sin el bundle (main.tsx bloqueado) el script de index.html ya aplico tema, acento y redondez.
    await page.route('**/src/main.tsx*', (route) => route.abort());
    await page.reload();
    expect(await theme(page)).toBe('light-estudio');
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--b-accent'))).toBe('#E06C9F');
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--b-radius'))).toBe('16px');
    await page.unroute('**/src/main.tsx*');

    // RESTABLECER vuelve a Dark Grafito, acento del tema y pildora (999 px, el valor por defecto).
    await page.reload();
    await openAppearance(page);
    await page.getByTestId('appearance-reset').click();
    expect(await theme(page)).toBe('dark-grafito');
    expect(await rootVar(page, '--b-accent')).toBe('#5CC8C2');
    expect(await rootVar(page, '--b-radius')).toBe('999px');
  });

  test('transporte siempre circular: Estudio y reproductor de stems, con redondez 8 y 999', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('bandait_studio', '1'));
    await enterDemo(page);
    await openAppearance(page);
    const radius = page.getByTestId('appearance-radius-input');

    // Estudio: Stop, Play y Grabar (.stu-key). Al salir del Estudio se vuelve a su inicio, asi que
    // cada pasada abre una maqueta nueva.
    const keys = page.locator('[data-testid="studio-transport"] .stu-key');
    for (const r of ['8', '999']) {
      await page.locator('nav.hub-desktop-nav').getByRole('button', { name: 'AJUSTES' }).click();
      await page.getByRole('tab', { name: 'APARIENCIA' }).click();
      await radius.fill(r);
      await radius.press('Enter');
      await page.getByRole('button', { name: 'ESTUDIO', exact: true }).first().click();
      await expect(page.getByTestId('studio-home')).toBeVisible();
      await expect(page.getByTestId('studio-create')).toBeEnabled();
      await page.getByTestId('studio-new-title').fill(`Apariencia ${r}`);
      await page.getByTestId('studio-create').click();
      await expect(page.getByTestId('studio-workspace')).toBeVisible();
      await expect(keys).toHaveCount(3);
      const shapes = await keys.evaluateAll((els) =>
        els.map((el) => {
          const box = el.getBoundingClientRect();
          return { radius: getComputedStyle(el).borderTopLeftRadius, w: Math.round(box.width), h: Math.round(box.height) };
        })
      );
      for (const s of shapes) {
        expect(s.radius).toBe('9999px');
        expect(s.w).toBe(s.h);
      }
      // El resto de botones del Estudio respeta el minimo de 8 px.
      expect((await minButtonRadius(page)).offenders).toEqual([]);
    }

    // Reproductor de stems (PISTAS): REPRODUCIR / STOP con forma de pildora (9999px) aunque la redondez sea 8.
    await page.locator('nav.hub-desktop-nav').getByRole('button', { name: 'AJUSTES' }).click();
    await page.getByRole('tab', { name: 'APARIENCIA' }).click();
    await radius.fill('8');
    await radius.press('Enter');
    await page.locator('nav.hub-desktop-nav').getByRole('button', { name: 'PISTAS', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Estudio de Stems' })).toBeVisible();
    await page.getByTestId('stem-song-select').selectOption({ label: 'Medianoche en Pereira' });
    await page.getByTestId('stem-file-input').setInputFiles([{ name: 'Medianoche en Pereira_drums.wav', mimeType: 'audio/wav', buffer: wav(1, 110) }]);
    await expect(page.getByTestId('stem-candidate')).toHaveCount(1);
    await page.getByTestId('stem-save').click();
    await expect(page.locator('[data-testid="stem-track"][data-status="ok"]')).toHaveCount(1, { timeout: 15000 });
    expect(await radiusOf(page, 'stem-play')).toBe('9999px');
    expect(await radiusOf(page, 'stem-stop')).toBe('9999px');
  });

  test('lienzos del Estudio con Light Estudio: carriles y regla claros; repinta al cambiar el tema', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('bandait_studio', '1'));
    await enterDemo(page);
    await openAppearance(page);
    await page.getByTestId('appearance-theme-light-estudio').click();
    expect(await theme(page)).toBe('light-estudio');

    await page.getByRole('button', { name: 'ESTUDIO', exact: true }).first().click();
    await expect(page.getByTestId('studio-create')).toBeEnabled();
    await page.getByTestId('studio-new-title').fill('Lienzo claro');
    await page.getByTestId('studio-create').click();
    await expect(page.getByTestId('studio-workspace')).toBeVisible();
    await page.getByTestId('studio-add-track').click();
    await page.getByTestId('studio-add-track').click();
    await expect(page.locator('[data-testid^="studio-arm-"]')).toHaveCount(2);

    // Mediana de una franja de pixeles del canvas (en px CSS): esquiva las lineas de la rejilla.
    const stripe = (y: number) =>
      page.getByTestId('studio-canvas').evaluate((el, cssY) => {
        const canvas = el as HTMLCanvasElement;
        const ctx = canvas.getContext('2d')!;
        const dpr = canvas.width / canvas.clientWidth;
        const row = ctx.getImageData(0, Math.round(cssY * dpr), Math.round(160 * dpr), 1).data;
        const lum: number[] = [];
        for (let i = 0; i < row.length; i += 4) lum.push(0.2126 * row[i] + 0.7152 * row[i + 1] + 0.0722 * row[i + 2]);
        lum.sort((a, b) => a - b);
        return lum[Math.floor(lum.length / 2)];
      }, y);
    // Regla de 46 px; carril de la primera pista de 46 a 158 y de la segunda de 158 a 270.
    const lanes = async () => ({ ruler: await stripe(30), first: await stripe(100), second: await stripe(212) });

    await expect.poll(async () => (await lanes()).first, { timeout: 5000 }).toBeGreaterThan(200);
    const light = await lanes();
    expect(light.second).toBeGreaterThan(200);
    expect(light.ruler).toBeGreaterThan(200);

    // applyAppearance avisa el cambio (bandait:appearance) con el lienzo montado: se repinta oscuro
    // en el siguiente cuadro, sin recargar ni salir del Estudio.
    await page.evaluate(() => {
      const root = document.documentElement;
      root.dataset.theme = 'dark-grafito';
      root.style.setProperty('--b-accent', '#5CC8C2');
      window.dispatchEvent(new CustomEvent('bandait:appearance', { detail: { theme: 'dark-grafito', accent: '#5CC8C2' } }));
    });
    await expect.poll(async () => (await lanes()).first, { timeout: 5000 }).toBeLessThan(40);
    const dark = await lanes();
    expect(dark.second).toBeLessThan(40);
    expect(dark.ruler).toBeLessThan(40);
  });

  test('un Musician de solo lectura en una banda compartida cambia SU apariencia: va a bandait_workspaces, no a la banda', async ({ page }) => {
    const fake = new FakeSupabase();
    fake.workspaces.push({ user_id: USER.id, workspace: workspaceWith('band_daniel_01', 'Banda de Daniel', ['Tema A']), updated_at: fake.now() });
    const sharedId = 'bbbbbbbb-1111-4111-8111-000000000001';
    const content = { ...workspaceWith(sharedId, 'Banda Ajena', ['Tema B']), bands: [{ id: sharedId, name: 'Banda Ajena', genre: '', ownerId: 'otro', currentUserRole: 'Owner', membersCount: 1, createdAt: '2026-11-01' }] };
    fake.bands.push({ id: sharedId, owner_id: '22222222-2222-4222-8222-222222222222', updated_at: fake.now(), content });
    fake.members.push({ band_id: sharedId, email: USER.email, role: 'Musician', name: 'Daniel Castaneda', instrument: 'Guitarra', created_at: fake.now() });
    const bandBefore = JSON.stringify(fake.bands[0].content);
    const patches: string[] = [];
    page.on('request', (req) => {
      if (req.method() !== 'GET' && req.url().includes('/rest/v1/')) patches.push(new URL(req.url()).pathname);
    });

    await signInWithFakeCloud(page, fake);
    await expect(page.getByTestId('band-switcher')).toContainText('Banda de Daniel');
    await page.getByTestId('band-switcher').click();
    await page.getByRole('button', { name: /Banda Ajena/ }).click();
    await expect(page.getByTestId('band-switcher')).toContainText('Banda Ajena');

    await openAppearance(page);
    await page.getByTestId('appearance-theme-light-estudio').click();
    const radius = page.getByTestId('appearance-radius-input');
    await radius.fill('24');
    await radius.press('Enter');
    expect(await theme(page)).toBe('light-estudio');
    await expect(page.getByText(/solo lectura para tu rol/)).toHaveCount(0);

    await expect
      .poll(() => fake.workspaces[0].workspace.uiPreferences, { timeout: 10000 })
      .toEqual({ version: 1, theme: 'light-estudio', accent: null, radius: 24 });
    expect(JSON.stringify(fake.bands[0].content)).toBe(bandBefore);
    expect(fake.bands[0].content.uiPreferences).toBeUndefined();
    expect(patches.filter((p) => p.endsWith('/bandait_bands'))).toEqual([]);
    // La banda compartida sigue siendo de solo lectura para todo lo demas: nada se escribio en ella.
    expect(fake.workspaces[0].workspace.bands.map((b: { id: string }) => b.id)).not.toContain(sharedId);
  });
});
