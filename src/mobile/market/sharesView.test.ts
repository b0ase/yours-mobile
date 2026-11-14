import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offerStringsInBundle, REMOVED_OFFER_STRINGS } from '../../../scripts/lib/removedOfferStrings';
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
  // The built bundle is checked by the web build itself (vite.config.web.ts noShareOffersInBundle), on every build. It
  // used to be a test here that skipped when build-web/ was missing, so the suite's pass/skip count depended on the
  // worktree, and where a build-web/ existed it checked whatever older build was there.
  test('the web build runs the bundle check', () => {
    const cfg = readFileSync(join(import.meta.dir, '..', '..', '..', 'vite.config.web.ts'), 'utf8');
    expect(cfg).toMatch(/plugins: \[[^\]]*noShareOffersInBundle\(\)[^\]]*\]/);
  });
  test('the bundle check finds a removed string in a built file, and passes a clean one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'offer-bundle-'));
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'index.html'), '<html>bWalletX</html>');
      writeFileSync(join(dir, 'assets', 'clean.js'), 'export const a = 1;');
      expect(offerStringsInBundle(dir)).toEqual([]);
      writeFileSync(join(dir, 'assets', 'main.js'), `const t = "${REMOVED_OFFER_STRINGS[1]}";`);
      writeFileSync(join(dir, 'assets', 'note.txt'), REMOVED_OFFER_STRINGS[0]); // not a shipped .js/.html
      expect(offerStringsInBundle(dir)).toEqual([`${join(dir, 'assets', 'main.js')}: ${REMOVED_OFFER_STRINGS[1]}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
