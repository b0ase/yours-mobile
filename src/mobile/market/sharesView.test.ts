import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BsharesMe, PlacementOffer } from '../placement/placement';
import { sharesView } from './sharesView';

const offer = (id: string, investorHandle: string): PlacementOffer =>
  ({ id, ticker: 'BCORP', investorHandle, shares: 1000, status: 'offered' }) as PlacementOffer;
const me = (role: BsharesMe['role'], offers: PlacementOffer[]): BsharesMe =>
  ({ company: { name: 'The Bitcoin Corporation Ltd' }, role, holdings: [], offers }) as unknown as BsharesMe;

describe('Market › Shares is members only', () => {
  test('a non-member (403 → null, or no role) sees no offer data at all', () => {
    for (const v of [sharesView(null, 'alice'), sharesView(me(null, [offer('o1', 'alice')]), 'alice')]) {
      expect(v).toEqual({ kind: 'members-only' });
      expect(JSON.stringify(v)).not.toMatch(/o1|shares|Bitcoin Corporation/);
    }
  });
  test('a member sees only the tranches made out to them', () => {
    const v = sharesView(me('member', [offer('mine', '$Alice'), offer('theirs', 'bob')]), 'alice');
    expect(v.kind === 'member' && v.offers.map((o) => o.id)).toEqual(['mine']);
  });
  test('a director sees only their own tranches here, not every member’s', () => {
    const v = sharesView(me('director', [offer('a', 'alice'), offer('b', 'bob')]), 'bob');
    expect(v.kind === 'member' && v.offers.map((o) => o.id)).toEqual(['b']);
  });
  test('no known handle → no offers (the neutral line shows)', () => {
    const v = sharesView(me('member', [offer('a', 'alice')]), null);
    expect(v.kind === 'member' && v.offers).toEqual([]);
  });
});

// Strings from the removed static listings and bApps alphabet-share offers. None may ship.
export const REMOVED_OFFER_STRINGS = [
  'bcorp-ordinary',
  'Register interest',
  'Interest registered',
  'alphabet-share',
  '1,000,000,000 (placeholder)',
  'Share offers are for verified investors',
  'To be confirmed from the Register of Members',
  "the issuer's responsibility; The Bitcoin Corporation does not endorse",
];

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

describe('no share offers in the bundle', () => {
  test('app source carries none of the removed offer strings', () => {
    const src = join(import.meta.dir, '..', '..');
    const hits = files(src)
      .filter((f) => /\.(tsx?|json)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => REMOVED_OFFER_STRINGS.some((s) => readFileSync(f, 'utf8').includes(s)));
    expect(hits).toEqual([]);
  });
  // Runs against the built web bundle when one exists (pnpm build:web → build-web/).
  const built = join(import.meta.dir, '..', '..', '..', 'build-web');
  test.skipIf(!existsSync(built))('built web bundle carries none of the removed offer strings', () => {
    const hits = files(built)
      .filter((f) => /\.(js|html)$/.test(f))
      .flatMap((f) => {
        const t = readFileSync(f, 'utf8');
        return REMOVED_OFFER_STRINGS.filter((s) => t.includes(s)).map((s) => `${f}: ${s}`);
      });
    expect(hits).toEqual([]);
  });
});
