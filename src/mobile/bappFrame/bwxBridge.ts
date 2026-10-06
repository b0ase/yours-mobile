/**
 * BWX: wallet-only data for our own bAgents bApp (docs/BAGENTS-PLAN.md), beside BRC-100 CWI.
 *   page → wallet: { type: 'BWX', isInvocation: true, id, call: 'agents.list', args }
 *   wallet → page: { type: 'BWX', isInvocation: false, id, status: 'success', result }
 *                | { type: 'BWX', isInvocation: false, id, status: 'error', description }
 *   wallet → page: { type: 'BWX', isInvocation: false, event: 'agents.changed' } (push)
 * First-party only (owner, 6 Oct 2026): answered for the bAgents origins below and refused for every other,
 * even ones on the bApps list. Pure: storage, accounts and the confirmation sheet come in as deps.
 */
import type { AgentAccount, AgentLogEntry } from '../agents/agentAccounts';

export const BWX_ORIGINS = ['https://agents.bwalletx.com', 'https://bagents.vercel.app'] as const;

/** Exact match only: no suffix/prefix games, no paths. */
export const isBwxOrigin = (origin: unknown): boolean =>
  typeof origin === 'string' && (BWX_ORIGINS as readonly string[]).includes(origin);

export type BwxId = string | number;
export type BwxRequest = { id: BwxId; call: string; args: Record<string, unknown> };

const MAX_ID = 128;

/** Validates a BWX invocation; null for anything malformed. */
export const parseBwx = (msg: unknown): BwxRequest | null => {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return null;
  const d = msg as Record<string, unknown>;
  if (d.type !== 'BWX' || d.isInvocation !== true) return null;
  const idOk =
    (typeof d.id === 'string' && d.id.length > 0 && d.id.length <= MAX_ID) ||
    (typeof d.id === 'number' && Number.isFinite(d.id));
  if (!idOk) return null;
  if (typeof d.call !== 'string' || d.call.length === 0 || d.call.length > 64) return null;
  const args = d.args === undefined ? {} : d.args;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  return { id: d.id as BwxId, call: d.call, args: args as Record<string, unknown> };
};

export const bwxSuccess = (id: BwxId, result: unknown) =>
  ({ type: 'BWX', isInvocation: false, id, status: 'success', result }) as const;
export const bwxError = (id: BwxId, description: string) =>
  ({ type: 'BWX', isInvocation: false, id, status: 'error', description }) as const;
export const BWX_CHANGED = { type: 'BWX', isInvocation: false, event: 'agents.changed' } as const;

export type BwxScreen = 'fund' | 'sweep' | 'receive';
const SCREENS: readonly string[] = ['fund', 'sweep', 'receive'];

export type BwxDeps = {
  listAgents: () => AgentAccount[];
  getAgent: (id: string) => AgentAccount | null;
  ghostColorOf: (id: string) => string | null;
  /** Display name and $handle of an account on this device. */
  accountInfo: (id: string) => { name: string; handle: string };
  currentId: () => string | undefined;
  /** Cached balance in dollars, or null when the wallet has none cached. */
  balanceUsd: (id: string) => number | null;
  getLog: (id: string) => AgentLogEntry[];
  spentToday: (log: AgentLogEntry[]) => number;
  allStopped: () => boolean;
  setStopped: (id: string, stopped: boolean) => void;
  setAllStopped: (on: boolean) => void;
  setCap: (id: string, usd: number | null) => void;
  setLabels: (id: string, labels: string[]) => void;
  /** The wallet's own confirmation sheet; never one the bApp draws. */
  confirm: (text: string) => Promise<boolean>;
  openAccount: (id: string, screen?: BwxScreen) => void | Promise<void>;
  createAgent: () => void | Promise<void>;
};

export class BwxError extends Error {}
const fail = (m: string): never => {
  throw new BwxError(m);
};

const agentId = (args: Record<string, unknown>, deps: BwxDeps): AgentAccount => {
  const id = args.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) fail('id must be an agent account id');
  return deps.getAgent(id as string) ?? fail('Unknown agent account');
};

const cents = (n: number) => Math.round(n * 100) / 100;
/** Same rule as setAgentDailyCap: 0 means no cap. */
const effectiveCap = (usd: number | null) => (usd === null || usd <= 0 ? null : cents(usd));

