/**
 * Fast paymail inbox collection (owner, 14 Oct 2026: b0asey → $bug took ~40 s, up to 2 min, to arrive).
 *
 * Paymail payments to name@bwalletx.com pay a fresh BRC-29 address the wallet can't watch on chain; they arrive
 * only when the wallet collects its inbox on the paymail server (site/api/paymail.js `inbox`). That used to ride
 * on syncAccountNames (every 150 s, at most every 120 s). This polls just the inbox (one signed POST) every
 * POLL_MS while the app is visible, at once when it becomes visible again, and asks the Wallet home to refresh
 * when something was collected so the balance moves straight away.
 */
export const INBOX_POLL_MS = 12_000;

export type InboxPollEnv = {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  isVisible: () => boolean;
  onVisible: (cb: () => void) => () => void;
};

export const startInboxPoll = (
  collect: () => Promise<{ collected: number }>,
  onCollected: () => void,
  env: InboxPollEnv,
  intervalMs = INBOX_POLL_MS,
): (() => void) => {
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped || !env.isVisible()) return;
    busy = true;
    try {
      const r = await collect();
      if (!stopped && r.collected > 0) onCollected();
    } catch {
      /* offline / server down: next tick */
    } finally {
      busy = false;
    }
  };
  void tick();
  const t = env.setInterval(() => void tick(), intervalMs);
  const off = env.onVisible(() => void tick());
  return () => {
    stopped = true;
    env.clearInterval(t);
    off();
  };
};

export const browserInboxPollEnv = (): InboxPollEnv => ({
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  onVisible: (cb) => {
    if (typeof document === 'undefined') return () => {};
    const h = () => {
      if (document.visibilityState === 'visible') cb();
    };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  },
});
