/**
 * The native Chat's bChatX session for the ACTIVE wallet account, obtained silently (owner, 3 Nov 2026).
 *
 * The wallet signs bit-sign's own login challenge with its key (chat/signer.ts), on unlock and on account switch
 * (ChatSessionWarmer), and again on its own when the server drops the session. It is the wallet's first-party
 * service: the in-app wallet calls run as the wallet itself (ADMIN_ORIGINATOR, initWallet.ts), so there is no
 * approval sheet, and no other site's signing rules change. Chat and DMs read the state (useChatSession) and never
 * show a "sign in" step: a skeleton while it is fetched, one line + Retry on failure, and "Choose your handle" only
 * for a wallet that has no name yet. One sign-in at a time per account; a result for an account that is no longer
 * active is dropped, never stored under the new one.
 */
import { useSyncExternalStore } from 'react';
import type { OneSatContext } from '@1sat/actions';
import { ChatApiError, loadSession, parseHandlesInfo, saveSession, SESSION_EVENT, type BchatClient } from './api';
import { getChatAccount, onChatAccountChange } from './chatAccount';
import { sharedChatClient } from './sharedRooms';
import { walletSigner } from './signer';
import { afterAuthLost, shouldSignIn, stateFromError, type ChatSessionState } from './sessionRules';
import { handlesStale, loadServerHandles, saveServerHandles } from './signInNames';
import { loadBchatPref, saveBchatPref } from '../wallet/bchatFollow';
import { logInWalletApp } from '../wallet/connectionLog';

export type { ChatSessionState } from './sessionRules';

const IDLE: ChatSessionState = { kind: 'idle' };
const OFF: ChatSessionState = { kind: 'off' };
const PENDING: ChatSessionState = { kind: 'pending' };

const states = new Map<string, ChatSessionState>();
const subs = new Set<() => void>();
let inflight: { account: string; p: Promise<void> } | null = null;

const emit = () => subs.forEach((f) => f());
const set = (account: string, s: ChatSessionState) => {
  if (states.get(account) === s) return;
  states.set(account, s);
  emit();
};

const isOff = (account: string) => loadBchatPref(account).mode === 'off';

/** The active account's state. Stable between changes (useSyncExternalStore). */
export const chatSessionState = (): ChatSessionState => {
  const account = getChatAccount();
  if (!account) return IDLE;
  const known = states.get(account);
  if (known) return known;
  // First look: a session saved earlier (this run or a previous one) is ready at once.
  const client = sharedChatClient();
  if (!client.handle) client.adopt(loadSession());
  const s: ChatSessionState = isOff(account)
    ? OFF
    : client.handle
      ? { kind: 'ready', handle: client.handle, at: 0 }
      : IDLE;
  states.set(account, s);
  return s;
};

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

/** Chat / DMs: the session state, re-rendered on every change and account switch. */
export const useChatSession = () => useSyncExternalStore(subscribe, chatSessionState, chatSessionState);

/** Keep this account's names and which are active (signInNames.ts); quiet, best-effort. */
const refreshServerHandles = async (client: BchatClient, account: string, force = false) => {
  if (!force && !handlesStale(loadServerHandles(account))) return;
  try {
    const info = await client.listHandles().catch((e) => {
      // 503 "extra names are not switched on" still lists the names.
      if (e instanceof ChatApiError && e.data && typeof e.data === 'object' && 'handles' in e.data)
        return parseHandlesInfo(e.data as { handles?: unknown });
      throw e;
    });
    if (getChatAccount() === account) saveServerHandles(account, info.handles);
  } catch {
    /* the next session tries again */
  }
};

const ready = (account: string, client: BchatClient, handle: string) => {
  set(account, { kind: 'ready', handle, at: Date.now() });
  logInWalletApp('bitcoinchat.online', 'signIn');
  void refreshServerHandles(client, account, true);
};

/**
 * Make sure the active account has a session: adopts a saved one, else signs in silently. Coalesced; never throws.
 * `force` is the Retry button (and Chat's "Turn on").
 */
