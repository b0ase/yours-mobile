/**
 * The backup as a device-sync PUSH writes to it (toolbox syncToWriter: makeAvailable, getSyncCheckpoint,
 * findOrInsertUser, findOrInsertSyncStateAuth, processSyncChunk). A view; the connection itself is never changed (a heal
 * may be arming its own deadlines on it). Owner's seal, 7 Nov 2026: the open-time push had no deadline and held the
 * storage queue the seal's payment waited in.
 *
 *  - A deadline on each request (PUSH_CALL_MS): a backup that stops answering fails the push, which frees the storage
 *    queue; the device sync retries on its back-off. A timed-out page is never counted as sent: the next push starts
 *    from the backup's own durable checkpoint, so a page the backup did commit is not sent twice and one it didn't is
 *    sent again.
 *  - Own payments go first (services/ownPayments.ts): after a page the backup COMMITTED (the page and its checkpoint
 *    go together in one transaction on the backup), if an own payment is waiting, the page is answered as the last one
 *    (`done`), so syncToWriter ends and lets go of the queue, and `onYield` tells the device sync to carry on later.
 *    Never mid-write: the check runs only once processSyncChunk has answered.
 */
export const PUSH_CALL_MS = 20_000;
const PUSH_CALLS = new Set([
  'makeAvailable',
  'getSyncCheckpoint',
  'findOrInsertUser',
  'findOrInsertSyncStateAuth',
  'processSyncChunk',
]);

export function pushView<T extends object>(
  writer: T,
  o: {
    waiting: () => boolean;
    onYield: () => void;
    callMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
  },
): T {
  const callMs = o.callMs ?? PUSH_CALL_MS;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const withDeadline = (name: string, call: Promise<unknown>) => {
    let timer: unknown;
    call.catch(() => undefined);
    return Promise.race([
      call,
      new Promise((_, reject) => {
        timer = setTimer(() => reject(new Error(`network: the backup did not answer in time (${name})`)), callMs);
      }),
    ]).finally(() => clearTimer(timer));
  };
  return new Proxy(writer, {
    get(target, p) {
      const v = Reflect.get(target, p, target) as unknown;
      if (typeof v !== 'function') return v;
      const fn = v as (...a: unknown[]) => unknown;
      const name = String(p);
      if (!PUSH_CALLS.has(name)) return fn.bind(target);
      return async (...a: unknown[]) => {
        const r = await withDeadline(
          name,
          Promise.resolve().then(() => fn.apply(target, a)),
        );
        if (name !== 'processSyncChunk' || !r || typeof r !== 'object') return r;
        const page = r as { done?: boolean };
        if (page.done || !o.waiting()) return r;
        o.onYield();
        return { ...page, done: true };
      };
    },
  });
}
