/** One coin resync at a time (automatic at unlock, or Settings › Resync coins): calls queue behind each other. */
let tail: Promise<unknown> = Promise.resolve();

export function withCoinResyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
