/**
 * Agent accounts (docs/SMART-WALLET-SPEC.md §1). An agent account is an ordinary wallet account (its own
 * fresh seed, made by Add account) that agents may act on without asking each time. Its balance is
 * the agent's budget. This module keeps, per account (keyed by identity address):
 *   - the agent flag, labels, Stop, and an optional daily cap in dollars;
 *   - the activity log of everything an agent did;
 *   - `checkAgentSpend`, the gate every agent action must pass before signing.
 * Global "Stop all agents" sits beside them. Pure helpers + localStorage; nothing here signs.
 */

export type AgentAccount = {
  identityAddress: string;
  labels: string[];
  stopped: boolean;
  /** Most an agent may spend from this account per UTC day, in USD. null = no cap (the balance is the limit). */
  dailyCapUsd: number | null;
  createdAt: number;
};

export type AgentLogEntry = {
  at: number;
  /** What the agent did: 'send', 'buy', 'sell', 'list', 'mint', 'sweep', 'fund', 'stop', 'resume'… */
  action: string;
  detail: string;
  /** Dollars spent by this action (0 for non-spending actions). */
  usd: number;
  txid?: string;
  /** Which strategy rule caused it, once strategies exist (§3). */
  rule?: string;
};

const KEY = 'bwallet.agentAccounts';
const LOG = (id: string) => `bwallet.agentLog.${id}`;
const STOP_ALL = 'bwallet.agentsStopAll';
const LOG_MAX = 500;
const EVENT = 'bwallet:agents';

type Store = Record<string, AgentAccount>;

const read = <T>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const onAgentsChange = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

export const listAgentAccounts = (): AgentAccount[] => Object.values(read<Store>(KEY, {}));
export const getAgentAccount = (id?: string | null): AgentAccount | null => (id ? (read<Store>(KEY, {})[id] ?? null) : null);
export const isAgentAccount = (id?: string | null) => !!getAgentAccount(id);

const save = (a: AgentAccount) => write(KEY, { ...read<Store>(KEY, {}), [a.identityAddress]: a });

/** Mark an account as an agent account (Add account › Agent account). */
export const markAgentAccount = (identityAddress: string, labels: string[] = [], now = Date.now()) => {
  const a: AgentAccount = { identityAddress, labels: cleanLabels(labels), stopped: false, dailyCapUsd: null, createdAt: now };
  save(a);
  appendAgentLog(identityAddress, { at: now, action: 'create', detail: 'Agent account created', usd: 0 });
  return a;
};

/** Turn an agent account back into a normal account. The log is kept. */
export const unmarkAgentAccount = (identityAddress: string) => {
  const s = read<Store>(KEY, {});
  delete s[identityAddress];
  write(KEY, s);
};

export const cleanLabels = (labels: string[]) =>
  [...new Set(labels.map((l) => l.trim().slice(0, 24)).filter(Boolean))].slice(0, 8);

export const setAgentLabels = (id: string, labels: string[]) => {
  const a = getAgentAccount(id);
  if (a) save({ ...a, labels: cleanLabels(labels) });
};

export const setAgentStopped = (id: string, stopped: boolean, now = Date.now()) => {
  const a = getAgentAccount(id);
  if (!a || a.stopped === stopped) return;
  save({ ...a, stopped });
  appendAgentLog(id, { at: now, action: stopped ? 'stop' : 'resume', detail: stopped ? 'Stopped' : 'Resumed', usd: 0 });
};

export const setAgentDailyCap = (id: string, usd: number | null) => {
  const a = getAgentAccount(id);
  if (!a) return;
  const cap = usd === null || !Number.isFinite(usd) || usd <= 0 ? null : Math.round(usd * 100) / 100;
  save({ ...a, dailyCapUsd: cap });
};

/** "Stop all agents": every agent account refuses agent actions until turned off. */
export const allAgentsStopped = () => read<boolean>(STOP_ALL, false);
export const setAllAgentsStopped = (on: boolean) => write(STOP_ALL, on);

export const getAgentLog = (id: string): AgentLogEntry[] => read<AgentLogEntry[]>(LOG(id), []);
export const appendAgentLog = (id: string, e: AgentLogEntry) => write(LOG(id), [e, ...getAgentLog(id)].slice(0, LOG_MAX));

const dayStart = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** Dollars agents have spent from this account today (UTC). */
export const spentToday = (log: AgentLogEntry[], now = Date.now()) =>
  log.filter((e) => e.at >= dayStart(now)).reduce((sum, e) => sum + (e.usd > 0 ? e.usd : 0), 0);

export type SpendCheck = { ok: true } | { ok: false; reason: string };

/**
 * The gate for every agent action that spends: not an agent account, stopped, or over the daily cap → refused.
 * Pure over its inputs so it is unit-tested; `checkAgentSpend` reads the stored state.
 */
export const spendAllowed = (
  account: AgentAccount | null,
  stopAll: boolean,
  log: AgentLogEntry[],
  usd: number,
  now = Date.now(),
): SpendCheck => {
  if (!account) return { ok: false, reason: 'Not an agent account' };
  if (stopAll) return { ok: false, reason: 'All agents are stopped' };
  if (account.stopped) return { ok: false, reason: 'This agent account is stopped' };
  if (account.dailyCapUsd !== null) {
    const left = account.dailyCapUsd - spentToday(log, now);
    if (usd > left + 1e-9) return { ok: false, reason: `Over today's cap ($${Math.max(0, left).toFixed(2)} left of $${account.dailyCapUsd})` };
  }
  return { ok: true };
};

export const checkAgentSpend = (id: string, usd: number, now = Date.now()) =>
  spendAllowed(getAgentAccount(id), allAgentsStopped(), getAgentLog(id), usd, now);
