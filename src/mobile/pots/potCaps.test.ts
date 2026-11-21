/**
 * Pot spend caps (backlog 21 Nov 2026, cluster baware:pots-agent-caps): a sats order with no rate, a replayed payment
 * that was never booked, two tabs paying one period, a subscription moved into a pot with no cap, and reminders for
 * daily and hourly orders. One describe per b-Aware row.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { addSubscription, getSub, makePot } = await import('./pots');
const { payDue } = await import('./payDue');
const { getAgentLog, ledgerSpentToday, setAgentDailyCap } = await import('../agents/agentAccounts');

const NOW = Date.parse('2026-03-10T12:00:00Z');
const DAY = 86_400_000;
type Outs = { address: string; sats: number }[];

describe('row 267: a sats order with no BSV rate is never paid against a $0 cap check', () => {
  beforeEach(() => mem.clear());

  test('no rate: nothing is signed, nothing is booked as free, and the order waits', async () => {
    makePot('1Pot', 'Rent', undefined, NOW);
    const s = addSubscription(
      {
        potId: '1Pot',
        payee: { name: 'Landlord', address: '1Landlord' },
        amount: { value: 3_000_000, currency: 'SAT' },
        period: 'day',
        start: NOW - 2 * DAY - 1000,
        maxCount: null,
      },
      50,
      NOW,
    );
    setAgentDailyCap('1Pot', 1);
    const signed: Outs[] = [];
    const r = await payDue(
      {
        bsvUsd: 0,
        resolve: async () => '1Landlord',
        sign: async (_p, outs) => (signed.push(outs), { rawTx: 'RAW', txid: 'TX' }),
        broadcast: async () => undefined,
        spendingPaused: async () => false,
      },
      NOW,
    );
    expect(signed).toEqual([]);
    expect(r).toEqual([{ id: s.id, ok: false, reason: 'No price right now' }]);
    expect(getSub(s.id)?.periodIndex).toBe(0);
    expect(getAgentLog('1Pot').filter((l) => l.action === 'sub-pay')).toEqual([]);
  });

  test('with a rate, the same order is gated on its real dollar value', async () => {
    makePot('1Pot', 'Rent', undefined, NOW);
    addSubscription(
      {
        potId: '1Pot',
        payee: { name: 'Landlord', address: '1Landlord' },
        amount: { value: 3_000_000, currency: 'SAT' },
        period: 'day',
        start: NOW - 2 * DAY - 1000,
        maxCount: null,
      },
      50,
      NOW,
    );
    setAgentDailyCap('1Pot', 1);
    let signs = 0;
    const r = await payDue(
      {
        bsvUsd: 50,
        resolve: async () => '1Landlord',
        sign: async () => (signs++, { rawTx: 'RAW', txid: 'TX' }),
        broadcast: async () => undefined,
        spendingPaused: async () => false,
      },
      NOW,
    );
    expect(signs).toBe(0);
    expect(r[0].ok).toBe(false);
    expect(ledgerSpentToday('1Pot', NOW)).toBe(0);
  });
});
