import type { OneSatContext } from '@1sat/actions';
import { sdk as toolboxSdk } from '@bsv/wallet-toolbox-client';
import { isNative } from '../native';
import { BchatClient, ChatApiError, defaultHttp, loadSession, saveSession, type ChatSession } from '../chat/api';
import { getChatAccount } from '../chat/chatAccount';
import { walletSigner } from '../chat/signer';
import {
  findSealAction,
  recoverNativeSeals,
  type ListActionsFn,
  type PendingSealStore,
  type SealApi,
  type SealApiReply,
  type SealLedger,
  type SealTxLookup,
} from '../chat/nativeSeal';
import { localLedger, localStore } from '../chat/sealStore';
import { busyElsewhere, finishStoreFor, heldFor, readHeldSeals } from './held';
import type { Get } from './sync';

/**
 * Signed's link to bit-sign: the wallet's own bChatX session (the same Bearer the seal page and chat use,
 * chat/api.ts loadSession).
 *   - The list and the menu's quiet sync NEVER sign in: with no session they say so.
 *   - Finish never signs in by itself either: with no session, or one bit-sign refuses, it asks for the Sign in tap.
 *   - The Sign in button, and opening a signed document (bureau/session.ts), sign in with the wallet's key when there
 *     is no session; both only ever run on the user's tap.
 */
export const sessionHandle = (): string => loadSession()?.handle ?? '';

/** GET with the current session, or null when there is none (signed out). */
export const sessionGet = (): Get | null => {
  const s = loadSession();
  if (!s) return null;
  const c = new BchatClient(defaultHttp(isNative), s);
  return (path) => c.request('GET', path);
};

/** The explicit "Sign in" tap: the wallet's key signs bChatX's challenge (as the seal page does). */
export const signInToBchat = async (ctx: OneSatContext): Promise<void> => {
  const s = await new BchatClient(defaultHttp(isNative)).signIn(walletSigner(ctx));
  saveSession(s);
};

// ── Finish ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** What Finish did, in words the banner shows (FINISH_TEXT in SignedParts.tsx). */
export type FinishOutcome =
  /** Recorded on bit-sign: it is in Sealed now. */
  | { k: 'recorded' }
  /** Another party sealed the document first; this payment is recorded against the session. */
  | { k: 'orphaned' }
  /** The wallet proved no payment was ever built: released, nothing was paid. */
  | { k: 'released' }
  /** Not settled yet (in progress, a fault, not proven unpaid yet, or handled elsewhere): it stays held. */
  | { k: 'kept' }
  /** bit-sign refused it for good, with its reason. */
  | { k: 'refused'; reason: string }
  /** No session, or bit-sign refused the session: the user taps Sign in, then Finish runs again. */
  | { k: 'sign_in' }
  /** The wallet switched accounts: nothing more is done for this one. */
  | { k: 'account_changed' }
  | { k: 'offline' }
  | { k: 'failed' };

export interface FinishDeps {
  identityKey: string;
  /** The current account's identity address (getChatAccount's key). */
  account: string;
  chatAccount: () => string | null;
  session: () => ChatSession | null;
  clearSession: () => void;
  /** POST a seal route with the CURRENT session only (never signs in). */
  post: SealApi;
  /** An authenticated read to prove the session: its HTTP status (0 = no answer). */
  check: () => Promise<number>;
  store: PendingSealStore;
  ledger: SealLedger;
  lookup?: SealTxLookup;
  recover?: typeof recoverNativeSeals;
  now?: () => number;
}

/** An answer that means "this session isn't the right one" (#560 keeps the record on these; Finish asks to sign in). */
const authRefusal = (r: SealApiReply) =>
  r.status === 401 || r.status === 403 || (r.status === 404 && r.body?.code === 'not_yours');

/**
 * Finish ONE held document for THIS account: the seal flow's own recoverNativeSeals (#560) with this identity key (never
 * `keyless`), over a store view that lists only this identity's records for that document that no other page or
 * window is handling (held.finishStoreFor). Never signs in, never runs for another account, never counts an auth
 * refusal as done, and reports what recovery says it did (its RecoverResult per record). Never throws.
 */
