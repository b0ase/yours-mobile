import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  APP_BRANDS,
  MINT_CARDS,
  MINT_SECTIONS,
  MINT_WAYS,
  mintCard,
  type MintAction,
  type MintCard,
} from './mintCatalog';

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const actions = (c: MintCard): MintAction[] => [...(c.cta ? [c.cta] : []), ...(c.uses ?? []).map((u) => u.action)];
const text = (c: MintCard) =>
  [
    c.title,
    c.sub,
    c.pitch,
    c.ctaLabel ?? '',
    ...c.why,
    ...(c.later ?? []),
    c.facts.who,
    c.facts.cost,
    c.facts.where,
    ...(c.uses ?? []).flatMap((u) => [u.title, u.sub]),
  ].join(' ');

describe('Mint sheet catalog (bWalletX build)', () => {
  test('ids are unique and every section and way names a card', () => {
    const ids = MINT_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [...MINT_WAYS, ...MINT_SECTIONS.flatMap((s) => s.cards)]) expect(mintCard(id)?.id).toBe(id);
    // No card is drawn twice and none is left off the sheet.
    const placed = [...MINT_WAYS, ...MINT_SECTIONS.flatMap((s) => s.cards)];
    expect(new Set(placed).size).toBe(placed.length);
    expect(new Set(placed)).toEqual(new Set(ids));
  });

  test('every card sells itself: pitch, why, facts, and something to press', () => {
    for (const c of MINT_CARDS) {
      expect(c.pitch.length).toBeGreaterThan(20);
      expect(c.why.length).toBeGreaterThan(0);
      for (const f of Object.values(c.facts)) expect(f.trim().length).toBeGreaterThan(0);
      expect(actions(c).length).toBeGreaterThan(0);
    }
  });

  test('a card marked not open yet has no live action; a live card has at least one', () => {
    for (const c of MINT_CARDS) {
      const live = actions(c).filter((a) => !('soon' in a));
      if (c.soon) expect(live).toEqual([]);
      else expect(live.length).toBeGreaterThan(0);
    }
  });

  test('every flow a card starts exists in the Mint sheet', () => {
    const sheet = src('./MintButton.tsx');
    const flows = MINT_CARDS.flatMap(actions).flatMap((a) => ('flow' in a ? [a.flow] : []));
    for (const f of new Set(flows)) expect(sheet).toContain(`id: '${f}',`);
  });

  test('routes a card opens are real wallet routes', () => {
    const routes = src('../tabs/MobileRoutes.tsx');
    const bmint = src('../bmint/BmintPage.tsx');
    for (const a of MINT_CARDS.flatMap(actions)) {
      if (!('go' in a)) continue;
      const path = a.go.replace(/^\/m\//, '');
      if (path.startsWith('bmint/')) expect(bmint).toMatch(/BASE = '\/m\/bmint'/);
      else expect(routes).toContain(`path="${path}"`);
    }
  });

  test('the bAvatar is in the Mint menu and opens its sheet', () => {
    expect(MINT_SECTIONS.find((s) => s.id === 'money')?.cards).toContain('bavatar');
    expect(mintCard('bavatar')?.soon).toBeUndefined();
    expect(mintCard('bavatar')?.cta).toEqual({ go: '/m/bmint/mint/bavatar' });
    expect(src('../bmint/BmintPage.tsx')).toContain("type === 'bavatar'");
    expect(src('../tabs/TopNav.tsx')).not.toContain('BavatarMintSheet');
  });

  test('Link an account is not open yet; Upload your archive is live', () => {
    expect(mintCard('link')?.soon).toBe(true);
    expect(mintCard('upload')?.soon).toBeUndefined();
    expect(mintCard('upload')?.uses?.[0].action).toEqual({ upload: true });
  });

  test('no investment or returns wording', () => {
    for (const c of MINT_CARDS) expect(text(c)).not.toMatch(/invest|returns?\b|profit|yield|dividend|guarantee/i);
  });

  test('cards carry our services: wordmark name plus its site', () => {
    const sites = (id: string) => mintCard(id)?.brands?.map((b) => `${b.name} ${b.site ?? ''}`.trim());
    expect(sites('music')).toEqual(['bMusicX bmusicx.com']);
    expect(sites('videos')).toEqual(['bVideoX bvideox.com']);
    expect(sites('movies')).toEqual(['bMoviesX bmoviesx.com']);
    expect(mintCard('video')).toBeUndefined();
    expect(sites('art')).toEqual(['bPicsX bpicsx.com']);
    expect(sites('picture')).toEqual(['bPicsX bpicsx.com']);
    expect(sites('books')).toEqual(['bWriterX bwriterx.com']);
    expect(sites('upload')).toEqual(['bDriveX bdrivex.com']);
    expect(sites('keep')).toEqual(['bVaultX bvaultx.com']);
    expect(sites('sell')).toEqual(['bStoreX bstorex.com', 'bMarketX bmarketx.com']);
    expect(sites('3d')).toEqual(['bModelX bmodelx.com']);
    expect(sites('heirs')).toEqual(['bTrust']);
    expect(sites('name')).toEqual(['OpNS']);
    expect(MINT_SECTIONS.find((s) => s.id === 'work')?.brand?.site).toBe('bjobsx.com');
    expect(APP_BRANDS.linkedin.map((b) => b.name)).toEqual(['bJobsX']);
    // Not ours: never named or linked.
    expect(JSON.stringify([MINT_CARDS, MINT_SECTIONS, APP_BRANDS])).not.toMatch(/b3dx|bcorpx/i);
  });
});

