import { type Page, type Route } from '@playwright/test';

/**
 * Supabase SIMULADO dentro de Playwright para los e2e del hub: sesion de Supabase Auth inyectada
 * en localStorage y PostgREST en memoria (sin RLS: eso lo prueba `npm run test:rls` contra
 * Postgres real). Nunca toca el proyecto real. Lo usan shared-bands y stems-cloud.
 */

export const SUPA = 'http://127.0.0.1:54399';
export const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'daniel@grupo.co' };

export type Row = Record<string, any>;

export class FakeSupabase {
  workspaces: Row[] = [];
  bands: Row[] = [];
  members: Row[] = [];
  private clock = Date.parse('2026-10-30T12:00:00Z');

  now() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  table(name: string): Row[] {
    if (name === 'bandait_workspaces') return this.workspaces;
    if (name === 'bandait_bands') return this.bands;
    if (name === 'bandait_band_members') return this.members;
    throw new Error(`tabla desconocida ${name}`);
  }

  async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace('/rest/v1/', '');
    const rows = this.table(name);
    const filters: Array<(r: Row) => boolean> = [];
    for (const [key, value] of url.searchParams) {
      if (['select', 'columns', 'order', 'limit'].includes(key)) continue;
      if (value.startsWith('eq.')) {
        const v = value.slice(3);
        filters.push((r) => String(r[key]) === v || (key === 'updated_at' && Date.parse(r[key]) === Date.parse(v)));
      } else if (value.startsWith('in.(')) {
        const set = value.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''));
        filters.push((r) => set.includes(String(r[key])));
      }
    }
    const match = (r: Row) => filters.every((f) => f(r));
    const single = (req.headers()['accept'] || '').includes('vnd.pgrst.object');
    const reply = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (req.method() === 'GET') {
      const found = rows.filter(match);
      if (single) return found.length ? reply(200, found[0]) : reply(406, { code: 'PGRST116', message: '0 rows' });
      return reply(200, found);
    }
    if (req.method() === 'POST') {
      const body = req.postDataJSON();
      const list = (Array.isArray(body) ? body : [body]).map((r: Row) => ({
        ...r,
        ...(name === 'bandait_bands' ? { owner_id: USER.id } : {}),
        ...(name === 'bandait_band_members' ? { created_at: this.now() } : {}),
        ...(name !== 'bandait_band_members' && !r.updated_at ? { updated_at: this.now() } : {}),
      }));
      rows.push(...list);
      return reply(201, list);
    }
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON();
      const found = rows.filter(match);
      for (const r of found) Object.assign(r, body);
      return reply(200, found);
    }
    if (req.method() === 'DELETE') {
      const found = rows.filter(match);
      for (const r of found) rows.splice(rows.indexOf(r), 1);
      return reply(200, found);
    }
    return reply(405, {});
  }
}

export function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.firma`;
}

/** Workspace v2 de una banda (la forma que guarda el Hub). */
export function workspaceWith(bandId: string, name: string, songs: string[]) {
  const songRows = songs.map((title, i) => ({
    id: `0000000${i}-0000-4000-8000-${bandId.padEnd(12, '0').slice(0, 12).replace(/[^0-9a-f]/g, 'a')}`,
    title,
    artist: 'Artista',
    bpm: 100 + i,
    beatsPerBar: 4,
    beatUnit: 4,
    key: 'Am',
    sections: [],
    updatedAt: '2026-10-29T00:00:00.000Z',
  }));
  return {
    schemaVersion: 2,
    activeBandId: bandId,
    bands: [{ id: bandId, name, genre: '', ownerId: USER.id, currentUserRole: 'Owner', membersCount: 1, createdAt: '2026-10-29' }],
    membersMap: { [bandId]: [] },
    playlistsMap: {
      [bandId]: [
        {
          id: `pl_${bandId}`,
          bandId,
          name: `Setlist de ${name}`,
          createdAt: '2026-10-29',
          updatedAt: '2026-10-29',
          songs: songRows.map((s, i) => ({
            id: `it_${bandId}_${i}`,
            songId: s.id,
            orderIndex: i,
            title: s.title,
            artist: s.artist,
            bpm: s.bpm,
            key: 'Am',
            showKey: 'Am',
            camelot: '',
            durationSec: 0,
            transitionMode: 'manual_cue',
            countInBars: 1,
            countInVoice: true,
            gapSec: 0,
          })),
        },
      ],
    },
    equipmentMap: { [bandId]: [] },
    stemsMap: {},
    songsMap: { [bandId]: songRows },
    voiceMap: {},
  };
}

export async function signInWithFakeCloud(page: Page, fake: FakeSupabase) {
  await page.route(`${SUPA}/rest/v1/**`, (route) => fake.handle(route));
  await page.route(`${SUPA}/auth/v1/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: USER.id, email: USER.email }) })
  );
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const session = {
    access_token: fakeJwt({ sub: USER.id, email: USER.email, role: 'authenticated', exp }),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: exp,
    refresh_token: 'refresh-falso',
    user: {
      id: USER.id,
      email: USER.email,
      aud: 'authenticated',
      role: 'authenticated',
      app_metadata: { provider: 'google' },
      user_metadata: { full_name: 'Daniel Castaneda', email: USER.email },
      created_at: '2026-10-01T00:00:00Z',
    },
  };
  await page.addInitScript(
    ([url, s]) => {
      if (sessionStorage.getItem('e2e_seeded')) return;
      sessionStorage.setItem('e2e_seeded', '1');
      localStorage.setItem('bandait_supabase_url', url as string);
      localStorage.setItem('bandait_supabase_anon_key', 'sb_publishable_e2e');
      localStorage.setItem('sb-127-auth-token', JSON.stringify(s));
    },
    [SUPA, session] as const
  );
  await page.goto('/');
}
