import { useEffect } from 'react';
import type { OneSatContext } from '@1sat/actions';
import { useServiceContext } from '../../hooks/useServiceContext';
import { loadSession, saveSession } from '../chat/api';
import { kycClient, signedInClient } from '../kyc/kycWallet';
import { syncBchatHandle } from '../names/bchatHandle';
import {
  aliasOf,
  decideFollow,
  followDue,
  loadBchatPref,
  loadFollowStatus,
  saveFollowStatus,
  type FollowStatus,
} from './bchatFollow';

/**
 * Carry out the follow decision for the active account (bchatFollow.ts). Quiet by design: success and
 * failure land in the per-account status that Settings › bChatX shows, never on the wallet card.
 * `force` skips the retry wait (Settings' "Try again").
 */
export const followBchat = async (
  ctx: OneSatContext,
  account: string,
  paymail: string | null | undefined,
  chat: { handle: string | null; mismatch: boolean },
  force = false,
): Promise<FollowStatus | null> => {
  const pref = loadBchatPref(account);
  const action = decideFollow({ pref, sessionHandle: chat.handle, alias: aliasOf(paymail), mismatch: chat.mismatch });
  if (action === 'none') return null;
  if (action === 'clear') {
    saveSession(null);
    return null;
  }
  if (!force && !followDue(loadFollowStatus(account))) return null;
  // Someone else's session (or none): drop it so the sign-in below is this account's own.
  if (action === 'signin') saveSession(null);
  let status: FollowStatus;
  try {
    if (pref.mode === 'account' && paymail) await syncBchatHandle(ctx, paymail, { signIn: true });
    if (!loadSession()) await signedInClient(ctx, kycClient());
    const s = loadSession();
    const alias = aliasOf(paymail);
    if (!s) status = { at: Date.now(), ok: false, error: 'Not signed in' };
    else if (pref.mode === 'account' && alias && aliasOf(s.handle) !== alias)
      // Signed in, but bChatX kept another name: say so in Settings only.
      status = { at: Date.now(), ok: false, handle: s.handle, error: `bChatX kept the name @${s.handle}` };
    else status = { at: Date.now(), ok: true, handle: s.handle };
  } catch (e) {
    status = { at: Date.now(), ok: false, error: e instanceof Error ? e.message : 'Could not sign in to bChatX' };
  }
  saveFollowStatus(account, status);
  return status;
};

/** Mounted with the wallet card: re-runs when the account, its session or its paymail changes. */
export const useBchatFollow = (
  account: string | undefined,
  chat: { handle: string | null; mismatch: boolean },
  paymail: string | null | undefined,
) => {
  const { apiContext } = useServiceContext();
  useEffect(() => {
    if (!account || !apiContext?.wallet) return;
    void followBchat(apiContext, account, paymail, chat).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chat is read by value through these two fields
  }, [account, apiContext, chat.handle, chat.mismatch, paymail]);
};
