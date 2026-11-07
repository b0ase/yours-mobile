/**
 * An IndexedDB transaction aborted from outside goes again once (owner's iPhone, 7 Nov 2026 12:28:25, test/phone-1107
 * first launch: "Wallet sync failing: address sync: IDB transaction aborted"). WebKit aborts open IndexedDB
 * transactions when it suspends the app; @1sat/wallet-browser's permission store then rejects with exactly that
 * message (no tx.error), and the toolbox's idb-based store with a DOM AbortError. An aborted transaction writes
 * nothing, so the work only has to run again; a second abort is a real failure and is reported as before.
 */
export const IDB_ABORT_RETRY_MS = 2_000;

export const isIdbAbort = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') return false;
  const { name, message } = e as { name?: unknown; message?: unknown };
  return name === 'AbortError' || /IDB transaction aborted/.test(String(message ?? ''));
};

/**
 * Run; on an IDB abort wait `IDB_ABORT_RETRY_MS` (a timer frozen while the app is suspended fires after it resumes)
 * and run once more. Any other error, or a second abort, is thrown.
 */
export async function retryOnceOnIdbAbort<T>(
  run: () => Promise<T>,
  o: { sleep?: (ms: number) => Promise<void>; log?: (m: string) => void } = {},
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!isIdbAbort(e)) throw e;
    (o.log ?? ((m: string) => console.warn(m)))('[idbAbort] a storage transaction was aborted: trying once more');
    await (o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(IDB_ABORT_RETRY_MS);
    return run();
  }
}

const READS = ['findGrant', 'listGrants'] as const;

/** The store with each aborted READ tried once more at once. Writes are left alone. Returns the same object. */
export function retryReadsOnIdbAbort<S extends object>(store: S): S {
  const s = store as Record<string, unknown>;
  for (const name of READS) {
    const fn = s[name];
    if (typeof fn !== 'function') continue;
    const read = (fn as (...a: unknown[]) => Promise<unknown>).bind(store);
    s[name] = (...a: unknown[]) => read(...a).catch((e: unknown) => (isIdbAbort(e) ? read(...a) : Promise.reject(e)));
  }
  return store;
}
