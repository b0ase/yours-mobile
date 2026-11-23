import { accountHandles } from '../chat/nativeSeal';
import { classifyServerRows, type ServerRow, type SignedRow } from './signedList';
import { saveCachedSync } from './localStore';

/**
 * bit-sign as a SYNC SOURCE for Signed: GET /api/bitsign/signatures (my rows plus my rooms' documents) and
 * GET /api/bitsign/me/handles (every handle that is me, so a block bound to $boase counts when signed in as $b0asex).
 * The wallet's own record (localStore.ts) never depends on this succeeding.
 */
export type SyncState =
  | { k: 'idle' }
  | { k: 'loading' }
  | { k: 'ok'; at: number }
  /** No bChatX session on this account: the local list still shows, with a Sign in button. */
  | { k: 'signed_out' }
  /** No network (or bit-sign unreachable): the local list and the last sync still show. */
  | { k: 'offline' }
  | { k: 'error'; text: string };

/** GET as the wallet's bChatX session; throws { status } on a refusal (BchatClient.request). */
export type Get = (path: string) => Promise<unknown>;

export async function fetchServerRows(get: Get, sessionHandle: string): Promise<SignedRow[]> {
  const [list, handles] = await Promise.all([
    get('/api/bitsign/signatures'),
    // Only to widen "mine": a failure here still lists, with the session handle alone.
    get('/api/bitsign/me/handles').catch(() => null),
  ]);
  const rows = (list as { signatures?: unknown } | null)?.signatures;
  if (!Array.isArray(rows)) throw Object.assign(new Error('bit-sign sent an unexpected answer.'), { status: 502 });
  return classifyServerRows(rows as ServerRow[], [sessionHandle, ...accountHandles(handles)]);
}

/** A failed sync, in plain words. Status 0 (no answer) is offline; 401 is signed out. */
export const syncFailure = (e: unknown, online = typeof navigator === 'undefined' || navigator.onLine !== false) => {
  const status = Number((e as { status?: unknown } | null)?.status);
  if (!online || status === 0) return { k: 'offline' } as const;
  if (status === 401) return { k: 'signed_out' } as const;
  if (status >= 500) return { k: 'error', text: 'bChatX is having trouble right now. Try again in a minute.' } as const;
  const msg = e instanceof Error && e.message ? e.message : 'Could not load your documents.';
  return { k: 'error', text: msg.slice(0, 200) } as const;
};

/** At most one sync with bit-sign per account per SYNC_EVERY_MS, failures included (review of #561, M4). */
export const SYNC_EVERY_MS = 5 * 60_000;
type Result = { state: SyncState; rows: SignedRow[] | null };
const lastAttempt = new Map<string, number>();
const lastState = new Map<string, SyncState>();
const inFlight = new Map<string, Promise<Result>>();
/** Tests only. */
export const resetSyncThrottle = () => {
  lastAttempt.clear();
  lastState.clear();
  inFlight.clear();
};

async function runSync(identityKey: string, get: Get, sessionHandle: string, now: () => number): Promise<Result> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { state: { k: 'offline' }, rows: null };
  try {
    const rows = await fetchServerRows(get, sessionHandle);
    const at = now();
    saveCachedSync(identityKey, rows, at);
    return { state: { k: 'ok', at }, rows };
  } catch (e) {
    return { state: syncFailure(e), rows: null };
  }
}

/**
 * One sync, shared: the menu's quiet sync and the page share one in-flight request and one clock, so bit-sign sees at
 * most one list request per account per SYNC_EVERY_MS even when it keeps failing. Inside that window the answer is the
 * last state with no rows (the page shows its cache). `force` is only for the user's own tap (Try again, Sign in).
 * `get` null = no session (signed out): no request, and the clock is not touched. Never throws.
 */
export function syncSigned(
  identityKey: string,
  get: Get | null,
  sessionHandle: string,
  opts: { force?: boolean; now?: () => number } = {},
): Promise<Result> {
  const now = opts.now ?? Date.now;
  if (!get) return Promise.resolve({ state: { k: 'signed_out' }, rows: null });
  const key = identityKey.toLowerCase();
  const running = inFlight.get(key);
  if (running) return running;
  const last = lastAttempt.get(key);
  if (!opts.force && last !== undefined && now() - last < SYNC_EVERY_MS)
    return Promise.resolve({ state: lastState.get(key) ?? { k: 'idle' }, rows: null });
  lastAttempt.set(key, now());
  const p = runSync(identityKey, get, sessionHandle, now).then((r) => {
    lastState.set(key, r.state);
    inFlight.delete(key);
    return r;
  });
  inFlight.set(key, p);
  return p;
}