export async function finishHeldWith(documentId: string, d: FinishDeps): Promise<FinishOutcome> {
  const now = d.now ?? Date.now;
  const sameAccount = () => !!d.account && d.chatAccount() === d.account;
  if (!d.identityKey || !sameAccount()) return { k: 'account_changed' };
  const s = d.session();
  if (!s || (s.account && s.account !== d.account)) return { k: 'sign_in' };
  const view = finishStoreFor(d.identityKey, documentId, now(), d.store);
  if (!view.list().length) return { k: 'kept' };
  let status: number;
  try {
    status = await d.check();
  } catch {
    status = 0;
  }
  if (status === 401 || status === 403) {
    d.clearSession();
    return { k: 'sign_in' };
  }
  if (status === 0) return { k: 'offline' };
  if (!sameAccount()) return { k: 'account_changed' };

  const reasons = new Map<string, string>();
  let authFailed = false;
  const api: SealApi = async (path, body) => {
    const r = await d.post(path, body);
    if (authRefusal(r)) authFailed = true;
    const why = r.body?.error ?? r.body?.message;
    if (path === 'recover' && !r.ok && typeof why === 'string' && why) reasons.set(String(body.nonce ?? ''), why);
    return r;
  };
  let results: Awaited<ReturnType<typeof recoverNativeSeals>>;
  try {
    results = await (d.recover ?? recoverNativeSeals)(api, view, documentId, d.ledger, d.lookup, {
      identityKey: d.identityKey,
      now,
    });
  } catch {
    return { k: 'failed' };
  }
  if (!sameAccount()) return { k: 'account_changed' };
  if (authFailed) {
    d.clearSession();
    return { k: 'sign_in' };
  }
  const mine = results.filter((r) => r.documentId === documentId);
  if (mine.some((r) => r.outcome === 'recorded' && !r.orphaned)) return { k: 'recorded' };
  const refused = mine.find((r) => r.outcome === 'refused');
  if (refused)
    return { k: 'refused', reason: (reasons.get(refused.nonce) ?? 'bChatX could not record it.').slice(0, 200) };
  if (mine.some((r) => r.outcome === 'recorded' && r.orphaned)) return { k: 'orphaned' };
  if (mine.some((r) => r.outcome === 'released')) return { k: 'released' };
  return { k: 'kept' };
}

/** The seal routes with the CURRENT session only (as NativeSealPage `api`, minus its silent sign-in). */
const sessionPost: SealApi = async (path, body) => {
  const s = loadSession();
  if (!s) return { ok: false, status: 401, body: { error: 'Not signed in' } };
  const c = new BchatClient(defaultHttp(isNative), s);
  try {
    const data = (await c.request('POST', `/api/bitsign/nds/seal/${path}`, body)) as Record<string, unknown>;
    return { ok: true, status: 200, body: data ?? {} };
  } catch (e) {
    if (e instanceof ChatApiError)
      return { ok: false, status: e.status, body: (e.data as Record<string, unknown>) ?? { error: e.message } };
    throw e;
  }
};

const sessionCheck = async (): Promise<number> => {
  const get = sessionGet();
  if (!get) return 401;
  try {
    await get('/api/bitsign/me/handles');
    return 200;
  } catch (e) {
    return Number((e as { status?: unknown })?.status) || 0;
  }
};

/** An unsure seal's transaction in this wallet's own storage (as NativeSealPage `txLookup`). */
const txLookup = (ctx: OneSatContext): SealTxLookup => ({
  find: (script, sinceMs) =>
    findSealAction(
      (args) => ctx.wallet.listActions(args) as ReturnType<ListActionsFn>,
      script,
      sinceMs,
      toolboxSdk.specOpFailedActions,
    ),
  beef: async (txid) => {
    try {
      const services = ctx.services as unknown as {
        getBeefForTxid?: (t: string) => Promise<{ toBinaryAtomic(t: string): number[] }>;
      };
      return services?.getBeefForTxid ? (await services.getBeefForTxid(txid)).toBinaryAtomic(txid) : null;
    } catch {
      return null;
    }
  },
});

/** Finish, wired to the wallet: the seal flow's own store, ledger and lookup, and the current bChatX session. */
export const finishHeld = (
  ctx: OneSatContext,
  documentId: string,
  identityKey: string,
  account: string,
): Promise<FinishOutcome> =>
  finishHeldWith(documentId, {
    identityKey,
    account,
    chatAccount: getChatAccount,
    session: () => loadSession(),
    clearSession: () => saveSession(null),
    post: sessionPost,
    check: sessionCheck,
    store: localStore(),
    ledger: localLedger(),
    lookup: txLookup(ctx),
  });

/** Held documents of this account that another page or window is handling now (Finish waits for it). */
export const busyHeld = (identityKey: string, now = Date.now(), store: PendingSealStore = localStore()): Set<string> =>
  new Set(
    heldFor(identityKey, readHeldSeals())
      .filter((p) => busyElsewhere(p, store, now))
      .map((p) => p.documentId),
  );
