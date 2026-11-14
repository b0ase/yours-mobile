import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deriveFeeAddress } from '../../tokens/indexFund';
import { P2PKH } from '@bsv/sdk';
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

/**
 * Review of b-Aware row 123 (14 Nov 2026): every other token path paid the indexer's fee_address as served. The check
 * now sits in the shared guards: guardedSendBsv21 (every sendBsv21 caller: token lock, listing, escrow, partnership,
 * holder drops) and withTokenSendGuard (Send, holder drops), and in the PNEE pot fee (pneePots.test.ts).
 */
describe("the token send guards pay only the token's own fee address", () => {
  const t = tokenFee as Record<string, unknown>;
  const ID = `${'ab'.repeat(32)}_0`;
  const own = new P2PKH().lock(deriveFeeAddress(ID) as string).toHex();
  const other = new P2PKH().lock('1BoatSLRHtKNngkdXEeobR76b53LETtpyT').toHex();
  const fee = (lockingScript: string) => ({
    lockingScript,
    satoshis: 1000,
    outputDescription: 'Overlay processing fee',
  });
  const tokenOut = { lockingScript: 'tok', satoshis: 1 };

  test("sendBsv21's fee output to another address is refused before the wallet signs anything", async () => {
    const wrap = t.withOverlayFeeAddressCheck as (<W extends object>(w: W, id: string) => W) | undefined;
    expect(typeof wrap).toBe('function');
    let called = 0;
    const w = wrap!({ createAction: async () => ++called }, ID);
    await w.createAction({ outputs: [tokenOut, fee(own)] } as never);
    await w.createAction({ outputs: [tokenOut] } as never); // a token with no fee
    expect(called).toBe(2);
    expect(() => w.createAction({ outputs: [tokenOut, fee(other)] } as never)).toThrow(
      "isn't this token's fee address",
    );
    expect(() =>
      w.createAction({ outputs: [{ lockingScript: other, satoshis: 5, tags: ['fee:overlay'] }] } as never),
    ).toThrow("isn't this token's fee address");
    expect(called).toBe(2);
  });

  test("a confirmed send whose fee goes anywhere but the token's own fee address is refused", async () => {
    let called = 0;
    const guard = tokenFee.withTokenSendGuard as unknown as (
      w: object,
      f: { feeScript: string; maxSats: number } | null,
      id: string,
    ) => { createAction: (a: unknown) => Promise<unknown> };
    const ok = guard({ createAction: async () => ++called }, { feeScript: own, maxSats: 2000 }, ID);
    await ok.createAction({ outputs: [tokenOut, { lockingScript: own, satoshis: 1000 }] });
    expect(called).toBe(1);
    const bad = guard({ createAction: async () => ++called }, { feeScript: other, maxSats: 2000 }, ID);
    expect(() => bad.createAction({ outputs: [tokenOut, { lockingScript: other, satoshis: 1000 }] })).toThrow(
      "isn't this token's fee address",
    );
    expect(called).toBe(1);
  });

  test('guardedSendBsv21 and both confirmed-send callers name the token', () => {
    const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
    expect(read('../../../services/tokenSpendGuard.ts')).toContain(
      'wallet: withOverlayFeeAddressCheck(ctx.wallet, input.tokenId)',
    );
    expect(read('../../../services/tokenSpendGuard.ts')).toContain('sendBsv21.execute(sending, input)');
    expect(read('../../../components/SendBsv21View.tsx')).toMatch(/withTokenSendGuard\([\s\S]*?token\.info\.id!,\s*\)/);
    expect(read('../../holderDrop/HolderDropSheet.tsx')).toMatch(/withTokenSendGuard\([\s\S]*?a\.tokenId,\s*\)/);
  });
});
