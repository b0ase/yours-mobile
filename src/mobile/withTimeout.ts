/** Reject after `ms` so a hung request can never hold a busy flag (or a spinner) forever. */
export function withTimeout<T>(p: Promise<T>, ms: number, what = 'request'): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}