describe('Mint sheet catalog (store build)', () => {
  const read = (env: Record<string, string>) => {
    const code =
      "const m = await import('./src/mobile/mint/mintCatalog.ts'); console.log(JSON.stringify({ cards: m.MINT_CARDS, sections: m.MINT_SECTIONS.map((s) => s.id) }));";
    const r = Bun.spawnSync(['bun', '-e', code], {
      env: { ...process.env, VITE_STORE_BUILD: '', VITE_CHANNEL: '', ...env },
    });
    const out = JSON.parse(r.stdout.toString()) as { cards: MintCard[]; sections: string[] };
    return Object.assign(out.cards, { sections: out.sections });
  };

  test('only what works today: no Link card, no currency, nothing not open yet', () => {
    const cards = read({ VITE_STORE_BUILD: '1' });
    expect(cards.sections).toEqual(['make', 'money']);
    const ids = cards.map((c) => c.id);
    for (const gone of ['link', 'currency', 'agent', 'sell', 'keep', 'heirs', 'picture', 'card', 'tickets', 'contract'])
      expect(ids).not.toContain(gone);
    expect(ids).toEqual(
      expect.arrayContaining([
        'upload',
        'art',
        'music',
        'videos',
        'movies',
        '3d',
        'books',
        'website',
        'name',
        'bavatar',
      ]),
    );
    for (const c of cards) {
      expect(c.soon).toBeUndefined();
      expect(c.later ?? []).toEqual([]);
      for (const a of actions(c)) expect('soon' in a).toBe(false);
      expect(text(c)).not.toMatch(/BSVEX|notes? and coins|PoW note|Fingerprint|room|Tokens can lose/i);
      // Brand names stay; links to outside sites never ship in a store build.
      for (const b of c.brands ?? []) expect(b.site).toBeUndefined();
    }
    expect(cards.find((c) => c.id === 'music')?.brands).toEqual([{ name: 'bMusicX' }]);
    expect(cards.find((c) => c.id === 'token')?.brands).toEqual([]);
  });

  test('the bWalletX build keeps the previews', () => {
    const ids = read({}).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['link', 'currency', 'agent', 'sell', 'keep', 'heirs']));
  });
});

describe('one brand system for our services', () => {
  const read = (env: Record<string, string>) => {
    const code =
      "const m = await import('./src/mobile/mint/serviceStyles.ts'); console.log(JSON.stringify(m.SERVICE_STYLES));";
    const r = Bun.spawnSync(['bun', '-e', code], {
      env: { ...process.env, VITE_STORE_BUILD: '', VITE_CHANNEL: '', ...env },
    });
    return JSON.parse(r.stdout.toString()) as Record<string, { word: string; accent: string; onAccent: string }>;
  };

  test('every service: the name after the b mark, X in its accent; blue bMusicX, red bMoviesX, gold for the rest', () => {
    const all = read({});
    for (const c of MINT_CARDS) for (const b of c.brands ?? []) if (b.site) expect(Object.keys(all)).toContain(b.name);
    for (const [name, st] of Object.entries(all)) {
      expect(`b${st.word}X`).toBe(name);
      const want = name === 'bMusicX' ? '#2f6bff' : name === 'bMoviesX' ? '#e50914' : '#ffd24d';
      expect(st.accent).toBe(want);
    }
  });

  test('preview-only services are not in a store build', () => {
    const store = read({ VITE_STORE_BUILD: '1' });
    for (const n of ['bVaultX', 'bStoreX', 'bMarketX']) expect(store[n]).toBeUndefined();
    expect(store.bMusicX.word).toBe('Music');
  });

  test('no share art of ours: no art files, no art module, no per-site logos', () => {
    const { existsSync } = require('fs') as typeof import('fs');
    expect(existsSync(new URL('./art', import.meta.url))).toBe(false);
    expect(existsSync(new URL('./serviceArtX.ts', import.meta.url))).toBe(false);
    expect(src('../../../vite.config.mobile.ts')).not.toContain('serviceArtX');
    expect(src('./ServiceBrand.tsx')).not.toMatch(/\.webp|Bebas|BMOVIES/);
  });
});
