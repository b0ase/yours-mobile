import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AirdropItem } from '../airdrops/inbox';
import { hiddenCount, hiddenGroups, isWorthless, type HiddenToken } from './hiddenGroups';

const tok = (id: string, confirmed: bigint, pending = 0n): HiddenToken => ({ id, confirmed, pending });
const drop = (key: string, id: string, kind: 'token' | 'nft' = 'token'): AirdropItem => ({
  key,
  txid: key,
  time: 1,
  asset: { kind, id, symbol: id.toUpperCase() },
  issuer: id,
  from: 'addr',
});

describe('hidden tokens folder', () => {
  test('zero confirmed and zero pending is worthless; any balance is not', () => {
    expect(isWorthless(tok('a', 0n))).toBe(true);
    expect(isWorthless(tok('a', 1n))).toBe(false);
    expect(isWorthless(tok('a', 0n, 5n))).toBe(false);
  });

  test('archived first, then worthless; held tokens stay out of both', () => {
    const g = hiddenGroups([tok('a', 5n), tok('b', 0n), tok('c', 0n), tok('d', 9n)], (t) => t, ['c', 'd']);
    expect(g.archived.map((t) => t.id)).toEqual(['c', 'd']);
    expect(g.worthless.map((t) => t.id)).toEqual(['b']);
    expect(hiddenCount(g)).toBe(3);
  });

  test('quarantined: token airdrops in the quarantine set, one per token id, no NFTs', () => {
    const inbox = [drop('1', 'x_0'), drop('2', 'x_0'), drop('3', 'y_0'), drop('4', 'z_0', 'nft')];
    const g = hiddenGroups([], (t: HiddenToken) => t, [], inbox, new Set(['x_0', 'z_0']));
    expect(g.quarantined.map((i) => i.key)).toEqual(['1']);
  });

  test('token id with a dot matches the normalised quarantine id', () => {
    const g = hiddenGroups([], (t: HiddenToken) => t, [], [drop('1', 'X.0')], new Set(['x_0']));
    expect(g.quarantined).toHaveLength(1);
  });

  test('the folder has no Buy button and opens no link on a single tap', () => {
    const src = readFileSync(join(import.meta.dir, 'HiddenTokens.tsx'), 'utf8');
    expect(src).not.toMatch(/>\s*Buy\b/);
    expect(src).not.toMatch(/href=|window\.open|openDappBrowser/);
  });

  test('token link confirm shows the full URL', () => {
    const src = readFileSync(join(import.meta.dir, '../tokens/TokenLinks.tsx'), 'utf8');
    expect(src).toMatch(/\{ask\.url\}/);
  });
});
