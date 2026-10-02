import { Utils } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { BchatClient, ChatApiError, defaultHttp, saveSession } from '../chat/api';
import { isNative } from '../native';
import { signedInClient, identityKeyOf } from '../kyc/kycWallet';
import { collectPaymailInbox, deletePaymail, lookupPaymail, paymailEnabled } from '../names/paymail';
import type { Fetch } from '../names/names';
import { clearConsents } from '../agent/consent';
import { clearUgcLocal, normHandle } from '../ugc/ugc';

/**
 * Settings › Delete account (Apple 5.1.1(v); Google Play account deletion).
 *
 * Server side, both signed by this account's identity key:
 *   1. the paymail (pay.bwallet.space): inbox collected first, then alias + inbox deleted;
 *   2. bChat / bit-sign: POST /api/bitsign/account/delete with a BRC-3 signature over
 *      accountDeleteMessage (must match bit-sign src/lib/store-safety.ts).
 * Then this account's local data. Removing the account (or the whole wallet) from the device is
 * the caller's last step (DeleteAccountScreen).
 *
 * On-chain data (transactions, tokens, inscriptions, posts) cannot be deleted by anyone.
 */

export const ACCOUNT_DELETE_PROTOCOL: [2, string] = [2, 'bitsign account delete'];
export const ACCOUNT_DELETE_KEY_ID = '1';

export const accountDeleteMessage = (handle: string, identityKey: string, timestamp: string) =>
  `bit-sign delete account\nhandle:${handle}\nidentity_key:${identityKey}\ntimestamp:${timestamp}`;

/** What the user must type to confirm: their $handle, or DELETE. Case and `$` are ignored. */
export const confirmMatches = (typed: string, handle: string | null) => {
  const t = typed.trim();
  if (t === 'DELETE') return true;
  return !!handle && normHandle(t) === normHandle(handle) && normHandle(t) !== '';
};

export type DeleteStep = 'paymail' | 'bchat' | 'local';
export type DeleteResult = {
  paymail: string | null;
  bchatHandle: string | null;
  /** Server-side records kept or needing a person (bit-sign `retained`), for the summary. */
  notes: string[];
};

/** "Choose a bChat handle first" = this wallet never made a bChat account: nothing to delete there. */
const noBchatAccount = (e: unknown) => e instanceof ChatApiError && e.status === 401 && /handle/i.test(e.message);

/** Local keys this module clears for the account (the session, KYC copies, consents, blocks). */
export const localKeysFor = (identityKey: string) => [
  `bwallet.kyc.summary.${identityKey}`,
  `bwallet.kyc.investor.${identityKey}`,
  `bwallet.kyc.audit.${identityKey}`,
];

export const deleteAccount = async (
  ctx: OneSatContext,
  opts: { f?: Fetch; onStep?: (s: DeleteStep) => void } = {},
): Promise<DeleteResult> => {
  const f: Fetch = opts.f ?? ((u, i) => fetch(u, i));
  const identityKey = await identityKeyOf(ctx);
  const notes: string[] = [];

  // 1. Paymail. Collect anything waiting first, so no payment is stranded.
  opts.onStep?.('paymail');
  let paymail: string | null = null;
  if (paymailEnabled()) {
    paymail = (await lookupPaymail(f, identityKey).catch(() => undefined)) ?? null;
    if (paymail) {
      await collectPaymailInbox(f, ctx.wallet, async (txid) =>
        ctx.services ? (await ctx.services.getBeefForTxid(txid)).toBinary() : undefined,
      ).catch(() => undefined);
      await deletePaymail(f, ctx.wallet);
    }
  }

  // 2. bChat / bit-sign.
  opts.onStep?.('bchat');
  let bchatHandle: string | null = null;
  const attempt = async (client: BchatClient) => {
    const handle = normHandle(client.handle ?? '');
    if (!handle) throw new Error('Not signed in to bChat.');
    const timestamp = new Date().toISOString();
    const { signature } = await ctx.wallet.createSignature({
      data: Utils.toArray(accountDeleteMessage(handle, identityKey, timestamp), 'utf8'),
      protocolID: ACCOUNT_DELETE_PROTOCOL,
      keyID: ACCOUNT_DELETE_KEY_ID,
      counterparty: 'anyone',
    });
    const r = await client.deleteAccount({
      identity_key: identityKey,
      timestamp,
      signature: Utils.toHex(signature),
      confirm: 'DELETE',
    });
    bchatHandle = handle;
    if (r.status === 'partial' && r.note) notes.push(r.note);
  };
  try {
    // ⚠ Always a FRESH sign-in with this account's key, never the saved session: on a phone with
    // several accounts the saved session may be another account's, and the server deletes the
    // handle the session names.
    const fresh = new BchatClient(defaultHttp(isNative), null);
    await attempt(await signedInClient(ctx, fresh));
  } catch (e) {
    if (!noBchatAccount(e)) throw e;
  }

  // 3. This account's local data.
  opts.onStep?.('local');
  saveSession(null);
  clearConsents();
  clearUgcLocal();
  for (const k of localKeysFor(identityKey)) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* storage unavailable */
    }
  }
  return { paymail, bchatHandle, notes };
};
