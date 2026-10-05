import { useEffect, useState } from 'react';
import { PROVIDERS, PROVIDER_IDS, cleanModel, isProviderId, type ProviderId } from './providers';
import { agentModeFor } from '../storeBuild';

/**
 * b agent settings (Settings › b agent). Device-wide localStorage: UI choices only. Keys are NOT
 * here; they live in secure storage (keyStore.ts).
 */
export type AgentMode = 'paid' | 'own';
// In US cents: we charge in dollars (owner, 6 Oct 2026: the old 50,000-sat default was about 1¢, one message a day).
export const DAILY_LIMITS = [0, 25, 100, 500, 2_000] as const;
/** Cents → sats at today's BSV price (0 if the price is unknown, which refuses paid messages). */
export const limitSats = (cents: number, bsvUsd: number) => (bsvUsd > 0 ? Math.floor((cents / 100 / bsvUsd) * 1e8) : 0);
export type DailyLimit = (typeof DAILY_LIMITS)[number];

export type AgentPrefs = {
  mode: AgentMode;
  provider: ProviderId;
  /** Chosen model per provider. */
  models: Record<ProviderId, string>;
  /** Pay mode: most US cents the agent may spend per calendar day (0 = off, every message refused). */
  dailyLimitCents: DailyLimit;
};

const defaultModels = () =>
  Object.fromEntries(PROVIDER_IDS.map((p) => [p, PROVIDERS[p].defaultModel])) as Record<ProviderId, string>;

export const DEFAULT_AGENT_PREFS: AgentPrefs = {
  mode: 'paid',
  provider: 'anthropic',
  models: defaultModels(),
  dailyLimitCents: 100,
};

export const parseAgentPrefs = (raw: unknown): AgentPrefs => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const models = r.models && typeof r.models === 'object' ? (r.models as Record<string, unknown>) : {};
  return {
    // Store build: own key only (storeBuild.ts).
    mode: agentModeFor(r.mode === 'own' || r.mode === 'paid' ? r.mode : DEFAULT_AGENT_PREFS.mode),
    provider: isProviderId(r.provider) ? r.provider : DEFAULT_AGENT_PREFS.provider,
    models: Object.fromEntries(PROVIDER_IDS.map((p) => [p, cleanModel(p, models[p])])) as Record<ProviderId, string>,
    // Older prefs stored sats (dailyLimitSats): they fall back to the default.
    dailyLimitCents: (DAILY_LIMITS as readonly unknown[]).includes(r.dailyLimitCents)
      ? (r.dailyLimitCents as DailyLimit)
      : DEFAULT_AGENT_PREFS.dailyLimitCents,
  };
};

const KEY = 'bwallet.agent';
const EVENT = 'bwallet-agent-prefs';

export const loadAgentPrefs = (): AgentPrefs => {
  try {
    return parseAgentPrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return parseAgentPrefs(null);
  }
};

export const saveAgentPrefs = (patch: Partial<AgentPrefs>): AgentPrefs => {
  const next = parseAgentPrefs({ ...loadAgentPrefs(), ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full / private mode: keep in memory for this render */
  }
  window.dispatchEvent(new Event(EVENT));
  return next;
};

export const useAgentPrefs = (): [AgentPrefs, (patch: Partial<AgentPrefs>) => void] => {
  const [prefs, setPrefs] = useState(loadAgentPrefs);
  useEffect(() => {
    const on = () => setPrefs(loadAgentPrefs());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return [prefs, (patch) => setPrefs(saveAgentPrefs(patch))];
};

// Daily spend ledger (pay mode) -----------------------------------------------------------------

export type SpendLedger = { day: string; sats: number };
const SPEND_KEY = 'bwallet.agent.spend';

/** Local calendar day, YYYY-MM-DD. */
export const dayOf = (now: number) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const spentToday = (ledger: SpendLedger | null, now: number) =>
  ledger && ledger.day === dayOf(now) && Number.isFinite(ledger.sats) ? ledger.sats : 0;

export const addSpend = (ledger: SpendLedger | null, sats: number, now: number): SpendLedger => ({
  day: dayOf(now),
  sats: spentToday(ledger, now) + sats,
});

export const loadSpend = (): SpendLedger | null => {
  try {
    const v = JSON.parse(localStorage.getItem(SPEND_KEY) ?? 'null') as SpendLedger | null;
    return v && typeof v.day === 'string' && typeof v.sats === 'number' ? v : null;
  } catch {
    return null;
  }
};

export const recordSpend = (sats: number, now = Date.now()) => {
  try {
    localStorage.setItem(SPEND_KEY, JSON.stringify(addSpend(loadSpend(), sats, now)));
  } catch {
    /* ignore */
  }
};
