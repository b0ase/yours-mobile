import { describe, expect, test } from 'bun:test';
import { LockingScript, Script, Utils } from '@bsv/sdk';
import { OrdLockV2 } from '@1sat/templates';
import { assertOpnsPayout, opnsPayoutOf, PRICE_MISMATCH_MESSAGE } from './opnsBuyPrice';

const SELLER = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const PAYEE = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

/** An OrdLock v2 listing paying `payoutSats`, with MAP metadata that advertises `mapPrice`. */
const listing = (payoutSats: number, mapPrice: number) => {
  const lock = OrdLockV2.lock(SELLER, PAYEE, payoutSats);
  const map = new Script()
    .writeOpCode(106)
    .writeBin(Utils.toArray('1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'))
    .writeBin(Utils.toArray('SET'))
    .writeBin(Utils.toArray('price'))
    .writeBin(Utils.toArray(String(mapPrice)));
  return new LockingScript([...lock.chunks, ...map.chunks]);
};

describe('OpNS buy pays only the approved price', () => {
  test('reads the payout amount and payee from the covenant, not MAP', () => {
    const p = opnsPayoutOf(listing(5_000_000, 1_000));
    expect(p?.sats).toBe(5_000_000);
    expect(p?.payee).toBe(PAYEE);
  });

  test('refuses a listing whose MAP price is lower than its covenant payout', () => {
    // Sheet shows the MAP price (1,000 sats) and the user approves it; the covenant takes 5,000,000.
    expect(() => assertOpnsPayout(listing(5_000_000, 1_000), 1_000)).toThrow(PRICE_MISMATCH_MESSAGE);
  });

  test('refuses any payout that differs from the approved price, higher or lower', () => {
    expect(() => assertOpnsPayout(listing(1_001, 1_000), 1_000)).toThrow(PRICE_MISMATCH_MESSAGE);
    expect(() => assertOpnsPayout(listing(999, 1_000), 1_000)).toThrow(PRICE_MISMATCH_MESSAGE);
  });

  test('refuses when payout plus marketplace fee exceeds what the sheet showed', () => {
    expect(() => assertOpnsPayout(listing(1_000, 1_000), 1_000, { marketFeeSats: 10 })).toThrow(PRICE_MISMATCH_MESSAGE);
    expect(assertOpnsPayout(listing(1_000, 1_000), 1_000, { marketFeeSats: 10, approvedTotalSats: 1_010 }).sats).toBe(
      1_000,
    );
  });

  test('refuses a different payee when one was approved', () => {
    expect(() => assertOpnsPayout(listing(1_000, 1_000), 1_000, { approvedPayee: SELLER })).toThrow(
      PRICE_MISMATCH_MESSAGE,
    );
  });

  test('fails closed on non-listings and bad approved prices', () => {
    const p2pkh = LockingScript.fromHex('76a91400112233445566778899aabbccddeeff0011223388ac');
    expect(() => assertOpnsPayout(p2pkh, 1_000)).toThrow();
    expect(() => assertOpnsPayout(listing(1_000, 1_000), 0)).toThrow();
    expect(() => assertOpnsPayout(listing(1_000, 1_000), Number.NaN)).toThrow();
  });

  test('a matching listing goes through', () => {
    const p = assertOpnsPayout(listing(1_000, 1_000), 1_000, { approvedPayee: PAYEE });
    expect(p.sats).toBe(1_000);
  });
});
