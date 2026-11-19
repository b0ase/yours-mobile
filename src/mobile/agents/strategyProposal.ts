/**
 * A strategy sent from a paired computer is a proposal, not a load (b-Aware 315). It waits here until the owner
 * approves it on the strategy card, which shows what would change and names the computer. Nothing about the loaded
 * strategy, its mode or its spend ledger changes until then. One proposal per account: a newer one replaces it.
 * Pure helpers + localStorage, like strategy.ts; nothing here signs.
 */
import { appendAgentLog } from './agentAccounts';
import { getLoadedStrategy, loadStrategy, pairedComputerLabel, type Strategy } from './strategy';

/** `computer` is the pairing's name (the agent account it was paired to); `session` is the pairing channel id. */
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
  // One log line per pairing session: a newer proposal replaces that session's earlier line, so a flood of proposals
  // cannot push older provenance lines out of the log.
  appendAgentLog(id, {
    at: now,
    action: 'strategy',
    detail: `${pairedComputerLabel(from.computer, from.session)} proposed ${strategy.name} v${strategy.version}; waiting for you to approve`,
    usd: 0,
    merge: `strategy-proposal:${from.session}`,
  });
};

/** JSON with object keys sorted at every level, so two strategies compare equal exactly when their content is equal. */
export const canonicalJson = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
};

/** A stable key for one proposal: changes whenever anything the owner is shown (or would load) changes. */
export const proposalKey = (p: StrategyProposal) =>
  canonicalJson({ at: p.at, session: p.session, computer: p.computer, strategy: p.strategy });

export type ApproveResult = { ok: true } | { ok: false; reason: 'gone' | 'changed' | 'session-ended' };

/**
 * Owner approves the proposal the sheet SHOWED (`shown`): it loads on paper (going live is still its own tap), tagged
 * with the computer it came from. Refused when the stored proposal is no longer exactly that one (the computer sent
 * another between render and tap), or when the pairing that sent it has ended (`sessionLive`, sessions.ts).
 */
export const approveProposal = (
  id: string,
  shown: StrategyProposal,
  sessionLive: (session: string, agentId: string) => boolean,
  now = Date.now(),
): ApproveResult => {
  const p = getProposal(id);
  if (!p) return { ok: false, reason: 'gone' };
  if (proposalKey(p) !== proposalKey(shown)) return { ok: false, reason: 'changed' };
  if (!sessionLive(p.session, id)) {
    store(id, null);
    appendAgentLog(id, {
      at: now,
      action: 'strategy',
      detail: `Dropped ${p.strategy.name} v${p.strategy.version} from ${pairedComputerLabel(p.computer, p.session)}: that pairing has ended`,
      usd: 0,
    });
    return { ok: false, reason: 'session-ended' };
  }
  loadStrategy(id, p.strategy, 'paper', undefined, now, { by: 'computer', computer: p.computer, session: p.session });
  store(id, null);
  return { ok: true };
};

/** A pairing ended (Disconnect, lapse, expiry): drop the proposal it sent, if that is the one waiting. */
export const dropProposalFromSession = (id: string, session: string) => {
  const p = getProposal(id);
  if (p && p.session === session) store(id, null);
};

export const declineProposal = (id: string, now = Date.now()) => {
  const p = getProposal(id);
  if (!p) return;
  store(id, null);
  appendAgentLog(id, {
    at: now,
    action: 'strategy',
    detail: `Declined ${p.strategy.name} v${p.strategy.version} from ${pairedComputerLabel(p.computer, p.session)}`,
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
