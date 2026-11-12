import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * bCredits (b-only prepaid credits) is RETIRED (owner, 12 Nov 2026: "I just don't want that coming back again and again
 * UNLESS we figure out a model that works"). It was an assistant's invention, never the owner's. Bringing a credits
 * product back is an owner decision; then this test changes on purpose, in the same commit, saying so.
 */
const ROOT = new URL('../../', import.meta.url).pathname;
const SELF = 'bcreditsRetired.test.ts';
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|css|mjs|js|md)$/.test(f) && f !== SELF ? [p] : [];
  });
const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'docs')), join(ROOT, 'vite.config.mobile.ts')];
// This guard's own file name (cited in docs/STORE-AUDIT.md) is not a reappearance.
const text = (f: string) => readFileSync(f, 'utf8').replace(/bcreditsRetired\.test\.ts/g, '');
const hits = (re: RegExp) => files.filter((f) => re.test(text(f))).map((f) => f.slice(ROOT.length));

describe('bCredits stays retired', () => {
  test('the credits module is gone', () => expect(existsSync(join(ROOT, 'src/mobile/credits'))).toBe(false));
  test('no "bCredits" anywhere in src, docs or the build patches', () => expect(hits(/b-?credits?\b/i)).toEqual([]));
  test('no calls to the retired bit-sign routes', () =>
    expect(hits(/\/api\/bitsign\/credits(\/(deposit|debit|ledger)\b|['"`?])/)).toEqual([]));
  test('no BCREDITS_ flag', () => expect(hits(/\bBCREDITS_[A-Z_]+/)).toEqual([]));
  test('no Credits wallet view or tab', () => {
    expect(readFileSync(join(ROOT, 'src/mobile/wallet/walletKind.ts'), 'utf8')).not.toMatch(/'credits'/);
    expect(readFileSync(join(ROOT, 'src/mobile/nfts/WalletTabs.tsx'), 'utf8')).not.toMatch(/'\/m\/credits'/);
  });
});