const MAX_CAP_USD = 1_000_000;
const MAX_LABELS = 32;
const MAX_LABEL_LEN = 64;

/** Answers one BWX call. Throws BwxError (or anything) for an error reply. */
export const handleBwx = async (call: string, args: Record<string, unknown>, deps: BwxDeps): Promise<unknown> => {
  switch (call) {
    case 'agents.list': {
      const current = deps.currentId();
      const agents = deps.listAgents().map((a) => {
        const id = a.identityAddress;
        const { name, handle } = deps.accountInfo(id);
        return {
          id,
          name,
          handle,
          ghostColor: deps.ghostColorOf(id),
          labels: a.labels,
          stopped: a.stopped,
          dailyCapUsd: a.dailyCapUsd,
          balanceUsd: deps.balanceUsd(id),
          spentTodayUsd: cents(deps.spentToday(deps.getLog(id))),
          isCurrent: id === current,
        };
      });
      return { agents, allStopped: deps.allStopped() };
    }
    case 'agents.log': {
      const a = agentId(args, deps);
      let limit = 50;
      if (args.limit !== undefined) {
        const l = args.limit;
        if (typeof l !== 'number' || !Number.isInteger(l) || l < 1 || l > 200) fail('limit must be an integer 1–200');
        limit = l as number;
      }
      return deps
        .getLog(a.identityAddress)
        .slice(0, limit)
        .map(({ action, detail, usd, txid, rule, at }) => ({ action, detail, usd, txid, rule, at }));
    }
    case 'agents.stop': {
      // Stopping is always safe: one tap, no prompt.
      deps.setStopped(agentId(args, deps).identityAddress, true);
      return true;
    }
    case 'agents.resume': {
      const a = agentId(args, deps);
      if (!a.stopped) return true;
      const { name } = deps.accountInfo(a.identityAddress);
      if (!(await deps.confirm(`Resume ${name || 'this agent'}? It may spend from its account again.`)))
        fail('Cancelled');
      deps.setStopped(a.identityAddress, false);
      return true;
    }
    case 'agents.stopAll':
      deps.setAllStopped(true);
      return true;
    case 'agents.resumeAll': {
      if (!deps.allStopped()) return true;
      if (!(await deps.confirm('Resume all agents? They may spend from their accounts again.'))) fail('Cancelled');
      deps.setAllStopped(false);
      return true;
    }
    case 'agents.setCap': {
      const a = agentId(args, deps);
      const usd = args.usd;
      if (usd !== null && (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > MAX_CAP_USD))
        fail('usd must be a number ≥ 0 or null');
      const next = effectiveCap(usd as number | null);
      const prev = a.dailyCapUsd;
      if (next === prev) return true;
      const loosens = next === null || (prev !== null && next > prev);
      if (loosens) {
        const { name } = deps.accountInfo(a.identityAddress);
        const text =
          next === null
            ? `Remove the daily cap for ${name || 'this agent'}? Its balance becomes the only limit.`
            : `Raise the daily cap for ${name || 'this agent'} from $${prev} to $${next}?`;
        if (!(await deps.confirm(text))) fail('Cancelled');
      }
      deps.setCap(a.identityAddress, next);
      return true;
    }
    case 'agents.setLabels': {
      const a = agentId(args, deps);
      const labels = args.labels;
      if (
        !Array.isArray(labels) ||
        labels.length > MAX_LABELS ||
        !labels.every((l) => typeof l === 'string' && l.length <= MAX_LABEL_LEN)
      )
        fail('labels must be a list of short strings');
      deps.setLabels(a.identityAddress, labels as string[]);
      return true;
    }
    case 'agents.open': {
      const a = agentId(args, deps);
      const screen = args.screen;
      if (screen !== undefined && (typeof screen !== 'string' || !SCREENS.includes(screen)))
        fail('screen must be fund, sweep or receive');
      await deps.openAccount(a.identityAddress, screen as BwxScreen | undefined);
      return true;
    }
    case 'agents.create':
      await deps.createAgent();
      return true;
    default:
      return fail(`Unknown call: ${call}`);
  }
};

/** handleBwx as a reply message: never throws. */
export const answerBwx = async (req: BwxRequest, deps: BwxDeps) => {
  try {
    return bwxSuccess(req.id, await handleBwx(req.call, req.args, deps));
  } catch (e) {
    return bwxError(req.id, e instanceof Error && e.message ? e.message : 'Request failed');
  }
};
