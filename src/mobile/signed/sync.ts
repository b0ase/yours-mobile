import { accountHandles } from '../chat/nativeSeal';
import { classifyServerRows, type ServerRow, type SignedRow } from './signedList';
import { loadCachedSync, saveCachedSync } from './localStore';

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

/**
 * One sync: fetch, cache for offline, return the state. Never throws. `get` null = no session (signed out).
 */
export async function syncSigned(
  identityKey: string,
  get: Get | null,
  sessionHandle: string,
  now = Date.now,
): Promise<{ state: SyncState; rows: SignedRow[] | null }> {
  if (!get) return { state: { k: 'signed_out' }, rows: null };
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

/** How often the menu's quiet sync may run (the page itself syncs on every open). */
export const QUIET_SYNC_MS = 5 * 60_000;

/** The menu badge's background sync: only with a session, only when the last one is older than QUIET_SYNC_MS. */
export const quietSyncDue = (identityKey: string, hasSession: boolean, now = Date.now()): boolean => {
  if (!identityKey || !hasSession) return false;
  const last = loadCachedSync(identityKey)?.at ?? 0;
  return now - last >= QUIET_SYNC_MS;
};
