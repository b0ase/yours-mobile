import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as tokenFee from './tokenFee';

/** b-Aware 28 Oct 2026 (hilmiadi677, H-5): token unlock and other token paths paid the indexer's fee uncapped. */
describe('overlay fee cap on every token path', () => {
  const capped = (tokenFee as Record<string, unknown>).cappedOverlayFee as
    | ((a: unknown, f: unknown, n: number) => { address: string; sats: number } | null)
    | undefined;

  test('a normal fee passes; none is none', () => {
    expect(typeof capped).toBe('function');
    expect(capped!('1FeeAddr', 1000, 2)).toEqual({ address: '1FeeAddr', sats: 2000 });
    expect(capped!(undefined, 1000, 1)).toBeNull();
    expect(capped!('1FeeAddr', 0, 1)).toBeNull();
  });

  test('a hostile indexer fee is refused', () => {
    expect(() => capped!('1FeeAddr', 50_000_000, 1)).toThrow('fee looks wrong');
    expect(() => capped!('1FeeAddr', 1000.5, 1)).toThrow('fee looks wrong');
  });

  test('unlock, room messages, invites and listing cancels all use the cap', () => {
    for (const f of [
      '../../locks/tokenLockApi.ts',
      '../../chat/roomSpend.ts',
      '../../chat/xInvites.ts',
      '../../sell/sellActions.ts',
    ]) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src).toContain('cappedOverlayFee(');
      // No fee output built straight from fee_per_output any more.
      expect(src).not.toMatch(/satoshis:\s*(?:fee\.)?fee_?[Pp]er(?:_output)?\b/);
      expect(src).not.toMatch(/satoshis:\s*feePer\b/);
    }
  });
});
