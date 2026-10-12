import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import {
  facetCounts,
  filterSearch,
  issuerLabels,
  matches,
  normalizeTags,
  parseFilter,
  resolveLabels,
  type TokenLabels,
} from './catalog';
import { MANIFEST_KEY_ID, MANIFEST_PROTOCOL, signedBytes, verifyManifest, type Manifest } from './manifest';
import { buildRegistry } from './registry';
import { exchangeView } from '../exchangeData';
import platforms from './platforms.json';
import tokens from './tokens.json';
import overrides from './overrides.json';

const id = (c: string, v = 0) => `${c.repeat(64)}_${v}`;
const A = id('a');
const B = id('b');
const C = id('c');

describe('catalog', () => {
  test('tags: lowercase, dashed, deduped, capped, junk dropped', () => {
    expect(normalizeTags(['Game Coin', '#Arena', 'arena', '', 5, '!!', 'x'.repeat(40)])).toEqual([
      'game-coin',
      'arena',
      'x'.repeat(32),
    ]);
    expect(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(8);
    expect(normalizeTags('nope')).toEqual([]);
  });

  test('precedence: override > platform > feed > issuer; unknown categories ignored', () => {
    const l = resolveLabels({
      override: { category: 'music' },
      platform: { platform: 'tokenblaster', category: 'games', tags: ['launchpad'] },
      feed: { platform: 'other-feed', tags: ['curve'] },
      issuer: { category: 'memes', tags: ['mine'] },
    });
    expect(l).toEqual({
      category: 'music',
      platform: 'tokenblaster',
      tags: ['launchpad', 'curve', 'mine'],
      verified: true,
    });
    expect(resolveLabels({ issuer: issuerLabels({ category: 'Investments', tags: ['x'] }) })).toEqual({
      category: 'other',
      platform: '1sat',
      tags: ['x'],
      verified: false,
    });
    expect(resolveLabels({ feed: { platform: 'tokenblaster' } }).verified).toBe(false);
    expect(issuerLabels({ cat: 'games' }).category).toBe('games');
  });

  test('filter + counts', () => {
    const ls: TokenLabels[] = [
      { category: 'games', platform: 'tokenblaster', tags: ['launchpad'], verified: true },
      { category: 'games', platform: '1sat', tags: [], verified: false },
      { category: 'music', platform: 'tokenblaster', tags: ['launchpad'], verified: true },
    ];
    const f = { cat: 'games' as const, platforms: ['tokenblaster'], tag: '' };
    expect(ls.filter((l) => matches(l, f))).toHaveLength(1);
    expect(ls.filter((l) => matches(l, { cat: null, platforms: [], tag: 'launch' }))).toHaveLength(2);
    const { cats, plats } = facetCounts(ls, f);
    expect(cats.get('games')).toBe(1);
    expect(cats.get('music')).toBe(1);
    expect(plats.get('tokenblaster')).toBe(1);
    expect(plats.get('1sat')).toBe(1);
  });

  test('URL state round-trips and drops junk', () => {
    const f = parseFilter('?cat=games&platform=tokenblaster,bwalletx,Bad!&tag=Launchpad&x=1');
    expect(f).toEqual({ cat: 'games', platforms: ['tokenblaster', 'bwalletx'], tag: 'launchpad' });
    expect(filterSearch(f, '?x=1')).toBe('?x=1&cat=games&platform=tokenblaster,bwalletx&tag=launchpad');
    expect(parseFilter('?cat=shares').cat).toBeNull();
    expect(filterSearch({ cat: null, platforms: [], tag: '' })).toBe('');
  });

  test('routes: /platform and /platform/<slug>', () => {
    expect(exchangeView('/platform')).toEqual({ tab: 'platforms' });
    expect(exchangeView('/platform/tokenblaster')).toEqual({ tab: 'platform', slug: 'tokenblaster' });
    expect(exchangeView('/platform/../x')).toEqual({ tab: 'platforms' });
  });
});

describe('manifest', () => {
  const key = PrivateKey.fromRandom();
  const wallet = new ProtoWallet(key);
  const make = async (over: Partial<Manifest> = {}): Promise<Manifest> => {
    const { publicKey } = await wallet.getPublicKey({ identityKey: true });
    const body = {
      version: 1 as const,
      platform: { slug: 'gameland', name: 'Gameland', url: 'https://gameland.example' },
      identityKey: publicKey,
      issuedAt: '2026-10-12T00:00:00Z',
      tokens: [
        { id: A, category: 'games', tags: ['Arcade'] },
        { id: 'junk', category: 'games' },
      ],
      ...over,
    };
    const { signature } = await wallet.createSignature({
      data: signedBytes(body),
      protocolID: MANIFEST_PROTOCOL,
      keyID: MANIFEST_KEY_ID,
      counterparty: 'anyone',
    });
    return { ...body, signature: signature.map((b) => b.toString(16).padStart(2, '0')).join('') };
  };
  const servedFrom = 'https://gameland.example/.well-known/bsv-tokens.json';

  test('a BRC-100 signed manifest verifies; bad ids are skipped', async () => {
    const v = await verifyManifest(await make(), { servedFrom });
    expect(v?.platform.slug).toBe('gameland');
    expect([...(v?.tokens.keys() ?? [])]).toEqual([A]);
    expect(v?.tokens.get(A)).toEqual({ platform: 'gameland', category: 'games', tags: ['arcade'] });
  });

  test('tampered, wrong domain, wrong pinned key or bad shape → null', async () => {
    const m = await make();
    expect(await verifyManifest({ ...m, tokens: [{ id: B, category: 'games' }] }, { servedFrom })).toBeNull();
    expect(await verifyManifest(m, { servedFrom: 'https://evil.example/.well-known/bsv-tokens.json' })).toBeNull();
    const other = PrivateKey.fromRandom().toPublicKey().toString();
    expect(await verifyManifest(m, { servedFrom, pinnedKey: other })).toBeNull();
    expect(await verifyManifest({ ...m, version: 2 }, { servedFrom })).toBeNull();
    expect(await verifyManifest(null, { servedFrom })).toBeNull();
    expect(await verifyManifest({ ...m, signature: 'zz' }, { servedFrom })).toBeNull();
  });
});

describe('registry', () => {
  const built = {
    platforms: [{ slug: 'tokenblaster', name: 'TokenBlaster', url: 'https://www.tokenblaster.lol' }],
    tokens: [{ id: A, platform: 'tokenblaster', category: 'games', tags: ['launchpad'] }],
    overrides: {
      tokens: { [A]: { category: 'art' } },
      hidden: [C],
      remotePlatforms: [],
    },
  };

  test('overrides win over the built-in list and signed manifests; hidden tokens leave catalogues', () => {
    const r = buildRegistry(built, new Map([[C, { platform: 'tokenblaster' }]]), [
      {
        platform: { slug: 'gameland', name: 'Gameland', url: 'https://gameland.example' },
        tokens: new Map([
          [A, { platform: 'gameland', category: 'memes' }],
          [B, { platform: 'gameland', category: 'games' }],
        ]),
      },
    ]);
    expect(r.labels(A)).toMatchObject({ category: 'art', platform: 'tokenblaster', verified: true });
    expect(r.labels(B)).toMatchObject({ category: 'games', platform: 'gameland', verified: true });
    expect(r.labels(id('d'))).toMatchObject({ category: 'other', platform: '1sat' });
    expect(r.platformTokens('tokenblaster')).toEqual([A]);
    expect(r.platformTokens('gameland')).toEqual([B]);
    expect(r.platforms.map((p) => p.slug)).toEqual(['tokenblaster', 'gameland']);
    expect(r.hidden.has(C)).toBe(true);
  });

  test('shipped registry files are valid', () => {
    const r = buildRegistry(
      { platforms: platforms.platforms, tokens: tokens.tokens, overrides: overrides as never },
      new Map(),
      [],
    );
    for (const t of tokens.tokens) {
      const l = r.labels(t.id);
      expect(l.platform).toBe(t.platform);
      expect(l.category).toBe(t.category as never);
    }
    expect(r.platformTokens('tokenblaster')).toHaveLength(4);
  });
});
