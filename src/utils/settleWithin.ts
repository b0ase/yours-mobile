export type Settled = 'done' | 'failed' | 'timeout';

/**
 * How `run` ended within `ms`: never throws and never waits longer than `ms`. For closes and cleanups that must not
 * hold up what follows (an account switch's reload, a wallet close) when one of them hangs.
 */
export const settleWithin = (run: () => unknown, ms: number): Promise<Settled> =>
  new Promise<Settled>((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    const finish = (how: Settled) => {
      clearTimeout(t);
      resolve(how);
    };
    try {
      Promise.resolve(run()).then(
        () => finish('done'),
        () => finish('failed'),
      );
    } catch {
      finish('failed');
    }
  });

/** `run`'s result, or an Error saying `what` took too long once `ms` passes. For steps that must finish, not hang. */
export const within = <T>(run: () => T | Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} took too long.`)), ms);
    Promise.resolve()
      .then(run)
      .then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(t);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
  });
