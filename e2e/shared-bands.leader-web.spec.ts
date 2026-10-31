import { test, expect } from '@playwright/test';
import { FakeSupabase, USER, signInWithFakeCloud, workspaceWith, type Row } from './support/fakeSupabase';

/**
 * E2E de bandas compartidas contra un Supabase SIMULADO dentro de Playwright: sesion de
 * Supabase Auth inyectada en localStorage y PostgREST en memoria (sin RLS: eso lo prueba
 * `npm run test:rls` contra Postgres real). Nunca toca el proyecto real.
 */

test.describe('Web Admin Hub - bandas compartidas (Supabase simulado)', () => {
  test('compartir comparte la banda SELECCIONADA y el enlace sigue a la banda activa', async ({ page }) => {
    const fake = new FakeSupabase();
    // La cuenta ya tenia en la nube su banda por defecto.
    fake.workspaces.push({
      user_id: USER.id,
      workspace: workspaceWith('band_daniel_01', 'Banda de Daniel', ['Tema A']),
      updated_at: fake.now(),
    });
    await signInWithFakeCloud(page, fake);
    await expect(page.getByTestId('band-switcher')).toContainText('Banda de Daniel');

    // Importar B&O's (reemplaza la parte personal) y comprobar que queda activa.
    await page.getByTitle(/Usuario: /).click();
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('import-workspace-file').setInputFiles({
      name: 'bos.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(workspaceWith('band_bos', "B&O's", ['Dame tu aire', 'Nada', 'La flaca']))),
    });
    await expect(page.getByTestId('import-workspace-message')).toContainText('Workspace importado');
    await page.getByRole('button', { name: 'Cerrar perfil' }).click();
    await expect(page.getByTestId('band-switcher')).toContainText("B&O's");

    await page.getByRole('button', { name: 'INTEGRANTES' }).click();
    await page.getByTestId('share-band').click();
    await expect(page.getByTestId('sharing-panel')).toContainText('BANDA COMPARTIDA');

    // Lo que se subio a la nube es B&O's, con sus canciones.
    await expect.poll(() => fake.bands.length).toBe(1);
    const shared = fake.bands[0];
    expect(shared.content.bands[0].name).toBe("B&O's");
    expect(shared.content.songsMap[shared.id]).toHaveLength(3);
    // La banda activa sigue siendo B&O's (ahora compartida) y el enlace es el suyo.
    await expect(page.getByTestId('band-switcher')).toContainText("B&O's");
    await expect(page.getByTestId('invite-link').locator('input').first()).toHaveValue(new RegExp(`banda=${shared.id}$`));

    // Era su unica banda personal: queda un "Espacio personal" vacio, no la banda de ejemplo.
    await expect(page.getByTestId('sharing-result')).toContainText('Espacio personal');
    await page.getByTestId('band-switcher').click();
    await expect(page.getByRole('button', { name: /Banda de Daniel/ })).toHaveCount(0);
    await page.getByRole('button', { name: /Espacio personal/ }).click();

    // Al cambiar de banda, el panel ya no muestra el resultado ni el enlace de B&O's.
    await expect(page.getByTestId('sharing-panel')).toContainText('BANDA SOLO EN TU CUENTA');
    await expect(page.getByTestId('invite-link')).toHaveCount(0);
    await expect(page.getByTestId('sharing-result')).toHaveCount(0);

    // Y al volver a B&O's, el enlace es otra vez el suyo.
    await page.getByTestId('band-switcher').click();
    await page.getByRole('button', { name: /B&O's/ }).click();
    await expect(page.getByTestId('invite-link').locator('input').first()).toHaveValue(new RegExp(`banda=${shared.id}$`));
  });

  test('quien creó una banda compartida la borra para todos; borrar la última personal deja "Espacio personal"', async ({ page }) => {
    const fake = new FakeSupabase();
    const bos = workspaceWith('band_bos', "B&O's", ['Dame tu aire']);
    fake.workspaces.push({ user_id: USER.id, workspace: bos, updated_at: fake.now() });
    await signInWithFakeCloud(page, fake);
    await page.getByRole('button', { name: 'INTEGRANTES' }).click();
    await page.getByTestId('share-band').click();
    await expect.poll(() => fake.bands.length).toBe(1);
    await expect(page.getByTestId('band-switcher')).toContainText("B&O's");

    // Borrar la compartida (la creo esta cuenta): desaparece de la nube y del selector.
    page.once('dialog', (d) => {
      expect(d.message()).toContain('TODOS los integrantes');
      void d.accept();
    });
    await page.getByTestId('delete-band').click();
    await expect(page.getByTestId('delete-band-result')).toContainText("B&O's se borró para todos");
    await expect.poll(() => fake.bands.length).toBe(0);
    await expect(page.getByTestId('band-switcher')).toContainText('Espacio personal');

    // Borrar la ultima personal: queda otra "Espacio personal" vacia, nunca la banda de ejemplo.
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('delete-band').click();
    await expect(page.getByTestId('delete-band-result')).toContainText('quedó "Espacio personal"');
    await expect
      .poll(() => fake.workspaces[0].workspace.bands.map((b: Row) => b.name).join(','), { timeout: 10_000 })
      .toBe('Espacio personal');
  });

  test('con dos bandas personales, compartir sube la que se eligió en el selector y deja la otra', async ({ page }) => {
    const fake = new FakeSupabase();
    const daniel = workspaceWith('band_daniel_01', 'Banda de Daniel', ['Tema A']);
    const bos = workspaceWith('band_bos', "B&O's", ['Dame tu aire', 'Nada']);
    const both = {
      ...daniel,
      bands: [...daniel.bands, ...bos.bands],
      membersMap: { ...daniel.membersMap, ...bos.membersMap },
      playlistsMap: { ...daniel.playlistsMap, ...bos.playlistsMap },
      equipmentMap: { ...daniel.equipmentMap, ...bos.equipmentMap },
      songsMap: { ...daniel.songsMap, ...bos.songsMap },
    };
    fake.workspaces.push({ user_id: USER.id, workspace: both, updated_at: fake.now() });
    await signInWithFakeCloud(page, fake);
    await expect(page.getByTestId('band-switcher')).toContainText('Banda de Daniel');

    await page.getByTestId('band-switcher').click();
    await page.getByRole('button', { name: /B&O's/ }).click();
    await expect(page.getByTestId('band-switcher')).toContainText("B&O's");
    await page.getByRole('button', { name: 'INTEGRANTES' }).click();
    await page.getByTestId('share-band').click();
    await expect(page.getByTestId('sharing-panel')).toContainText('BANDA COMPARTIDA');

    await expect.poll(() => fake.bands.length).toBe(1);
    expect(fake.bands[0].content.bands[0].name).toBe("B&O's");
    await expect(page.getByTestId('sharing-result')).not.toContainText('Espacio personal');
    // La parte personal en la nube conserva solo Banda de Daniel.
    await expect
      .poll(() => fake.workspaces[0].workspace.bands.map((b: Row) => b.name).join(','), { timeout: 10_000 })
      .toBe('Banda de Daniel');
  });
});
