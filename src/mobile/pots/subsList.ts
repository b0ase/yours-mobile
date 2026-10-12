import type { Subscription } from './pots';

/** Status order on the Subscriptions tab: what is paying first, then paused, then finished ones. */
const RANK: Record<Subscription['status'], number> = { lowFunds: 0, active: 0, paused: 1, cancelled: 2, ended: 2 };

/** Every subscription for the Pots & Locks › Subscriptions tab: live ones by next payment, finished ones last. */
export const subsForTab = (subs: Subscription[]): Subscription[] =>
  [...subs].sort((a, b) => RANK[a.status] - RANK[b.status] || a.nextDue - b.nextDue);

/** Pots & Locks tabs and their router paths (public: /lock, /lock/locks, /lock/subscriptions). */
export type LockTab = 'pots' | 'locks' | 'subscriptions';
export const LOCK_TAB_PATH: Record<LockTab, string> = {
  pots: '/m/lock',
  locks: '/m/lock/locks',
  subscriptions: '/m/lock/subscriptions',
};
/** Router path → tab. Subscriptions only when they are switched on (store builds fall back to Pots). */
export const lockTabFor = (pathname: string, subsOn: boolean): LockTab => {
  const p = pathname.replace(/\/+$/, '');
  if (p === LOCK_TAB_PATH.locks) return 'locks';
  if (p === LOCK_TAB_PATH.subscriptions && subsOn) return 'subscriptions';
  return 'pots';
};
