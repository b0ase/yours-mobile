import { describe, expect, it } from 'bun:test';
import { opnsRows, paymailRows, type WalletNameRow } from './namesList';

describe('paymailRows', () => {
  it('lists every paymail from the lookup, main first', () => {
    expect(
      paymailRows(
        [
          { paymail: 'b0asex.x@bwalletx.com', main: false },
          { paymail: 'b0asey@bwalletx.com', main: true },
        ],
        'stale@bwalletx.com',
      ),
    ).toEqual([
      { paymail: 'b0asey@bwalletx.com', main: true },
      { paymail: 'b0asex.x@bwalletx.com', main: false },
    ]);
  });
  it('falls back to the cached paymail as the main one', () => {
    expect(paymailRows([], 'b0asey@bwalletx.com')).toEqual([{ paymail: 'b0asey@bwalletx.com', main: true }]);
  });
  it('is empty with no lookup and no cache, and drops duplicates', () => {
    expect(paymailRows([], '')).toEqual([]);
    expect(
      paymailRows(
        [
          { paymail: 'a@bwalletx.com', main: true },
          { paymail: 'A@bwalletx.com', main: false },
        ],
        '',
      ),
    ).toEqual([{ paymail: 'a@bwalletx.com', main: true }]);
  });
});

describe('opnsRows', () => {
  const row = (name: string): WalletNameRow => ({ name, id: name, published: false, listedSats: null });
  it('keeps OpNS names and drops paymail-shaped entries', () => {
    expect(opnsRows([row('b0asey'), row('b0asey@bwalletx.com'), row('frogger')]).map((r) => r.name)).toEqual([
      'b0asey',
      'frogger',
    ]);
  });
});

describe('paymailRows siblings (one name, two addresses)', () => {
  it('each primary address is followed by its bmailx.com sibling', () => {
    const rows = paymailRows(
      [
        { paymail: 'john@bwalletx.com', main: true },
        { paymail: 'john.x@bwalletx.com', main: false },
        { paymail: 'old@bwallet.space', main: false },
      ],
      null,
      { primary: 'bwalletx.com', siblings: ['bmailx.com'] },
    );
    expect(rows.map((r) => r.paymail)).toEqual([
      'john@bwalletx.com',
      'john@bmailx.com',
      'john.x@bwalletx.com',
      'john.x@bmailx.com',
      'old@bwallet.space',
    ]);
    expect(rows[0].main).toBe(true);
    expect(rows[1].main).toBe(false);
  });
});
