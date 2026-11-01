import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { MINT_CARDS, MINT_SECTIONS, MINT_WAYS, mintCard, type MintAction, type MintCard } from './mintCatalog';

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

  test('Link an account is not open yet; Upload your archive is live', () => {
    expect(mintCard('link')?.soon).toBe(true);
    expect(mintCard('upload')?.soon).toBeUndefined();
    expect(mintCard('upload')?.uses?.[0].action).toEqual({ upload: true });
  });

  test('no investment or returns wording', () => {
    for (const c of MINT_CARDS) expect(text(c)).not.toMatch(/invest|returns?\b|profit|yield|dividend|guarantee/i);
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
    expect(ids).toEqual(expect.arrayContaining(['upload', 'art', 'music', 'video', '3d', 'books', 'website', 'name']));
    for (const c of cards) {
      expect(c.soon).toBeUndefined();
      expect(c.later ?? []).toEqual([]);
      for (const a of actions(c)) expect('soon' in a).toBe(false);
      expect(text(c)).not.toMatch(/BSVEX|notes? and coins|PoW note|Fingerprint|room|Tokens can lose/i);
    }
  });

  test('the bWalletX build keeps the previews', () => {
    const ids = read({}).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['link', 'currency', 'agent', 'sell', 'keep', 'heirs']));
  });
});
