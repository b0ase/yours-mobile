/**
 * A strategy sent from a paired computer is a proposal, not a load (b-Aware 315). It waits here until the owner
 * approves it on the strategy card, which shows what would change and names the computer. Nothing about the loaded
 * strategy, its mode or its spend ledger changes until then. One proposal per account: a newer one replaces it.
 * Pure helpers + localStorage, like strategy.ts; nothing here signs.
 */
import { appendAgentLog } from './agentAccounts';
import { getLoadedStrategy, loadStrategy, type Strategy } from './strategy';

export type StrategyProposal = { strategy: Strategy; computer: string; session: string; at: number };

const KEY = (id: string) => `bwallet.strategy.proposal.${id}`;

export const getProposal = (id: string): StrategyProposal | null => {
  try {
    const v = localStorage.getItem(KEY(id));
    return v ? (JSON.parse(v) as StrategyProposal) : null;
  } catch {
    return null;
  }
};

const store = (id: string, p: StrategyProposal | null) => {
  try {
    if (p) localStorage.setItem(KEY(id), JSON.stringify(p));
    else localStorage.removeItem(KEY(id));
  } catch {
    /* storage unavailable */
  }
  try {
    window.dispatchEvent(new Event('bwallet:agents'));
  } catch {
    /* no window (tests) */
  }
};

/** A computer proposes a strategy. Stored for the owner; the active strategy is untouched. */
export const proposeStrategy = (
  id: string,
  strategy: Strategy,
  from: { computer: string; session: string },
  now = Date.now(),
) => {
  store(id, { strategy, ...from, at: now });
  appendAgentLog(id, {
    at: now,
    action: 'strategy',
    detail: `${from.computer} (session ${from.session.slice(0, 8)}) proposed ${strategy.name} v${strategy.version}; waiting for you to approve`,
    usd: 0,
  });
};

/** Owner approves: it loads on paper (going live is still its own tap), tagged with the computer it came from. */
export const approveProposal = (id: string, now = Date.now()) => {
  const p = getProposal(id);
  if (!p) return false;
  loadStrategy(id, p.strategy, 'paper', undefined, now, { by: 'computer', computer: p.computer, session: p.session });
  store(id, null);
  return true;
};

export const declineProposal = (id: string, now = Date.now()) => {
  const p = getProposal(id);
  if (!p) return;
  store(id, null);
  appendAgentLog(id, {
    at: now,
    action: 'strategy',
    detail: `Declined ${p.strategy.name} v${p.strategy.version} from ${p.computer}`,
    usd: 0,
  });
};

export type StrategyChange = { what: string; from: string; to: string };

const list = (a?: string[]) => (a && a.length ? a.join(', ') : 'none');
const usd = (n?: number) => (n === undefined ? 'no limit' : `$${n}`);

/** What a proposal would change against the current strategy (everything is "new" when nothing is loaded). */
export const diffStrategy = (current: Strategy | undefined, next: Strategy): StrategyChange[] => {
  const a = current?.rules;
  const b = next.rules;
  const out: StrategyChange[] = [];
  const add = (what: string, from: string, to: string) => from !== to && out.push({ what, from, to });
  add('Name', current ? `${current.name} v${current.version}` : 'none loaded', `${next.name} v${next.version}`);
  add('Tokens', list(a?.tokens), list(b.tokens));
  add('Actions', list(a?.actions), list(b.actions));
  add('Sends only to', list(a?.sendTo), list(b.sendTo));
  add('Most per trade', a ? usd(a.maxPerTradeUsd) : 'none', usd(b.maxPerTradeUsd));
  add('Most per day', usd(a?.maxPerDayUsd), usd(b.maxPerDayUsd));
  add('Most in total', usd(a?.maxTotalUsd), usd(b.maxTotalUsd));
  add('Buy below', usd(a?.buyBelowUsd), usd(b.buyBelowUsd));
  add('Sell above', usd(a?.sellAboveUsd), usd(b.sellAboveUsd));
  add('Stop when holding', String(a?.stop?.holdTokens ?? 'never'), String(b.stop?.holdTokens ?? 'never'));
  return out;
};

/** The current strategy's diff against a stored proposal, for the approval sheet. */
export const proposalChanges = (id: string, p: StrategyProposal) =>
  diffStrategy(getLoadedStrategy(id)?.strategy, p.strategy);
