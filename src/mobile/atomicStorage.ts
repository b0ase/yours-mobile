/**
 * All-or-nothing storage.local writes for the web wallet (re-review R2 of fix/web-one-tab, 13 Nov 2026).
 *
 * The web fallback (native.ts) writes each key with its own localStorage.setItem. One storage op can carry several
 * keys that only make sense together: a password change writes `accounts` (re-encrypted under the new key) and
 * `salt` in one set, a USB re-key adds `keyRecovery`. If localStorage fills up halfway, the old code left the keys it
 * had already written: new salt beside old accounts (or the reverse), and the next unlock failed (a lockout).
 *
 * applyAtomically: snapshot every key the op touches, write them all, and on any failure put every snapshot back
 * before rethrowing. A quota error first drops disposable caches (storageCaches.ts) and retries the whole op once.
 */

export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const isQuotaError = (e: unknown) =>
  e instanceof Error &&
  (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota/i.test(e.message));

export const applyAtomically = (
  storage: SyncStorage,
  sets: Record<string, string>,
  removes: string[],
  opts: { prefix?: string; freeSpace?: () => number } = {},
): void => {
  const prefix = opts.prefix ?? '';
  const keys = [...new Set([...Object.keys(sets), ...removes])].map((k) => prefix + k);
  const before = new Map<string, string | null>(keys.map((k) => [k, storage.getItem(k)]));
  const write = () => {
    for (const k of removes) storage.removeItem(prefix + k);
    for (const [k, v] of Object.entries(sets)) storage.setItem(prefix + k, v);
  };
  /** Put every key back as it was (shrinking writes first, so a restore never needs more space than it frees). */
  const restore = () => {
    const order = [...before].sort(
      ([a, va], [b, vb]) =>
        (va?.length ?? 0) - (storage.getItem(a)?.length ?? 0) - ((vb?.length ?? 0) - (storage.getItem(b)?.length ?? 0)),
    );
    let failed: unknown;
    for (const [k, v] of order) {
      try {
        if (storage.getItem(k) === v) continue;
        if (v === null) storage.removeItem(k);
        else storage.setItem(k, v);
      } catch (e) {
        failed ??= e;
      }
    }
    if (failed !== undefined) console.error('[storage] a failed write could not be fully undone:', failed);
  };
  try {
    write();
    return;
  } catch (error) {
    restore();
    if (!isQuotaError(error)) throw error;
    let freed = 0;
    try {
      freed = opts.freeSpace?.() ?? 0;
    } catch {
      freed = 0;
    }
    if (freed === 0) throw error;
    try {
      write();
    } catch (again) {
      restore();
      throw again;
    }
  }
};
