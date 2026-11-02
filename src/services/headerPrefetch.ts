/**
 * Block headers fetched before wallet storage opens its transaction.
 *
 * Owner, 2 Nov 2026: 0.69793933 BSV (6efedf8c…1010) never reached the iPhone balance. Every retry failed with
 * "Failed to execute 'objectStore' on 'IDBTransaction': The transaction finished." The toolbox's internalizeAction
 * opens an IndexedDB transaction and, for a mined transaction, fetches that block's header from the network inside
 * it (findOrInsertProvenTxFromBump → services.getHeaderForHeight). IndexedDB commits a transaction as soon as it is
 * left waiting on anything but its own requests, so the next write finds it finished. On desktop the header was
 * usually cached by then; on the phone it never was.
 *
 * Fix: headers are kept for the session (a mined height's header never changes in practice), and internalizeAction
 * first fetches every header its BEEF's proofs need, so the call inside the transaction is answered from memory
 * without a network round trip.
 */
import { Beef } from '@bsv/sdk';

type HeaderServices = { getHeaderForHeight?: (height: number) => Promise<number[]> };
type Internalizer = { internalizeAction: (args: { tx: number[] }, originator?: string) => Promise<unknown> };

const CACHED = Symbol.for('bwallet.headerCache');

/** Keep getHeaderForHeight answers for the session. False when the services have no such method. */
export function cacheBlockHeaders(services: unknown): boolean {
  const s = services as HeaderServices & { [CACHED]?: true };
  if (typeof s?.getHeaderForHeight !== 'function') return false;
  if (s[CACHED]) return true;
  const fetchHeader = s.getHeaderForHeight.bind(s);
  const headers = new Map<number, number[]>();
  const pending = new Map<number, Promise<number[]>>();
  s.getHeaderForHeight = (height: number) => {
    const known = headers.get(height);
    if (known) return Promise.resolve(known);
    let p = pending.get(height);
    if (!p) {
      p = fetchHeader(height)
        .then((h) => {
          headers.set(height, h);
          return h;
        })
        .finally(() => pending.delete(height));
      pending.set(height, p);
    }
    return p;
  };
  s[CACHED] = true;
  return true;
}

/** Block heights of every merkle proof in a BEEF; none when it does not parse. */
export const beefProofHeights = (beef: number[]): number[] => {
  try {
    return [...new Set(Beef.fromBinary(beef).bumps.map((b) => b.blockHeight))];
  } catch {
    return [];
  }
};

/**
 * Fetch the headers a BEEF needs before `wallet.internalizeAction` runs. A header that can't be fetched now is left
 * to the toolbox, which reports its own error.
 */
export function prefetchHeadersOnInternalize(wallet: unknown, services: unknown): boolean {
  const w = wallet as Internalizer;
  const s = services as HeaderServices;
  if (typeof w?.internalizeAction !== 'function' || typeof s?.getHeaderForHeight !== 'function') return false;
  const internalize = w.internalizeAction.bind(w);
  w.internalizeAction = async (args, originator) => {
    const heights = Array.isArray(args?.tx) ? beefProofHeights(args.tx) : [];
    await Promise.all(heights.map((h) => s.getHeaderForHeight!(h).catch(() => undefined)));
    return internalize(args, originator);
  };
  return true;
}
