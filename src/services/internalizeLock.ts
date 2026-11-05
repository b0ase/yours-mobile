/**
 * One internalize at a time across the three paths that take payments in: the address sync (services/prioritySync.ts),
 * the receive guard (initWallet) and the receive watcher (services/receiveWatch.ts).
 *
 * Owner, 5 Nov 2026: with a watcher asking the indexer every 3 s next to the address sync, both can find the same new
 * payment within seconds. Each checks "already taken in?" inside the lock and records it before letting go, so the
 * second one sees it done: a payment is taken in once. Held around each internalize only (never around a sweep, a
 * fetch or a retry's back-off), so a balance read or another payment never waits behind a slow network call.
 */
export type InternalizeLock = <T>(fn: () => Promise<T>) => Promise<T>;

export const createInternalizeLock = (): InternalizeLock => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
};
