import { loadPrefs, type Prefs } from './prefs';

/**
 * One-click pay: skip the confirm step for a small paying action (tip, lock, later ticket burns) when
 *   - one-click is on,
 *   - the amount is a positive whole number of sats at or under the user's per-action limit, and
 *   - fewer than MAX_PER_MINUTE actions were auto-approved in the last minute (runaway guard), and the
 *     auto-approved total in that minute stays under MAX_PER_MINUTE × limit.
 * Anything else goes through the normal confirmation. Never approves above the limit.
 */
export const MAX_PER_MINUTE = 5;
export const WINDOW_MS = 60_000;

export type Approval = { at: number; sats: number };
export type Decision = { ok: true } | { ok: false; reason: 'off' | 'amount' | 'over-limit' | 'rate' };

export const decideOneClick = (
  sats: number,
  prefs: Pick<Prefs, 'oneClick' | 'oneClickLimit'>,
  history: readonly Approval[],
  now: number,
): Decision => {
  if (!prefs.oneClick) return { ok: false, reason: 'off' };
  if (!Number.isSafeInteger(sats) || sats < 1) return { ok: false, reason: 'amount' };
  if (sats > prefs.oneClickLimit) return { ok: false, reason: 'over-limit' };
  const recent = history.filter((h) => now - h.at < WINDOW_MS && h.at <= now);
  if (recent.length >= MAX_PER_MINUTE) return { ok: false, reason: 'rate' };
  const spent = recent.reduce((t, h) => t + h.sats, 0);
  if (spent + sats > MAX_PER_MINUTE * prefs.oneClickLimit) return { ok: false, reason: 'rate' };
  return { ok: true };
};

/** In-memory guard used by the app (an app restart resets the window; the limit itself always holds). */
export const createOneClickGuard = (getPrefs: () => Pick<Prefs, 'oneClick' | 'oneClickLimit'> = loadPrefs) => {
  let history: Approval[] = [];
  return {
    /** Checks and, if allowed, records the approval atomically. Call right before paying. */
    take(sats: number, now = Date.now()): Decision {
      const d = decideOneClick(sats, getPrefs(), history, now);
      if (d.ok) history = [...history.filter((h) => now - h.at < WINDOW_MS), { at: now, sats }];
      return d;
    },
    /** Would `take` allow it (no recording)? For labelling buttons. */
    peek(sats: number, now = Date.now()): Decision {
      return decideOneClick(sats, getPrefs(), history, now);
    },
  };
};

/** Shared guard for every paying action in the app. */
export const oneClick = createOneClickGuard();
