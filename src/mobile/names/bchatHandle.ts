import { Utils, type WalletInterface } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { loadSession, saveSession } from '../chat/api';
import { kycClient, signedInClient } from '../kyc/kycWallet';

/**
 * One identity: the bChat (bit-sign) handle follows the wallet's paymail name.
 *
 * bWallet signs in to bit-sign silently, which gives the account a provisional `yours-<prefix>`
 * handle. Once the wallet owns `alias@bwallet.space`, this proves it to bit-sign (a signature by
 * the identity key — the same key the paymail server publishes — over a message bound to the
 * current handle) and bit-sign renames the account, its rooms and its messages to `alias`.
 *
 * Must match bit-sign src/lib/paymail-handle.ts.
 */
export const CLAIM_PROTOCOL: [2, string] = [2, 'bitsign handle claim'];
export const CLAIM_KEY_ID = '1';

export const claimMessage = (currentHandle: string, paymail: string, timestamp: number | string) =>
  [
    'bit-sign',
    'claim-paymail-handle',
    'v1',
    `handle=${currentHandle.replace(/^\$/, '').toLowerCase()}`,
    `paymail=${paymail.toLowerCase()}`,
    `timestamp=${timestamp}`,
  ].join('|');

export const isProvisionalHandle = (h: string | null | undefined) =>
  !!h && h.replace(/^\$/, '').toLowerCase().startsWith('yours-');

/** Does this bChat handle still need to become the paymail's alias? Pure. */
export const needsPaymailHandle = (handle: string | null | undefined, paymail: string | null | undefined) => {
  const alias = (paymail ?? '').split('@')[0]?.toLowerCase();
  return !!alias && isProvisionalHandle(handle) && handle!.replace(/^\$/, '').toLowerCase() !== alias;
};

export const signHandleClaim = async (
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  currentHandle: string,
  paymail: string,
  now = Date.now(),
) => {
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(claimMessage(currentHandle, paymail, now), 'utf8'),
    protocolID: CLAIM_PROTOCOL,
    keyID: CLAIM_KEY_ID,
    counterparty: 'anyone',
  });
  return { paymail: paymail.toLowerCase(), identity_key: publicKey, timestamp: now, signature: Utils.toHex(signature) };
};

const inflight = new Map<string, Promise<string | null>>();

/** A refusal (name taken / a HandCash handle / reserved) is not retried on every sync. */
const REFUSED_KEY = (paymail: string) => `bwallet.bchatHandle.refused.${paymail}`;
const REFUSAL_TTL_MS = 24 * 60 * 60_000;
const refusedRecently = (paymail: string) => {
  try {
    return Date.now() - Number(localStorage.getItem(REFUSED_KEY(paymail)) || 0) < REFUSAL_TTL_MS;
  } catch {
    return false;
  }
};
const noteRefusal = (paymail: string) => {
  try {
    localStorage.setItem(REFUSED_KEY(paymail), String(Date.now()));
  } catch {
    /* storage unavailable */
  }
};

/**
 * Make the bChat handle the paymail alias, if it is still a `yours-*` default.
 * `signIn: false` (startup) never signs in just for this — it only fixes an existing session.
 * Returns the resulting handle, or null when nothing was done. Never throws.
 */
export const syncBchatHandle = (
  ctx: OneSatContext,
  paymail: string | null | undefined,
  opts: { signIn?: boolean } = {},
): Promise<string | null> => {
  if (!paymail) return Promise.resolve(null);
  const stored = loadSession();
  if (stored && !needsPaymailHandle(stored.handle, paymail)) return Promise.resolve(null);
  if (!stored && !opts.signIn) return Promise.resolve(null);
  const key = paymail.toLowerCase();
  if (!opts.signIn && refusedRecently(key)) return Promise.resolve(null);
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const client = await signedInClient(ctx, kycClient());
      const handle = client.handle;
      if (!handle || !needsPaymailHandle(handle, paymail)) return null;
      const s = await client.claimPaymailHandle(await signHandleClaim(ctx.wallet, handle, paymail));
      saveSession(s);
      return s.handle;
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      if (status && status >= 400 && status < 500 && status !== 401) noteRefusal(key);
      console.warn('[bchatHandle] could not update bChat handle:', e instanceof Error ? e.message : e);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
};
