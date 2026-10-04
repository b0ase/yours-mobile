import { describe, expect, test } from 'bun:test';
import { cleanLabels, spendAllowed, spentToday, type AgentAccount, type AgentLogEntry } from './agentAccounts';

const DAY = Date.UTC(2026, 9, 4, 12);
const acct = (p: Partial<AgentAccount> = {}): AgentAccount => ({
  identityAddress: '1Agent',
  labels: [],
  stopped: false,
  dailyCapUsd: null,
  createdAt: 0,
  ...p,
});
const spend = (usd: number, at = DAY): AgentLogEntry => ({ at, action: 'buy', detail: '', usd });

describe('agent accounts', () => {
  test('only agent accounts that are running may spend', () => {
    expect(spendAllowed(null, false, [], 1, DAY).ok).toBe(false);
    expect(spendAllowed(acct({ stopped: true }), false, [], 1, DAY).ok).toBe(false);
    expect(spendAllowed(acct(), true, [], 1, DAY).ok).toBe(false);
    expect(spendAllowed(acct(), false, [], 1_000_000, DAY).ok).toBe(true); // no cap: the balance is the limit
  });

  test('daily cap counts only today (UTC)', () => {
    const yesterday = DAY - 24 * 3600_000;
    const log = [spend(6), spend(50, yesterday)];
    expect(spentToday(log, DAY)).toBe(6);
    const a = acct({ dailyCapUsd: 10 });
    expect(spendAllowed(a, false, log, 4, DAY).ok).toBe(true);
    const r = spendAllowed(a, false, log, 5, DAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('$4.00 left of $10');
  });

  test('labels are trimmed, deduplicated and capped', () => {
    expect(cleanLabels([' degen ', 'degen', '', 'x'.repeat(40)])).toEqual(['degen', 'x'.repeat(24)]);
    expect(cleanLabels(Array.from({ length: 12 }, (_, i) => `l${i}`))).toHaveLength(8);
  });
});
