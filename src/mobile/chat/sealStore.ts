/**
 * Where the native seal keeps its state on this device (localStorage; nothing here leaves the phone):
 *  - PENDING (bwx.nativeSeal.pending): seals paid or maybe paid and not yet recorded (nativeSeal.PendingSeal). An unsure
 *    one carries the drawing, so a seal that recovery proves unpaid is offered again without a redraw.
 *  - DRAWINGS (bwx.nativeSeal.drawings): drawings kept after a seal that paid nothing, by sealKey, for one-tap "Seal
 *    again" (owner, 23 Nov 2026: one signature per document). Cleared on success, on Cancel at the sheet, on "Draw
 *    again", and after DRAWING_MAX_AGE_MS. At most DRAWINGS_CAP.
 *  - SEALED (bwx.nativeSeal.sealed): the ledger of seals recorded from this device (nativeSeal.SealLedger).
 * Every read and write is guarded: blocked storage reads as empty and never throws.
 */
import {
  DRAWING_MAX_AGE_MS,
  DRAWING_MAX_CHARS,
  type PendingSeal,
  type PendingSealStore,
  type SealClaim,
  type SealClaimStore,
  type SealDrawing,
  type SealDrawingStore,
  type SealLedger,
} from './nativeSeal';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export const PENDING_SEALS_KEY = 'bwx.nativeSeal.pending';
export const SEAL_DRAWINGS_KEY = 'bwx.nativeSeal.drawings';
/**
 * Pay-only retries running now, by sealKey (nativeSeal.SealClaim): shared by every context on this origin (an
 * extension popup and a tab), so two of them never both pay one kept seal (review of #560 M3).
 */
export const SEAL_CLAIMS_KEY = 'bwx.nativeSeal.claims';
/** Seals recorded from this device by sealKey (identity · document · blocks; nativeSeal.SealLedger). At most 500. */
export const SEALED_KEY = 'bwx.nativeSeal.sealed';
export const DRAWINGS_CAP = 10;
/**
 * A held seal (it may have been paid) is being finished. Here, not in sealScreen.ts, so the room's cards
 * (DocSignButton, PendingDocBanner) don't pull the seal screen's words into a store bundle.
 */
export const FINISHING_SEAL_LINE = 'Finishing your seal…';

const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const readList = <T>(store: Store | null, key: string): T[] => {
  try {
    const v = JSON.parse(store?.getItem(key) || '[]');
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};
const writeList = (store: Store | null, key: string, l: unknown[]) => {
  try {
    store?.setItem(key, JSON.stringify(l));
  } catch {
    /* storage blocked or full */
  }
};

const isDrawing = (d: unknown): d is SealDrawing => {
  const x = d as SealDrawing | null;
  return (
    !!x &&
    typeof x.key === 'string' &&
    typeof x.documentId === 'string' &&
    typeof x.identityKey === 'string' &&
    Array.isArray(x.fieldIds) &&
    typeof x.svg === 'string' &&
    x.svg.length <= DRAWING_MAX_CHARS &&
    typeof x.savedAt === 'number'
  );
};

export const localDrawings = (store: Store | null = defaultStore(), now: () => number = Date.now): SealDrawingStore => {
  const read = () =>
    readList<unknown>(store, SEAL_DRAWINGS_KEY).filter(
      (d): d is SealDrawing => isDrawing(d) && now() - d.savedAt < DRAWING_MAX_AGE_MS,
    );
  return {
    get: (key) => read().find((d) => d.key === key) ?? null,
    save: (d) =>
      writeList(store, SEAL_DRAWINGS_KEY, [...read().filter((x) => x.key !== d.key), d].slice(-DRAWINGS_CAP)),
    remove: (key) => {
      const all = readList<unknown>(store, SEAL_DRAWINGS_KEY);
      if (all.some((d) => isDrawing(d) && d.key === key))
        writeList(
          store,
          SEAL_DRAWINGS_KEY,
          read().filter((d) => d.key !== key),
        );
    },
  };
};

const isClaim = (c: unknown): c is SealClaim => {
  const x = c as SealClaim | null;
  return !!x && typeof x.key === 'string' && typeof x.by === 'string' && typeof x.until === 'number';
};
export const localClaims = (store: Store | null = defaultStore(), now: () => number = Date.now): SealClaimStore => {
  // Stale claims are dropped on every write, so the list stays tiny.
  const read = () => readList<unknown>(store, SEAL_CLAIMS_KEY).filter((c): c is SealClaim => isClaim(c));
  const live = () => read().filter((c) => c.until > now());
  return {
    get: (key) => read().find((c) => c.key === key) ?? null,
    save: (c) => writeList(store, SEAL_CLAIMS_KEY, [...live().filter((x) => x.key !== c.key), c]),
    remove: (key, by) =>
      writeList(
        store,
        SEAL_CLAIMS_KEY,
        live().filter((x) => !(x.key === key && x.by === by)),
      ),
  };
};

export const localStore = (store: Store | null = defaultStore(), now: () => number = Date.now): PendingSealStore => {
  const read = () => readList<PendingSeal>(store, PENDING_SEALS_KEY);
  return {
    list: read,
    save: (p) => writeList(store, PENDING_SEALS_KEY, [...read().filter((x) => x.nonce !== p.nonce), p]),
    remove: (n) =>
      writeList(
        store,
        PENDING_SEALS_KEY,
        read().filter((x) => x.nonce !== n),
      ),
    drawings: localDrawings(store, now),
    claims: localClaims(store, now),
  };
};

export const localLedger = (store: Store | null = defaultStore()): SealLedger => {
  const read = () => readList<unknown>(store, SEALED_KEY).filter((x): x is string => typeof x === 'string');
  return {
    has: (id) => read().includes(id),
    add: (id) => writeList(store, SEALED_KEY, [...read().filter((x) => x !== id), id].slice(-500)),
  };
};

/**
 * Is a seal of this document held on this device (paid or maybe paid, not recorded yet)? The room's card shows
 * "Finishing your seal…" then, never a fresh Sign button. Any signer: the seal page sorts out whose it is.
 */
export const heldSealFor = (documentId: string, store: PendingSealStore = localStore()): boolean => {
  if (!documentId) return false;
  try {
    return store.list().some((p) => p.documentId === documentId);
  } catch {
    return false;
  }
};
