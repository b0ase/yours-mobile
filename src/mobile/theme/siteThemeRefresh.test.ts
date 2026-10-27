import { beforeEach, describe, expect, it } from 'bun:test';
import { fetchSiteThemeIfChanged, siteThemePack, type SiteTheme } from './siteTheme';
import { REFRESH_MS, refreshWornSiteTheme, resetSiteThemeRefresh, type RefreshDeps } from './siteThemeRefresh';
import type { ThemePack } from './themePack';

const SITE = { id: 'bmarketx', host: 'bmarketx.com' };
const LIGHT: SiteTheme = {
  v: 1,
  id: 'bmarketx',
  label: 'bMarketX',
  scheme: 'light',
  accent: '#0064D2',
  hi: '#3A8DFF',
  lo: '#0050A8',
  on: '#FFFFFF',
  bg: '#FFFFFF',
  surface: '#F4F6FA',
  surface2: '#E9EDF4',
  nav: '#FFFFFF',
  text: '#0A0C10',
  muted: '#5B6577',
  line: '#D5DBE5',
  success: '#2E7D32',
  danger: '#C62828',
};
const DARK: SiteTheme = {
  ...LIGHT,
  scheme: 'dark',
  bg: '#0A0C10',
  surface: '#141821',
  nav: '#0A0C10',
  text: '#FFFFFF',
};
const pack = (t: SiteTheme) => siteThemePack(t) as ThemePack;

const res = (body: unknown, status = 200, etag?: string) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: etag ? { etag } : {},
  });

/** Deps around a real fetchSiteThemeIfChanged with a fake network, so the first offer's checks are the ones used. */
const setup = (wornPack: ThemePack | null, reply: (init: RequestInit) => Response) => {
  const state = { t: 1_000_000, worn: wornPack, calls: 0, wore: [] as ThemePack[], sent: [] as RequestInit[] };
  const f = (async (_u: string, init: RequestInit) => {
    state.calls++;
    state.sent.push(init);
    return reply(init);
  }) as unknown as typeof fetch;
  const deps: RefreshDeps = {
    now: () => state.t,
    fetchTheme: (s, e) => fetchSiteThemeIfChanged(s, e, f),
    worn: () => state.worn,
    wear: (_a, p) => {
      state.wore.push(p);
      state.worn = p;
    },
  };
  return { state, deps };
};

describe('refreshWornSiteTheme', () => {
  beforeEach(resetSiteThemeRefresh);

  it('re-applies a changed, valid theme', async () => {
    const { state, deps } = setup(pack(LIGHT), () => res(DARK));
    expect(await refreshWornSiteTheme(SITE, 'acct', deps)).toBe(true);
    expect(state.wore).toHaveLength(1);
    expect(state.wore[0].look.scheme).toBe('dark');
  });

  it('ignores an unchanged file', async () => {
    const { state, deps } = setup(pack(DARK), () => res(DARK));
    expect(await refreshWornSiteTheme(SITE, 'acct', deps)).toBe(false);
    expect(state.calls).toBe(1);
    expect(state.wore).toHaveLength(0);
  });

  it('ignores a 304 for the remembered ETag', async () => {
    const { state, deps } = setup(pack(LIGHT), (init) =>
      (init.headers as Record<string, string> | undefined)?.['If-None-Match'] === '"v1"'
        ? new Response(null, { status: 304 })
        : res(LIGHT, 200, '"v1"'),
    );
    expect(await refreshWornSiteTheme(SITE, 'acct', deps)).toBe(false);
    state.t += REFRESH_MS + 1;
    expect(await refreshWornSiteTheme(SITE, 'acct', deps)).toBe(false);
    expect((state.sent[1].headers as Record<string, string>)['If-None-Match']).toBe('"v1"');
    expect(state.wore).toHaveLength(0);
  });

  it('keeps the current theme when the new file fails the checks', async () => {
    for (const bad of [
      { ...DARK, css: 'body{}' }, // unknown key
      { ...DARK, text: '#15181E' }, // unreadable on the dark page
      { ...DARK, id: 'evil' }, // another site's id
      'not json',
    ]) {
      resetSiteThemeRefresh();
      const { state, deps } = setup(pack(LIGHT), () => res(bad));
      expect(await refreshWornSiteTheme(SITE, 'acct', deps)).toBe(false);
      expect(state.wore).toHaveLength(0);
    }
    resetSiteThemeRefresh();
    const { state, deps } = setup(pack(LIGHT), () => res('', 404));
    expect(await refreshWornSiteTheme(SITE, 'acct', deps)).toBe(false);
    expect(state.wore).toHaveLength(0);
  });

  it('does nothing for a theme that is not worn', async () => {
    const other = { ...pack(LIGHT), id: 'site-dnsdex' };
    for (const worn of [null, other]) {
      const { state, deps } = setup(worn, () => res(DARK));
      expect(await refreshWornSiteTheme(SITE, 'acct', deps)).toBe(false);
      expect(state.calls).toBe(0);
      expect(state.wore).toHaveLength(0);
    }
    const { state, deps } = setup(pack(LIGHT), () => res(DARK));
    expect(await refreshWornSiteTheme(null, 'acct', deps)).toBe(false);
    expect(state.calls).toBe(0);
  });

  it('asks a site at most once per REFRESH_MS', async () => {
    const { state, deps } = setup(pack(LIGHT), () => res(LIGHT));
    await refreshWornSiteTheme(SITE, 'acct', deps);
    state.t += REFRESH_MS - 1;
    await refreshWornSiteTheme(SITE, 'acct', deps);
    expect(state.calls).toBe(1);
    state.t += 2;
    await refreshWornSiteTheme(SITE, 'acct', deps);
    expect(state.calls).toBe(2);
  });
});
