import { beforeEach, describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { getAgentLog, getStrategyLedger, markAgentAccount, appendAgentLog, strategyLedgerSpent } from './agentAccounts';
import { exampleStrategy, getLoadedStrategy, loadStrategy, setStrategyMode, type Strategy } from './strategy';
import {
  approveProposal,
  declineProposal,
  diffStrategy,
  getProposal,
  proposeStrategy,
  type StrategyProposal,
} from './strategyProposal';
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
  session: { id: 'abcdef1234567890' },
};
/** The pairing that sent the proposal is still live (sessions.ts isAgentSessionLive, stubbed here). */
const live = () => true;
const shown = () => getProposal(ID) as StrategyProposal;
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
    expect(getProposal(ID)?.computer).toBe('bot');
    expect(getAgentLog(ID)[0].detail).toContain('proposed Wide');
    expect(approveProposal(ID, shown(), live, NOW + 1)).toEqual({ ok: true });
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
    approveProposal(ID, shown(), live, NOW + 1);
    expect(getLoadedStrategy(ID)?.source).toEqual({
      by: 'computer',
      computer: 'bot',
      session: 'abcdef1234567890',
    });
    expect(getAgentLog(ID)[0].detail).toContain('a paired computer ("bot", session abcdef12)');
  });

  test('the diff shows caps, sendTo and tokens', () => {
    const base = exampleStrategy('ABC');
    const d = diffStrategy(base, { ...wide(), rules: { ...wide().rules, tokens: ['ABC', 'XYZ'] } });
    const whats = d.map((c) => c.what);
    expect(whats).toEqual(expect.arrayContaining(['Tokens', 'Sends only to', 'Most per trade', 'Most in total']));
    expect(d.find((c) => c.what === 'Most per trade')?.to).toBe('$9999');
  });

  // Review fix 1: the computer swaps the proposal between the sheet rendering and the owner's tap.
  test('approve loads only the proposal the sheet showed; a swapped one is refused', () => {
    const mine = exampleStrategy('ABC');
    loadStrategy(ID, mine, 'live', undefined, NOW);
    const from = { computer: 'bot', session: 'abcdef1234567890' };
    const tight = { ...mine, name: 'Tight', rules: { ...mine.rules, maxPerTradeUsd: 1 } };
    proposeStrategy(ID, tight, from, NOW + 1);
    const onScreen = shown();
    // Same `at`, different strategy: only the content tells them apart.
    proposeStrategy(ID, wide(), from, NOW + 1);
    expect(approveProposal(ID, onScreen, live, NOW + 2)).toEqual({ ok: false, reason: 'changed' });
    expect(getLoadedStrategy(ID)?.strategy).toEqual(mine);
    expect(getLoadedStrategy(ID)?.mode).toBe('live');
    expect(getProposal(ID)?.strategy.name).toBe('Wide'); // still waiting, for the owner to see
    // Approving what is on screen now works, and the key order of the stored JSON does not matter.
    const now = shown();
    const reordered = JSON.parse(
      JSON.stringify({ at: now.at, session: now.session, strategy: now.strategy, computer: now.computer }),
    );
    expect(approveProposal(ID, reordered as StrategyProposal, live, NOW + 3)).toEqual({ ok: true });
    expect(getLoadedStrategy(ID)?.strategy.name).toBe('Wide');
  });

  // Review fix 2 (belt and braces; sessions.ts also drops the proposal when the pairing ends).
  test('a proposal from a pairing that has ended is refused and dropped', async () => {
    const mine = exampleStrategy('ABC');
    loadStrategy(ID, mine, 'paper', undefined, NOW);
    await call(['strategy'], 'strategy_load', { strategy: wide() });
    const asked: string[] = [];
    const ended = (c: string, agent: string) => (asked.push(`${c}/${agent}`), false);
    expect(approveProposal(ID, shown(), ended, NOW + 1)).toEqual({ ok: false, reason: 'session-ended' });
    expect(asked).toEqual([`abcdef1234567890/${ID}`]);
    expect(getLoadedStrategy(ID)?.strategy).toEqual(mine);
    expect(getProposal(ID)).toBeNull();
  });

  // Review fix 4: the strategy record is lost but its spend ledger survives.
  test('a load after the strategy record was lost keeps the surviving ledger window', () => {
    loadStrategy(ID, exampleStrategy('ABC'), 'live', undefined, NOW);
    appendAgentLog(ID, { at: NOW + 10, action: 'buy', detail: 'x', usd: 7 });
    mem.delete(`bwallet.strategy.${ID}`);
    loadStrategy(ID, wide(), 'paper', undefined, NOW + 1000);
    const l = getLoadedStrategy(ID)!;
    expect(l.loadedAt).toBe(getStrategyLedger(ID)!.since);
    expect(strategyLedgerSpent(ID, l.loadedAt, NOW + 2000).totalUsd).toBe(7);
  });

  // Review fix 5: a proposal flood from one pairing must not push older provenance lines out of the log.
  test('repeated proposals from one session replace their log line instead of adding lines', () => {
    loadStrategy(ID, exampleStrategy('ABC'), 'paper', undefined, NOW);
    const before = getAgentLog(ID).length;
    for (let i = 0; i < 50; i++) proposeStrategy(ID, wide(), { computer: 'bot', session: 'abcdef1234567890' }, NOW + i);
    const log = getAgentLog(ID);
    expect(log.length).toBe(before + 1);
    expect(log[0].detail).toContain('proposed Wide');
    expect(log[0].repeat).toBe(50);
    expect(log.some((e) => e.detail.startsWith('Loaded '))).toBe(true);
    proposeStrategy(ID, wide(), { computer: 'other', session: 'ffffffff00000000' }, NOW + 99);
    expect(getAgentLog(ID).length).toBe(before + 2);
  });
});
