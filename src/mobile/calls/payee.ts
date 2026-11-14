/**
 * bPhone: who a metered call pays, bound to the person being called (b-Aware 25 Oct 2026, fzsusanto row 114).
 *
 * The rate card and the paymail come from the bWallet paymail server (bphone-get), which only vouches for them. The
 * meter pays with no sheet in front of each payment, so the payee must be tied to the callee's identity key (the key
 * the call is placed to) before the quote is shown, or the call is not paid at all:
 *  - BSV goes to their paymail, and the request carries their identity key: the paymail host must derive every output
 *    from that key (utils/guardedSendBsv.ts checkedDestination), whatever paymail the server named. The paymail must
 *    be a bWalletX one (isOurDomain): a third-party host could return correctly derived outputs and then throw the
 *    payment away instead of delivering it (review of row 114). Our server only ever names our own paymails.
 *  - MNEE and BSV-21 go to an address the callee's own wallet signed with its identity key when it saved the card
 *    (signPayee, BRC-43 [2,'bwallet paymail'], a protocol no site can use). A card with no signature, or one that
 *    doesn't verify against the callee's key, is refused. A card saved before this signature existed is re-signed by
 *    the callee's wallet the next time it opens bPhone settings (payoutNeedsSigning), with the wallet's own address:
 *    quietly when its price matches the card the owner last saved on this device (planPayoutResign, readOwnerCard),
 *    else only after the owner confirms.
 * The quote sheet shows the payee in full.
 */
import { ProtoWallet, Utils, type WalletInterface } from '@bsv/sdk';
import { isOurDomain } from '../names/names';
import { SIGN_KEY_ID, SIGN_PROTOCOL, signedMessage, signRequest } from '../names/signRequest';
import { readOwnerCard } from './bphone';
import type { PayeeProof, PayTo, RateAsset, RateCard } from './rateCard';

export const PAYEE_ACTION = 'bphone-payee';
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;

/** The signed fields: the asset's kind, its token id ('' for MNEE) and the address. */
const payeeFields = (asset: Exclude<RateAsset, { kind: 'bsv' }>, address: string) => ({
  kind: asset.kind,
  token: asset.kind === 'bsv21' ? asset.id : '',
  address,
});

/** The callee's wallet, on save: sign "MNEE / this token is paid to `address`" with the identity key. */
export const signPayee = async (
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  asset: Exclude<RateAsset, { kind: 'bsv' }>,
  address: string,
): Promise<PayeeProof> => {
  const { timestamp, signature } = await signRequest(wallet, PAYEE_ACTION, payeeFields(asset, address));
  return { timestamp: String(timestamp), signature };
};

/** Does the card's address carry a valid signature by `identityKey`? */
export const checkPayeeProof = async (identityKey: string, asset: RateAsset): Promise<boolean> => {
  if (asset.kind === 'bsv' || !asset.address || !asset.proof || !PUBKEY_RE.test(identityKey)) return false;
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(
        signedMessage(PAYEE_ACTION, {
          ...payeeFields(asset, asset.address),
          identityKey,
          timestamp: asset.proof.timestamp,
        }),
        'utf8',
      ),
      signature: Utils.toArray(asset.proof.signature, 'hex'),
      protocolID: SIGN_PROTOCOL,
      keyID: SIGN_KEY_ID,
      counterparty: identityKey,
    });
    return valid;
  } catch {
    return false;
  }
};

export type BoundPayee = { ok: true; payTo: PayTo } | { ok: false; error: string };

/**
 * Where this call pays, bound to the callee's identity key `peerKey`, or why it can't be paid. `calleePaymail` is the
 * paymail the server named for that key (BSV only). An error reads after the callee's name ("$ann charges for…").
 */
export const bindPayee = async (card: RateCard, calleePaymail: string | null, peerKey: string): Promise<BoundPayee> => {
  const key = peerKey.toLowerCase();
  if (!PUBKEY_RE.test(key)) return { ok: false, error: "can't be paid: we don't have their wallet's key" };
  const asset = card.asset;
  if (asset.kind === 'bsv') {
    if (!calleePaymail) return { ok: false, error: 'charges for calls but has nowhere to be paid yet' };
    const domain = calleePaymail.split('@')[1] ?? '';
    if (!isOurDomain(domain))
      return { ok: false, error: `can't be paid: ${calleePaymail} isn't a bWalletX paymail. Nothing was paid.` };
    return { ok: true, payTo: { paymail: calleePaymail, identityKey: key } };
  }
  if (!asset.address) return { ok: false, error: 'charges for calls but has nowhere to be paid yet' };
  if (!(await checkPayeeProof(key, asset)))
    return {
      ok: false,
      error:
        "their payout address isn't signed by their wallet, so this call can't be paid. They can fix it by saving their bPhone settings again.",
    };
  return { ok: true, payTo: { address: asset.address } };
};

/**
 * The callee's own wallet, opening bPhone settings: does its saved MNEE / token card need (re-)signing? True when the
 * card's address is not `ownAddress` (what this wallet derives for it now; never re-sign an address the server
 * served) or its signature doesn't verify against `identityKey`. A BSV card or no card: false.
 */
export const payoutNeedsSigning = async (
  identityKey: string,
  asset: RateAsset | undefined,
  ownAddress: string | undefined,
): Promise<boolean> =>
  !!asset &&
  asset.kind !== 'bsv' &&
  !!ownAddress &&
  (asset.address !== ownAddress || !(await checkPayeeProof(identityKey, asset)));

/**
 * Is the card the server returned the same price as the card this device last saved (kind, token id, amount, per)?
 * The quiet re-sign only signs a card whose terms the owner already set here; anything else (no local copy, or terms
 * that differ) is shown to the owner first (re-review of row 114: the server copy overwrites the local cache).
 */
export const sameCardTerms = (local: RateCard | null | undefined, served: RateCard | null | undefined): boolean =>
  !!local &&
  !!served &&
  local.per === served.per &&
  local.amount === served.amount &&
  local.asset.kind === served.asset.kind &&
  (local.asset.kind !== 'bsv21' || (served.asset.kind === 'bsv21' && local.asset.id === served.asset.id));

/**
 * What bPhone settings do on open with my served profile `served` and my own payout address `own`: nothing (no
 * MNEE / token card, or it is already signed for `own`), sign quietly (the served card's terms are the card I last
 * saved on this device, readOwnerCard), or ask me first (anything else, including no saved card here). Re-review of
 * b-Aware row 114.
 */
export const planPayoutResign = async (
  identityKey: string,
  served: RateCard | null,
  own: string | undefined,
): Promise<'none' | 'quiet' | 'ask'> => {
  if (!served || served.asset.kind === 'bsv') return 'none';
  if (!(await payoutNeedsSigning(identityKey.toLowerCase(), served.asset, own))) return 'none';
  return sameCardTerms(readOwnerCard(identityKey)?.rate, served) ? 'quiet' : 'ask';
};

/** The payee line on the quote sheet. */
export const payeeLabel = (payTo: PayTo): string =>
  'paymail' in payTo
    ? `Paid to ${payTo.paymail}, checked against their wallet's key`
    : `Paid to ${payTo.address}, signed by their wallet`;
