import { type Page } from '@playwright/test';

/**
 * Navegacion del shell Web 3.0 del hub (components/shell/HubShell.tsx). En escritorio las 6 vistas
 * estan en el rail; en movil Ensayo, Canciones y Setlists estan en la barra inferior y el resto en
 * la hoja "Mas". `tracks` es la antigua PISTAS: Canciones y Stems > STEMS Y PISTAS.
 */
export type HubViewId = 'studio' | 'rehearsal' | 'songs' | 'tracks' | 'setlists' | 'band' | 'settings';

export async function openView(page: Page, view: HubViewId): Promise<void> {
  const target = view === 'tracks' ? 'songs' : view;
  const tab = page.getByTestId(`tab-${target}`);
  if (!(await tab.isVisible())) await page.getByTestId('tab-more').click();
  await page.getByTestId(`tab-${target}`).click();
  if (view === 'tracks') await page.getByTestId('songs-segment-stems').click();
  else if (view === 'songs') await page.getByTestId('songs-segment-library').click();
}
