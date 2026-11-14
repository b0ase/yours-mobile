import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deriveFeeAddress } from '../../tokens/indexFund';
import * as tokenFee from './tokenFee';

/** b-Aware 28 Oct 2026 (hilmiadi677, H-5): token unlock and other token paths paid the indexer's fee uncapped. */
describe('overlay fee cap on every token path', () => {
  const capped = (tokenFee as Record<string, unknown>).cappedOverlayFee as
    | ((id: string, a: unknown, f: unknown, n: number) => { address: string; sats: number } | null)
    | undefined;
  const ID = `${'ab'.repeat(32)}_0`;
  const FEE = deriveFeeAddress(ID) as string;

  test('a normal fee passes; none is none', () => {
    expect(typeof capped).toBe('function');
    expect(capped!(ID, FEE, 1000, 2)).toEqual({ address: FEE, sats: 2000 });
    expect(capped!(ID, undefined, 1000, 1)).toBeNull();
    expect(capped!(ID, FEE, 0, 1)).toBeNull();
  });

  test('a hostile indexer fee is refused', () => {
    expect(() => capped!(ID, FEE, 50_000_000, 1)).toThrow('fee looks wrong');
    expect(() => capped!(ID, FEE, 1000.5, 1)).toThrow('fee looks wrong');
  });

  /** b-Aware 25 Oct 2026 (fzsusanto row 123): the cap left the indexer free to name any fee address. */
  test("a fee address that isn't the token's own is refused, whatever the amount", () => {
    const other = deriveFeeAddress(`${'cd'.repeat(32)}_0`) as string;
    expect(other).not.toBe(FEE);
    expect(() => capped!(ID, other, 1000, 1)).toThrow("isn't this token's fee address");
    expect(() => capped!(ID, '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 1, 1)).toThrow("isn't this token's fee address");
    expect(() => capped!('not-a-token', FEE, 1000, 1)).toThrow("isn't this token's fee address");
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
      // Every caller names the token, so the fee address is checked against it (row 123).
      expect(src).toMatch(/cappedOverlayFee\((?:lock\.)?tokenId, /);
      // No fee output built straight from fee_per_output any more.
      expect(src).not.toMatch(/satoshis:\s*(?:fee\.)?fee_?[Pp]er(?:_output)?\b/);
      expect(src).not.toMatch(/satoshis:\s*feePer\b/);
    }
  });
});
