/**
 * A strategy sent from a paired computer is a proposal, not a load (b-Aware 315). It waits here until the owner
 * approves it on the strategy card, which shows what would change and names the computer. Nothing about the loaded
 * strategy, its mode or its spend ledger changes until then. One proposal per account: a newer one replaces it.
 * Pure helpers + localStorage, like strategy.ts; nothing here signs.
 */
import { appendAgentLog } from './agentAccounts';
import { getLoadedStrategy, loadStrategy, pairedComputerLabel, type Strategy } from './strategy';
import { canonicalJson, cleanDeep, escapeLine, escapeText, quote } from './strategyText';

/**
 * `computer` is the pairing's name (the agent account it was paired to); `session` is the pairing channel id;
 * `expiresAt` is that pairing's grant expiry, so a re-pair on the same channel (a new grant) can't inherit it.
 */
export type StrategyProposal = { strategy: Strategy; computer: string; session: string; expiresAt: number; at: number };

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

/**
 * One pairing may replace its own waiting proposal at most this often. A computer flooding proposals would otherwise
 * keep re-arming the sheet's Approve delay so the owner could never approve the last one shown.
 */
export const PROPOSAL_MIN_GAP_MS = 5_000;
/**
 * When this account last accepted a proposal, from any pairing. Per account, not per pairing (two pairings taking
 * turns would otherwise keep Approve disarmed), and kept through Decline and Approve.
 */
