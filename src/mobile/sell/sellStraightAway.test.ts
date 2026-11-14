import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sellTargetFor } from './sell';

const ID = 'a'.repeat(64) + '_0';

describe('Sell opens the sell sheet straight away (owner, 13 Nov 2026)', () => {
  it('builds the sheet target from the balance of that token ID', () => {
    const balances = [
      { id: 'b'.repeat(64) + '_0', sym: 'BLASTER', dec: 8, all: { confirmed: 9n } },
      { id: ID.replace('_', '.'), sym: 'BLASTER', dec: 8, all: { confirmed: 50_000_000n } },
    ];
    expect(sellTargetFor(balances, ID)).toEqual({ tokenId: ID, symbol: 'BLASTER', dec: 8, heldRaw: 50_000_000n });
  });

  it('is null when the wallet holds none of it', () => {
    expect(sellTargetFor([], ID)).toBeNull();
    expect(sellTargetFor([{ id: ID, sym: 'X', dec: 0, all: { confirmed: 0n } }], ID)).toBeNull();
  });

  it('no Sell button navigates to the trade screen any more', () => {
    const root = join(import.meta.dir, '../..');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : walk(p);
        return /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : [];
      });
    const hits = walk(root)
      .filter((f) => /navigate\(\s*sellRoute\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f));
    expect(hits).toEqual([]);
  });
});
