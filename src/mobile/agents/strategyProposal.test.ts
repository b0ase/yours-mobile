import { beforeEach, describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { getAgentLog, getStrategyLedger, markAgentAccount, appendAgentLog } from './agentAccounts';
import { exampleStrategy, getLoadedStrategy, loadStrategy, setStrategyMode, type Strategy } from './strategy';
import { approveProposal, declineProposal, diffStrategy, getProposal } from './strategyProposal';
import { AgentCallError, handleAgentCall, makeGrant, type AgentDeps } from '../pair/agentPairing';
import { keepGlobals } from '../../testing/stubGlobals';

keepGlobals('localStorage');
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const NOW = Date.UTC(2026, 10, 18, 12);
const ID = '1A';
const deps: AgentDeps = {
  ctx: {} as OneSatContext,
  currentId: ID,
  bsvUsd: async () => 50,
  session: { id: 'abcdef1234567890', computer: 'desk.example.com' },
};
const wide = (): Strategy => {
  const s = exampleStrategy('ABC');
  return { ...s, name: 'Wide', rules: { ...s.rules, maxPerTradeUsd: 9999, maxTotalUsd: 99999, sendTo: ['1Evil'] } };
};
const call = async (scopes: Parameters<typeof makeGrant>[2], action: string, params: unknown) => {
  try {
    return await handleAgentCall(makeGrant(ID, 'bot', scopes, 7, Date.now()), action, params, deps, false);
  } catch (e) {
    return (e as AgentCallError).code;
  }
};

describe('a strategy from a paired computer is a proposal (b-Aware 315)', () => {
  beforeEach(() => {
    mem.clear();
    markAgentAccount(ID, [], NOW);
  });

  test('strategy_load does not change the active strategy until approved', async () => {
    const mine = exampleStrategy('ABC');
    loadStrategy(ID, mine, 'live', undefined, NOW);
    const r = (await call(['strategy'], 'strategy_load', { strategy: wide() })) as { proposed: string };
    expect(r.proposed).toBe('Wide');
    expect(getLoadedStrategy(ID)?.strategy).toEqual(mine);
    expect(getLoadedStrategy(ID)?.mode).toBe('live');
    expect(getProposal(ID)?.computer).toBe('desk.example.com');
    expect(getAgentLog(ID)[0].detail).toContain('proposed Wide');
    expect(approveProposal(ID, NOW + 1)).toBe(true);
    expect(getLoadedStrategy(ID)?.strategy.name).toBe('Wide');
    expect(getLoadedStrategy(ID)?.mode).toBe('paper');
    expect(getProposal(ID)).toBeNull();
  });

  test('declining leaves everything as it was', async () => {
    const mine = exampleStrategy('ABC');
    loadStrategy(ID, mine, 'paper', undefined, NOW);
    await call(['strategy'], 'strategy_load', { strategy: wide() });
    declineProposal(ID, NOW + 1);
    expect(getLoadedStrategy(ID)?.strategy).toEqual(mine);
    expect(getProposal(ID)).toBeNull();
  });

  test('a trade-only pairing cannot load a strategy; strategy alone cannot buy', async () => {
    expect(await call(['trade'], 'strategy_load', { strategy: wide() })).toBe('SCOPE');
    expect(getProposal(ID)).toBeNull();
    expect(await call(['strategy'], 'buy', { tokenId: 'x_0', usd: 1 })).toBe('SCOPE');
  });

  test('the spend ledger keeps counting across loads and mode changes', () => {
    loadStrategy(ID, exampleStrategy('ABC'), 'live', undefined, NOW);
    appendAgentLog(ID, { at: NOW + 10, action: 'buy', detail: 'x', usd: 7 });
    expect(getStrategyLedger(ID)?.totalUsd).toBe(7);
    loadStrategy(ID, wide(), 'paper', undefined, NOW + 20);
    setStrategyMode(ID, 'live', NOW + 30);
    setStrategyMode(ID, 'paper', NOW + 40);
    expect(getStrategyLedger(ID)?.totalUsd).toBe(7);
    appendAgentLog(ID, { at: NOW + 50, action: 'buy', detail: 'y', usd: 3 });
    expect(getStrategyLedger(ID)?.totalUsd).toBe(10);
  });

  test('provenance is recorded on the strategy and in the activity log', async () => {
    loadStrategy(ID, exampleStrategy('ABC'), 'paper', undefined, NOW);
    expect(getLoadedStrategy(ID)?.source).toEqual({ by: 'owner' });
    await call(['strategy'], 'strategy_load', { strategy: wide() });
    approveProposal(ID, NOW + 1);
    expect(getLoadedStrategy(ID)?.source).toEqual({
      by: 'computer',
      computer: 'desk.example.com',
      session: 'abcdef1234567890',
    });
    expect(getAgentLog(ID)[0].detail).toContain('desk.example.com (session abcdef12)');
  });

  test('the diff shows caps, sendTo and tokens', () => {
    const base = exampleStrategy('ABC');
    const d = diffStrategy(base, { ...wide(), rules: { ...wide().rules, tokens: ['ABC', 'XYZ'] } });
    const whats = d.map((c) => c.what);
    expect(whats).toEqual(expect.arrayContaining(['Tokens', 'Sends only to', 'Most per trade', 'Most in total']));
    expect(d.find((c) => c.what === 'Most per trade')?.to).toBe('$9999');
  });
});