export const ensureChatSession = (
  ctx: OneSatContext | undefined,
  opts: { force?: boolean; recheckHandle?: boolean } = {},
): Promise<void> => {
  const account = getChatAccount();
  if (!account || !ctx?.wallet) return Promise.resolve();
  if (isOff(account)) {
    set(account, OFF);
    return Promise.resolve();
  }
  const client = sharedChatClient();
  if (!client.handle) client.adopt(loadSession());
  const now = chatSessionState();
  if (client.handle) {
    if (now.kind !== 'ready' || now.handle !== client.handle)
      set(account, { kind: 'ready', handle: client.handle, at: 0 });
    void refreshServerHandles(client, account);
    return Promise.resolve();
  }
  if (inflight?.account === account) return inflight.p;
  if (!shouldSignIn(now.kind === 'ready' || now.kind === 'off' ? IDLE : now, { ...opts, now: Date.now() }))
    return Promise.resolve();
  set(account, PENDING);
  const p = client
    .signIn(walletSigner(ctx))
    .then(
      (s) => {
        // Switched account while signing: this session is the old account's; never keep it for the new one.
        if (getChatAccount() !== account) return void client.signOut();
        ready(account, client, s.handle);
        saveSession(s);
      },
      (e) => {
        if (getChatAccount() !== account) return void states.delete(account);
        set(account, stateFromError(e, Date.now()));
      },
    )
    .finally(() => {
      if (inflight?.p === p) inflight = null;
    });
  inflight = { account, p };
  return p;
};

/**
 * "Choose your handle" finished (a wallet bChatX hadn't seen): make the account under that name with bit-sign's
 * claim token, or sign in again (which now finds the name) if the token expired. Throws for HandleFlow to show.
 */
export const finishHandleClaim = async (ctx: OneSatContext, paymail: string) => {
  const account = getChatAccount();
  const s = chatSessionState();
  if (!account || s.kind !== 'needs-handle') return;
  const client = sharedChatClient();
  const name = paymail.split('@')[0];
  try {
    const sess = await client.claimHandle(s.claimToken, name, s.address).catch(() => client.signIn(walletSigner(ctx)));
    if (getChatAccount() !== account) return void client.signOut();
    ready(account, client, sess.handle);
    saveSession(sess);
  } catch (e) {
    const next = stateFromError(e, Date.now());
    set(account, next.kind === 'needs-handle' ? next : s);
    throw e;
  }
};

/** The server refused the session (401): drop it and sign in again quietly (sessionRules.afterAuthLost). */
export const noteChatAuthLost = (ctx?: OneSatContext) => {
  const account = getChatAccount();
  if (!account) return;
  const client = sharedChatClient();
  const next = afterAuthLost(chatSessionState(), Date.now());
  client.signOut();
  set(account, next);
  saveSession(null);
  if (ctx && next.kind === 'idle') void ensureChatSession(ctx);
};

/** Chat's one line for an account with bChatX turned off: turn it back on (Settings › bChatX has the same). */
export const turnChatOn = (ctx: OneSatContext | undefined) => {
  const account = getChatAccount();
  if (!account) return Promise.resolve();
  saveBchatPref(account, { mode: 'account' });
  set(account, IDLE);
  return ensureChatSession(ctx, { force: true });
};

// A session saved or cleared elsewhere (the Wallet card's follow, Settings › bChatX, Delete account) moves the state.
if (typeof window !== 'undefined') {
  window.addEventListener(SESSION_EVENT, () => {
    const account = getChatAccount();
    if (!account) return;
    const saved = loadSession();
    const client = sharedChatClient();
    const s = chatSessionState();
    if (saved) {
      if (client.handle !== saved.handle || client.current?.token !== saved.token) client.adopt(saved);
      if (s.kind !== 'ready' || s.handle !== saved.handle)
        set(account, { kind: 'ready', handle: saved.handle, at: s.kind === 'ready' ? s.at : 0 });
    } else if (s.kind === 'ready') {
      client.signOut();
      set(account, isOff(account) ? OFF : IDLE);
    }
  });
  onChatAccountChange(() => emit());
}
