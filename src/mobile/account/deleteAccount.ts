import { PublicKey, Utils } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { BchatClient, ChatApiError, defaultHttp, saveSession } from '../chat/api';
import { isNative } from '../native';
import { signedInClient, identityKeyOf } from '../kyc/kycWallet';
import { collectPaymailInbox, deletePaymail, lookupPaymail, paymailEnabled } from '../names/paymail';
import type { Fetch } from '../names/names';
import { clearConsents } from '../agent/consent';
import { clearUgcLocal, normHandle } from '../ugc/ugc';
import { clearHelpDeskUnpin } from '../chat/helpDeskPin';
import { bsvLockScanKeys } from '../locks/lockFinder';
import { settleWithin, within } from '../../utils/settleWithin';
import { CLOSE_FOR_RELOAD_CAP_MS } from './closeForReload';

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

/** The account's identity address (what the lock-scan flags are keyed by), or '' for a malformed key. */
const addressOf = (identityKey: string) => {
  try {
    return PublicKey.fromString(identityKey).toAddress();
  } catch {
    return '';
  }
};

/**
 * Local keys this module clears for the account (the session, KYC copies, consents, blocks), and the lock-scan flags:
 * importing the same 12 words again must scan for its locks again (review 21 L3).
 */
export const localKeysFor = (identityKey: string) => {
  const address = addressOf(identityKey);
  return [
    `bwallet.kyc.summary.${identityKey}`,
    `bwallet.kyc.investor.${identityKey}`,
    `bwallet.kyc.audit.${identityKey}`,
    ...(address ? [...bsvLockScanKeys(address), `bwx.tokenLocks.scanned.${address}`] : []),
  ];
};

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
  clearHelpDeskUnpin();
  for (const k of localKeysFor(identityKey)) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* storage unavailable */
    }
  }
  return { paymail, bchatHandle, notes };
};

/** Longest each step of "Remove it from this phone" may take before the screen shows an error and Try again. */
export const REMOVE_STEP_CAP_MS = 15_000;

/**
 * Which account Delete account removes, and the one the phone switches to: pinned once, when the server-side delete
 * succeeds, and never re-derived from the selection (key-wipe review of 04f9513b, H1: after the switch to B, a Try
 * again that re-read "current" would have switched back to A and forgotten B, or wiped the whole wallet).
 */
export type RemoveTarget = { deleted?: string; next?: string };

/** Identity addresses of the real accounts in a fresh read of storage.local `accounts` (isRealAccount's test). */
const realAccounts = (accounts: Record<string, unknown>) =>
  Object.entries(accounts)
    .filter(([, a]) => !!(a as { addresses?: { identityAddress?: string } } | null)?.addresses?.identityAddress)
    .map(([id]) => id);

/**
 * The last step of Delete account: take the pinned account off the phone, or the whole wallet when a fresh read shows
 * no other real account, then start again from the reload. Safe to run again (Try again): each step checks storage
 * first. Switch and forget are capped; the wipe has no outer cap, since its own steps are capped (forgot/wipe.ts
 * WIPE_CAPS) and an outer one shorter than their sum would abandon a slow wipe that a Try again then runs twice (M2).
 * Every failure is thrown, so the button ends in the reload or an error with Try again (5.2.61 build 155: it did
 * nothing).
 */
export const removeFromDevice = async (d: {
  target: RemoveTarget;
  /** A fresh read of storage.local `accounts` (not the page's cached copy). */
  readAccounts: () => Promise<Record<string, unknown>>;
  /** Select `address` for the reload. */
  select: (address: string) => Promise<void>;
  /** Close the wallet in this page, so no background writer saves the account back after it is forgotten (M1). */
  closeWallet?: () => unknown;
  /** Remove the account (its encrypted keys) from storage. */
  forget: (address: string) => Promise<void>;
  /** Best effort: the account's local caches. */
  dropCaches?: (address: string) => void;
  /** The whole wallet off this device (forgot/wipe.ts); throws if any key may remain. */
  wipeWallet: () => Promise<void>;
  /** Close the wallet and reload (the welcome screen, or the other account). */
  reload: () => unknown;
  capMs?: number;
}) => {
  const cap = d.capMs ?? REMOVE_STEP_CAP_MS;
  const { deleted } = d.target;
  const read = () => within(d.readAccounts, cap, 'Reading the accounts on this phone');
  const accounts = await read();
  const others = realAccounts(accounts).filter((id) => id !== deleted);
  if (others.length === 0) {
    await d.wipeWallet();
    return void (await d.reload());
  }
  if (!deleted) throw new Error("Couldn't tell which account to remove, so nothing was removed.");
  const next = d.target.next && others.includes(d.target.next) ? d.target.next : others[0];
  await within(() => d.select(next), cap, 'Switching to your other account');
  if (deleted in accounts) {
    if (d.closeWallet) await settleWithin(d.closeWallet, CLOSE_FOR_RELOAD_CAP_MS);
    await within(() => d.forget(deleted), cap, 'Removing this account');
    if (deleted in (await read())) throw new Error('This account is still on this phone.');
  }
  try {
    d.dropCaches?.(deleted);
  } catch {
    /* best effort */
  }
  await d.reload();
};