const LAST_AT = (id: string) => `bwallet.strategy.proposalAt.${id}`;
const lastProposalAt = (id: string): number | null => {
  try {
    const v = Number(localStorage.getItem(LAST_AT(id)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};

/**
 * A computer proposes a strategy. Stored for the owner; the active strategy is untouched. Returns false (and logs it,
 * one merged line for the account) when this account accepted a proposal, from any pairing, less than
 * PROPOSAL_MIN_GAP_MS ago: the extra one is dropped.
 */
export const proposeStrategy = (
  id: string,
  strategy: Strategy,
  from: { computer: string; session: string; expiresAt: number },
  now = Date.now(),
): boolean => {
  const last = lastProposalAt(id);
  // abs: a clock set back doesn't block proposals until it catches up with a stamp in its future.
  if (last !== null && Math.abs(now - last) < PROPOSAL_MIN_GAP_MS) {
    appendAgentLog(id, {
      at: now,
      action: 'strategy',
      detail: `Ignored extra proposals from ${pairedComputerLabel(from.computer, from.session)}: at most one every ${PROPOSAL_MIN_GAP_MS / 1000} s`,
      usd: 0,
      merge: 'strategy-proposal-dropped',
    });
    return false;
  }
  try {
    localStorage.setItem(LAST_AT(id), String(now));
  } catch {
    /* storage unavailable: the proposal below can't be stored either */
  }
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
  return true;
};

export { canonicalJson };

/** What the approval sheet showed: the proposal and the strategy loaded at the time (its "from" column). */
export type ShownProposal = { proposal: StrategyProposal; current: Strategy | null };

/** The sheet's view right now. */
export const proposalView = (id: string): ShownProposal | null => {
  const proposal = getProposal(id);
  return proposal ? { proposal, current: getLoadedStrategy(id)?.strategy ?? null } : null;
};

/**
 * A stable key for what the owner is shown: changes whenever the proposal (or what it would load) changes, or the
 * strategy it is compared with changes.
 */
export const proposalKey = (v: ShownProposal) => {
  const p = v.proposal;
  return canonicalJson({
    at: p.at,
    session: p.session,
    computer: p.computer,
    expiresAt: p.expiresAt,
    strategy: p.strategy,
    current: v.current,
  });
};

export type ApproveResult = { ok: true } | { ok: false; reason: 'gone' | 'changed' | 'session-ended' | 'invisible' };

/**
 * Owner approves the proposal the sheet SHOWED (`shown`): it loads on paper (going live is still its own tap), tagged
 * with the computer it came from. Refused when the stored proposal or the loaded strategy is no longer exactly what
 * the sheet showed (changed between render and tap), or when the pairing that sent it has ended or is no longer the
 * same grant with the `strategy` scope (`sessionLive`, sessions.ts isAgentSessionLive), or when any change is in
 * characters the owner can't see (diffStrategy marks it `invisible`).
 */
export const approveProposal = (
  id: string,
  shown: ShownProposal,
  sessionLive: (session: string, agentId: string, expiresAt: number) => boolean,
  now = Date.now(),
): ApproveResult => {
  const v = proposalView(id);
  if (!v) return { ok: false, reason: 'gone' };
  if (proposalKey(v) !== proposalKey(shown)) return { ok: false, reason: 'changed' };
  const p = v.proposal;
  if (diffStrategy(v.current ?? undefined, p.strategy).some((c) => c.invisible))
    return { ok: false, reason: 'invisible' };
  if (typeof p.expiresAt !== 'number' || !sessionLive(p.session, id, p.expiresAt)) {
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

/**
 * One row of the approval sheet. `long`: free text (goals, changelog), shown in full in a scrolling box. `invisible`:
 * the values differ only in characters nobody can see (hidden or control characters, layout whitespace); such a
 * proposal can't be approved.
 */
export type StrategyChange = { what: string; from: string; to: string; long?: boolean; invisible?: boolean };

/**
 * Every field of a strategy, with how the sheet names it. Anything not listed here still shows, under its path:
 * a field nobody labelled can never read as "Same limits as now".
 */
const FIELDS: Record<string, { what: string; kind?: 'usd' | 'list' | 'stop' | 'long' }> = {
  name: { what: 'Name' },
  version: { what: 'Version' },
  format: { what: 'Format' },
  goals: { what: 'Goals (b follows these; they steer what it does)', kind: 'long' },
  'rules.tokens': { what: 'Tokens', kind: 'list' },
  'rules.actions': { what: 'Actions', kind: 'list' },
  'rules.sendTo': { what: 'Sends only to', kind: 'list' },
  'rules.maxPerTradeUsd': { what: 'Most per trade', kind: 'usd' },
  'rules.maxPerDayUsd': { what: 'Most per day', kind: 'usd' },
  'rules.maxTotalUsd': { what: 'Most in total', kind: 'usd' },
  'rules.buyBelowUsd': { what: 'Buy below', kind: 'usd' },
  'rules.sellAboveUsd': { what: 'Sell above', kind: 'usd' },
  'rules.stop.holdTokens': { what: 'Stop when holding', kind: 'stop' },
  'rules.stop.downPct': { what: 'Stop when down (%)', kind: 'stop' },
  'spec.trades': { what: 'Listing: trades' },
  'spec.risk': { what: 'Listing: risk' },
  'spec.spends': { what: 'Listing: spends' },
  'spec.often': { what: 'Listing: how often' },
  'spec.stops': { what: 'Listing: stops' },
  'spec.needs': { what: 'Listing: needs' },
  changelog: { what: 'Changelog', kind: 'long' },
};

/** Leaf values by path (`rules.stop.downPct`); arrays are leaves. */
const flatten = (v: unknown, path = '', out = new Map<string, unknown>()) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) if (x !== undefined) flatten(x, path ? `${path}.${k}` : k, out);
  } else if (path) out.set(path, v);
  return out;
};

/**
 * A value as the sheet shows it. Nothing can pass for something else: list items are quoted (["ABC, DEF"] never looks
 * like ["ABC", "DEF"]), and line breaks, control and hidden characters show as escapes, except the line breaks of
 * goals, which are free text.
 */
const show = (kind: (typeof FIELDS)[string]['kind'], v: unknown): string => {
  if (kind === 'usd') return v === undefined ? 'no limit' : `$${escapeLine(String(v))}`;
  if (kind === 'stop') return v === undefined ? 'never' : escapeLine(String(v));
  if (v === undefined) return 'none';
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.length ? v.map(quote).join(', ') : 'none';
  if (Array.isArray(v) && v.every((x) => x && typeof x === 'object' && 'version' in x && 'note' in x))
    return (v as { version: unknown; note: unknown }[])
      .map((c) => `${quote(String(c.version))}: ${quote(String(c.note))}`)
      .join('\n');
  if (typeof v === 'string') return kind === 'long' ? escapeText(v) : escapeLine(v);
  return escapeLine(canonicalJson(v));
};

/**
 * What a proposal would change against the current strategy (everything is "new" when nothing is loaded). Covers
 * every field: labelled ones in FIELDS order, then any other path by name. Empty exactly when the two are the same.
 */
export const diffStrategy = (current: Strategy | undefined, next: Strategy): StrategyChange[] => {
  const a = flatten(current);
  const b = flatten(next);
  const order = Object.keys(FIELDS);
  const paths = [...new Set([...order, ...[...a.keys(), ...b.keys()].sort()])];
  const out: StrategyChange[] = [];
  for (const path of paths) {
    const x = a.get(path);
    const y = b.get(path);
    if (canonicalJson(x) === canonicalJson(y)) continue;
    const f = FIELDS[path] ?? { what: path };
    const from = show(f.kind, x);
    const to = show(f.kind, y);
    const long = f.kind === 'long' || from.length > 120 || to.length > 120;
    // Cleaned the way a parsed strategy is (strategyText.ts), the two read the same: the difference is invisible.
    const invisible = canonicalJson(cleanDeep(x, path)) === canonicalJson(cleanDeep(y, path));
    out.push({
      what: invisible ? `${f.what} changed (invisible characters)` : f.what,
      from,
      to,
      ...(long && { long: true }),
      ...(invisible && { invisible: true }),
    });
  }
  if (!out.length && canonicalJson(current ?? null) !== canonicalJson(next))
    out.push({ what: 'Other details', from: canonicalJson(current ?? null), to: canonicalJson(next), long: true });
  return out;
};
