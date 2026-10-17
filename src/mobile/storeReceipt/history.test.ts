import { describe, expect, test } from 'bun:test';
import { classifyEvent } from '../wallet/historyEvents';
import { labelFor, type HistoryRow } from '../wallet/txHistory';

const local = { description: 'Theme purchase · NPG', labels: [] };
const row: HistoryRow = {
  txid: 'aa'.repeat(32),
  time: 0,
  direction: 'out',
  amountSats: -5_400_000,
  feeSats: 30,
  counterparty: '',
  label: '',
  note: '',
  confirmations: 1,
};

describe('store purchases in history', () => {
  test('labelled as a theme purchase, not a send or an NFT', () => {
    expect(labelFor('out', local)).toBe('theme purchase');
  });

  test('shows as "theme purchase · NPG" under payments, even with the 1-sat receipt in the tx', () => {
    const tx = {
      txid: row.txid,
      vin: [],
      vout: [{ n: 0, sats: 1, addresses: ['1Own'], script: '' }],
    } as unknown as Parameters<typeof classifyEvent>[1];
    const c = classifyEvent({ ...row, label: labelFor('out', local) }, tx, local, {
      own: new Set(['1Own']),
      prev: new Map(),
      listings: new Map(),
    });
    expect(c.label).toBe('theme purchase · NPG');
    expect(c.category).toBe('payment');
    expect(c.type).toBe('payment');
  });
});
