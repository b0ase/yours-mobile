import { describe, expect, it } from 'bun:test';
import { BANNED_PROMO, RISK_LINE, TOKEN_SORTS, mergeTokens, sortTokens, sparkPath, sparkline } from './bexCards';
import { APP_SORTS, appCards, contributeLinks, isBuilder, sortApps, tokeniseQuery, previewSandbox } from './bappsCards';
import type { BApp } from '../../bapps';

const id = (c: string) => `${c.repeat(64)}_0`;

describe('bExchange reel (de minimis)', () => {
  it('offers neutral sorts only, New first, and no promotional words anywhere', () => {
    expect(TOKEN_SORTS.map((s) => s.id)).toEqual(['new', 'change', 'volume', 'holders', 'az']);
    for (const s of TOKEN_SORTS) expect(s.label).not.toMatch(BANNED_PROMO);
    expect(RISK_LINE).toBe('Tokens can lose all their value. No returns are promised.');
  });

  it('merges board, launches and people by id; launches carry dates and videos', () => {
    const cards = mergeTokens(
      [
        { id: id('a'), title: '$AAA', icon: null, outputs: 9 },
        { id: 'bad', title: 'X', icon: null },
      ],
      [{ tokenId: id('a'), ticker: 'AAA', name: 'Triple A', icon: null, createdAt: 5, video: 'https://v/x.mp4' }],
      [
        {
          tokenId: id('b'),
          ticker: 'BOB',
          displayName: 'Bob',
          avatar: 'https://a/b.png',
          launchedAt: '2026-10-01T00:00:00Z',
          members: 3,
        },
      ],
    );
    expect(cards.map((c) => c.id).sort()).toEqual([id('a'), id('b')]);
    const a = cards.find((c) => c.id === id('a'))!;
    expect(a).toMatchObject({ name: 'Triple A', holders: 9, createdAt: 5, video: 'https://v/x.mp4', source: 'launch' });
  });

  it('sorts with unknowns last and never invents an order (New falls back to A–Z)', () => {
    const mk = (t: string, createdAt: number | null, holders: number | null) => ({
      id: id(t[0].toLowerCase()),
      ticker: t,
      name: t,
      icon: null,
      createdAt,
      holders,
      video: null,
      source: 'board' as const,
    });
    const cards = [mk('Zed', null, 1), mk('Ann', null, null), mk('New', 10, 5), mk('Old', 1, 2)];
    expect(sortTokens(cards, 'new').map((c) => c.ticker)).toEqual(['New', 'Old', 'Ann', 'Zed']);
    expect(sortTokens(cards, 'holders').map((c) => c.ticker)).toEqual(['New', 'Old', 'Zed', 'Ann']);
    expect(sortTokens(cards, 'az').map((c) => c.ticker)).toEqual(['Ann', 'New', 'Old', 'Zed']);
    const stats = {
      [id('z')]: { last: 1, change: -0.5, volume: 10, trades: 1 },
      [id('o')]: { last: 1, change: 0.2, volume: 99, trades: 2 },
    };
    expect(sortTokens(cards, 'change', stats).map((c) => c.ticker)).toEqual(['Old', 'Zed', 'Ann', 'New']);
    expect(sortTokens(cards, 'volume', stats).map((c) => c.ticker)).toEqual(['Old', 'Zed', 'Ann', 'New']);
  });

  it('draws a sparkline from trades', () => {
    expect(sparkline([{ height: 1, satsPerToken: 1, totalSats: 1, amount: 1 }])).toEqual([]);
    const pts = sparkline([
      { height: 1, satsPerToken: 1, totalSats: 1, amount: 1 },
      { height: 2, satsPerToken: 3, totalSats: 3, amount: 1 },
    ]);
    expect(pts).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(sparkPath(pts, 10, 10)).toBe('M0.0 10.0 L10.0 0.0');
  });
});

describe('bApps reel', () => {
  const apps: BApp[] = [
    {
      name: 'bWriter',
      url: 'https://w.app',
      verb: 'Write',
      group: 'work',
      status: 'live',
      source: 'https://github.com/o/w',
    },
    { name: 'Names', url: '/m/names', verb: 'Names', group: 'social', status: 'live' },
    { name: 'bAlpha', url: 'https://a.app', verb: 'A', group: 'work', status: 'demo', noFrame: true },
  ];

  it('builds cards: frameable, internal, builder, open source', () => {
    const [w, n, a] = appCards(apps, { bwriter: 500 });
    expect(w).toMatchObject({ id: 'bwriter', frameable: true, internal: false, paidSats: 500 });
    expect(n).toMatchObject({ internal: true, frameable: false });
    expect(a).toMatchObject({ frameable: false, demo: true });
    expect(w.builder.name).toBe('Bitcoin Corp');
  });

  it('sorts New / Most paid to builder / A–Z', () => {
    expect(APP_SORTS.map((s) => s.label)).toEqual(['New', 'Most paid to builder', 'A–Z']);
    const cards = appCards(apps, { balpha: 10 });
    expect(sortApps(cards, 'new').map((c) => c.name)).toEqual(['bAlpha', 'Names', 'bWriter']);
    expect(sortApps(cards, 'paid')[0].name).toBe('bAlpha');
    expect(sortApps(cards, 'az').map((c) => c.name)).toEqual(['bAlpha', 'bWriter', 'Names']);
  });

  it('Contribute only for a GitHub repo', () => {
    expect(contributeLinks({ name: 'bWriter', source: 'https://github.com/o/w' })?.suggest).toMatch(
      /^https:\/\/github\.com\/o\/w\/issues\/new\?title=Suggestion%20for%20bWriter/,
    );
    expect(contributeLinks({ name: 'x', source: undefined })).toBeNull();
    expect(contributeLinks({ name: 'x', source: 'https://evil.example/o/w' })).toBeNull();
  });

  it('Tokenise is for the builder only and prefills the Launchpad', () => {
    const b = { name: 'B', handle: 'b0asex', paymail: 'b0asex@bwalletx.com' };
    expect(isBuilder(b, ['$B0ASEX'])).toBe(true);
    expect(isBuilder(b, ['b0asex@bwalletx.com'])).toBe(true);
    expect(isBuilder(b, ['someone', null, 'b0asex@handcash.io'])).toBe(false);
    expect(isBuilder({ name: 'Anon' }, ['anon'])).toBe(false);
    const q = new URLSearchParams(
      tokeniseQuery({ name: 'bWriter', verb: 'Write', url: 'https://w.app', internal: false }),
    );
    expect(Object.fromEntries(q)).toEqual({
      name: 'bWriter',
      description: 'Write',
      website: 'https://w.app',
      category: 'apps',
    });
  });
});

it('bApps previews: other https origins get storage, our own origin and non-https stay script-only', () => {
  expect(previewSandbox('https://bmovies.app/', 'capacitor://localhost')).toBe('allow-scripts allow-same-origin');
  expect(previewSandbox('https://web.bwalletx.com/x', 'https://web.bwalletx.com')).toBe('allow-scripts');
  expect(previewSandbox('http://example.com/', 'capacitor://localhost')).toBe('allow-scripts');
  expect(previewSandbox('not a url', 'capacitor://localhost')).toBe('allow-scripts');
});
