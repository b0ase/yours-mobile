import { describe, expect, test } from 'bun:test';
import { BSV21, OrdLock } from '@1sat/templates';
import { LockingScript, PrivateKey, Script } from '@bsv/sdk';
import {
  addRecord,
  buildListingScript,
  cancelKeyID,
  clampRate,
  decodeListing,
  fromRaw,
  indexingFeeSats,
  listingTxBytes,
  loadRecords,
  networkFeeSats,
  removeRecord,
  ticketResaleFeeOptions,
  ticketResaleFeeSats,
  toRaw,
  tokenOutputCount,
  totalPriceSats,
  unitPrice,
  usd,
  validateSell,
  type ListingRecord,
} from './sell';

const TOKEN = 'a'.repeat(64) + '_0';
const cancel = PrivateKey.fromRandom().toAddress();
const pay = PrivateKey.fromRandom().toAddress();

describe('amounts', () => {
  test('toRaw / fromRaw', () => {
    expect(toRaw('1.5', 2)).toBe(150n);
    expect(toRaw('3', 0)).toBe(3n);
    expect(toRaw('.25', 2)).toBe(25n);
    expect(toRaw('1.234', 2)).toBeNull();
    expect(toRaw('0', 0)).toBeNull();
    expect(toRaw('abc', 0)).toBeNull();
    expect(toRaw('', 0)).toBeNull();
    expect(fromRaw(150n, 2)).toBe('1.5');
    expect(fromRaw(100n, 2)).toBe('1');
    expect(fromRaw(5n, 3)).toBe('0.005');
    expect(fromRaw(7n, 0)).toBe('7');
  });

  test('total price = qty × per-ticket price, rounded up', () => {
    expect(totalPriceSats(3n, 0, 1000)).toBe(3000);
    expect(totalPriceSats(150n, 2, 1000)).toBe(1500); // 1.5 tokens
    expect(totalPriceSats(1n, 2, 1)).toBe(1); // 0.01 × 1 sat → ceil to 1
    expect(totalPriceSats(1n, 0, 0)).toBe(0);
    expect(totalPriceSats(0n, 0, 10)).toBe(0);
    expect(unitPrice(1500, 150n, 2)).toBe(1000);
  });

  test('validate', () => {
    expect(validateSell(null, 5n, 100)).toBe('quantity');
    expect(validateSell(6n, 5n, 100)).toBe('over-balance');
    expect(validateSell(5n, 5n, 0)).toBe('price');
    expect(validateSell(5n, 5n, 1)).toBeNull();
  });

  test('usd', () => {
    expect(usd(100_000_000, 50)).toBe('≈ $50.00');
    expect(usd(1000, 0)).toBe('');
  });
});

describe('fees', () => {
  test('indexing: one fee per token output (listing, + change when partial)', () => {
    expect(tokenOutputCount(5n, 5n)).toBe(1);
    expect(tokenOutputCount(2n, 5n)).toBe(2);
    expect(indexingFeeSats(5n, 5n)).toBe(1000);
    expect(indexingFeeSats(2n, 5n, 1000)).toBe(2000);
  });
  test('network estimate grows with inputs', () => {
    const a = listingTxBytes(1, 1000, false);
    expect(listingTxBytes(2, 1000, true)).toBeGreaterThan(a);
    expect(networkFeeSats(a, 100)).toBe(Math.ceil((a * 100) / 1000));
    expect(networkFeeSats(1, 1)).toBe(1);
  });
  test('ticket resale fee is 0 by default and configurable', () => {
    expect(ticketResaleFeeOptions('', 0)).toEqual({});
    expect(ticketResaleFeeOptions(pay, 0)).toEqual({});
    expect(ticketResaleFeeOptions('not-an-address', 0.02)).toEqual({});
    expect(ticketResaleFeeOptions(pay, 0.02)).toEqual({ marketplaceAddress: pay, marketplaceRate: 0.02 });
    expect(ticketResaleFeeSats(1000, pay, 0.02)).toBe(20);
    expect(ticketResaleFeeSats(1000)).toBe(0); // build default
    expect(clampRate(NaN)).toBe(0);
    expect(clampRate(-1)).toBe(0);
    expect(clampRate(0.9)).toBe(0.5);
  });
});

describe('listing script', () => {
  test('round-trips through @1sat/templates (BSV21 + OrdLock decode)', () => {
    const script = buildListingScript(TOKEN, 42n, cancel, pay, 12345);
    const back = decodeListing(script);
    expect(back).toEqual({ tokenId: TOKEN, amount: 42n, priceSats: 12345, seller: cancel });

    const lock = OrdLock.decode(script)!;
    expect(lock.price).toBe(12345n);
    expect(OrdLock.isOrdLock(script)).toBe(true);
    const tok = BSV21.decode(script)!;
    expect(tok.getOperation()).toBe('transfer');
    expect(tok.getAmount()).toBe(42n);
  });

  test('inscription comes first (1Sat market format), OrdLock follows', () => {
    const hex = buildListingScript(TOKEN, 1n, cancel, pay, 1).toHex();
    expect(hex.startsWith('0063036f7264')).toBe(true); // OP_FALSE OP_IF "ord"
    const json = Buffer.from(hex, 'hex').toString('latin1');
    expect(json).toContain('"op":"transfer"');
    expect(json).toContain(`"id":"${TOKEN}"`);
    expect(json).toContain('"amt":"1"');
  });

  test('rejects bad prices; non-listings decode to null', () => {
    expect(() => buildListingScript(TOKEN, 1n, cancel, pay, 0)).toThrow();
    expect(() => buildListingScript(TOKEN, 1n, cancel, pay, 1.5)).toThrow();
    expect(decodeListing(new Script())).toBeNull();
    const plain = BSV21.transfer(TOKEN, 1n).lock(new LockingScript(OrdLock.lock(cancel, pay, 5).chunks));
    expect(decodeListing(plain)?.priceSats).toBe(5);
  });

  test('listing tx size estimate covers the real listing script', () => {
    const len = buildListingScript(TOKEN, 10n ** 12n, cancel, pay, 10 ** 9).toBinary().length;
    expect(listingTxBytes(1, len, true)).toBeGreaterThan(len);
  });
});

describe('records', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  const rec = (outpoint: string): ListingRecord => ({
    outpoint,
    tokenId: TOKEN,
    symbol: 'TESTY',
    dec: 0,
    amount: '1',
    priceSats: 100,
    keyID: cancelKeyID(TOKEN),
    createdAt: 1,
  });
  test('add / dedupe / remove', () => {
    const s = mem();
    addRecord(rec('t.0'), s);
    addRecord(rec('u.0'), s);
    addRecord(rec('t.0'), s);
    expect(loadRecords(s).map((r) => r.outpoint)).toEqual(['t.0', 'u.0']);
    removeRecord('t.0', s);
    expect(loadRecords(s).map((r) => r.outpoint)).toEqual(['u.0']);
  });
  test('cancel key is deterministic per token', () => {
    expect(cancelKeyID(TOKEN)).toBe(cancelKeyID(TOKEN.replace('_', '.')));
  });
});
