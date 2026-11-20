/**
 * What the balance card says while a restored wallet is copied from the backup to this device (owner's restore of
 * 19 Nov 2026: about 30 minutes of "$0.00 Couldn't refresh" before the $0.95 showed).
 *
 * Before the copy starts, the backup's own spendable total is read once (a few bounded requests) and shown as
 * "Arriving: $X (moving your wallet to this device)". DISPLAY ONLY: this module has no path to coin selection, the
 * headline balance or any spend; the number lives here and in the card's lines, nowhere else. While the copy runs the
 * card also shows "Moving your wallet to this device: N of M"; when the copy and the coin checks are done the view is
 * cleared and the real balance is all that is left.
 */

export type RestoreView = {
  /** 'copying': rows are coming across; 'checking': the copy is in, the coin checks are running. */
  phase: 'copying' | 'checking';
  /** What the backup says is spendable (satoshis). Never spendable here until the copy is verified. */
  arrivingSats: number;
  done: number;
  total: number;
};

let view: RestoreView | null = null;

export const getRestoreView = (): RestoreView | null => (view ? { ...view } : null);
export const setRestoreView = (v: RestoreView | null) => void (view = v ? { ...v } : null);
export const clearRestoreView = () => void (view = null);

/** Progress as the rows arrive; `done` never passes `total` and never goes back. */
export const noteRestoreProgress = (done: number, total?: number) => {
  if (!view) return;
  const t = total !== undefined ? Math.max(0, Math.floor(total)) : view.total;
  view = { ...view, total: t, done: Math.max(view.done, Math.min(Math.max(0, Math.floor(done)), t)) };
};

/** Bounded reads of the backup's listing: the page size and a deadline on each request. */
export const PREVIEW_PAGE = 500;
export const PREVIEW_CALL_MS = 8_000;

/** Reject if `p` has not settled in `ms` (the late answer is ignored). */
export const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => undefined);
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`network: ${what} did not answer in ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/** The two lines the card shows while `v` is set (the text of the caller's `fmt` for the amount). */
export function restoreLines(
  v: RestoreView | null | undefined,
  fmt: (sats: number) => string,
  o: { hideAmounts?: boolean } = {},
): ({ kind: 'arriving'; text: string; sats: number } | { kind: 'progress'; text: string })[] {
  if (!v) return [];
  const out: ({ kind: 'arriving'; text: string; sats: number } | { kind: 'progress'; text: string })[] = [];
  const sats = Math.max(0, Math.round(v.arrivingSats || 0));
  if (!o.hideAmounts && sats > 0)
    out.push({ kind: 'arriving', text: `Arriving: ${fmt(sats)} (moving your wallet to this device)`, sats });
  out.push({
    kind: 'progress',
    text:
      v.phase === 'checking' || v.total <= 0
        ? 'Moving your wallet to this device: checking your coins'
        : `Moving your wallet to this device: ${v.done} of ${v.total}`,
  });
  return out;
}

type ChunkStore = { getSyncChunk?: (args: Record<string, unknown>) => Promise<unknown> };

/**
 * While a copy runs: every request for a page of the backup gets a smaller page and a deadline, and each page that
 * arrives moves the progress. Patches the store's own method and puts it back (the returned function), whatever
 * happens. A page that does not come in time fails the copy in seconds instead of holding it for minutes; the caller's
 * retry (the move's backoff) starts again from the checkpoint the toolbox keeps.
 */
export function boundCopyRequests(
  store: ChunkStore,
  o: { maxItems?: number; callMs?: number; onRows?: (rows: number) => void },
): () => void {
  const orig = store.getSyncChunk;
  if (typeof orig !== 'function') return () => undefined;
  const maxItems = o.maxItems ?? 100;
  const callMs = o.callMs ?? 20_000;
  store.getSyncChunk = (args) =>
    withTimeout(
      Promise.resolve(orig.call(store, { ...args, maxItems: Math.min(Number(args?.maxItems) || maxItems, maxItems) })),
      callMs,
      'the backup (getSyncChunk)',
    ).then((chunk) => {
      o.onRows?.(rowsIn(chunk));
      return chunk;
    });
  return () => {
    store.getSyncChunk = orig;
  };
}

/** Outputs and transactions in a sync chunk (the two the card counts). */
export const rowsIn = (chunk: unknown): number => {
  const c = chunk as { outputs?: unknown[]; transactions?: unknown[] } | null | undefined;
  return (
    (Array.isArray(c?.outputs) ? c.outputs.length : 0) + (Array.isArray(c?.transactions) ? c.transactions.length : 0)
  );
};
