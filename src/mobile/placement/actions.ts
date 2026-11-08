// bShares wallet actions, all through the BRC-100 wallet (keys never leave it; nothing custodial).
// Nothing here runs without the person tapping a button and approving in the wallet. Tests never broadcast.
import type { OneSatContext } from '@1sat/actions';
import { Transaction, Utils } from '@bsv/sdk';
import { SHARE_LOCK_PROTOCOL, shareLockKeyId, type Company, type PlacementOffer } from './placement';
import type { PlacementQuote } from './api';
import { shareTokenScript, type ShareCertificate } from './token';

/** The wallet label on every bShares action (payments are found again by it: payFlow.findPaidAction). */
export const BSHARES_LABEL = 'bshares';

/** The seed-derived key this wallet uses for one tranche's share lock (investor or director side). */
export async function shareLockKey(ctx: OneSatContext, offerId: string): Promise<string> {
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: SHARE_LOCK_PROTOCOL,
    keyID: shareLockKeyId(offerId),
    counterparty: 'self',
  });
  return publicKey;
}

/** Every bShares payment memo starts with this (bit-sign lib/bshares-invest-rules investMemoFor). */
export const BSHARES_MEMO_PREFIX = 'bitsign-bshares ';

/**
 * The memo's OP_RETURN script exactly as bit-sign builds it (memoScriptHex): OP_FALSE OP_RETURN, one direct push of
 * the memo's UTF-8 bytes (at most 75, so the push is a single length byte). null when the memo can't be pushed so.
 */
export function bsharesMemoScript(memo: string): string | null {
  const bytes = new TextEncoder().encode(memo);
  if (bytes.length < 1 || bytes.length > 75) return null;
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `006a${bytes.length.toString(16).padStart(2, '0')}${hex}`;
}

/** Checks a bit-sign quote pays exactly this offer's treasury amount and carries exactly its own data-only memo. */
export function checkQuote(company: Company, offer: PlacementOffer, q: PlacementQuote): string | null {
  if (!company.treasury) return 'The treasury multisig is not set up yet';
  if (q.outputs.length !== 1) return 'The quote must have exactly one treasury output';
  const [o] = q.outputs;
  if (o.lockingScript.toLowerCase() !== company.treasury.lockingScriptHex.toLowerCase())
    return 'The quote does not pay the company treasury';
  if (o.satoshis !== offer.sats) return 'The quote amount does not match the offer';
  if (typeof q.memo !== 'string' || !q.memo.startsWith(BSHARES_MEMO_PREFIX))
    return 'The quote memo is not a bShares memo';
  const want = bsharesMemoScript(q.memo);
  if (!want || typeof q.memo_script !== 'string' || q.memo_script.toLowerCase() !== want)
    return 'The quote memo script does not match its memo';
  return null;
}

/** Why this quote can't be paid now, or null. The page offers Pay only on an accepted offer (placement.nextStep). */
export function payableProblem(company: Company, offer: PlacementOffer, q: PlacementQuote): string | null {
  if (offer.status !== 'accepted') return 'Accept the offer first';
  return checkQuote(company, offer, q);
}

/** The claim route takes a raw tx or BEEF as hex (bit-sign paid-speak claimTx caps it at 2,000,000 characters). */
const RAWTX_MAX_HEX = 2_000_000;

/** BEEF hex for the claim, or the bare raw tx when the BEEF is too big; undefined when neither fits or can be read. */
export function claimRawtx(atomic: number[] | Uint8Array | undefined): string | undefined {
  if (!atomic?.length) return undefined;
  const tx = Array.from(atomic);
  const beef = Utils.toHex(tx);
  if (beef.length <= RAWTX_MAX_HEX) return beef;
  try {
    const raw = Transaction.fromAtomicBEEF(tx).toHex();
    return raw.length <= RAWTX_MAX_HEX ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Investor pays the tranche to the treasury multisig script with the quote's OP_RETURN memo, which is
 * what binds this payment to this investor's claim (bit-sign offers/[id]/claim). Broadcast now, never queued
 * (acceptDelayedBroadcast: false, as offer/accept.ts and locks/lockApi.ts): a rejection throws instead of handing back
 * a txid no node has. Returns the txid and the signed transaction (BEEF hex) so the claim can carry it.
 */
export async function payTreasury(
  ctx: OneSatContext,
  company: Company,
  offer: PlacementOffer,
  q: PlacementQuote,
): Promise<{ txid: string; rawtx?: string }> {
  const bad = payableProblem(company, offer, q);
  if (bad) throw new Error(bad);
  const r = await ctx.wallet.createAction({
    description: `bShares: ${offer.shares} ${company.ticker} shares`,
    outputs: [
      {
        lockingScript: q.outputs[0].lockingScript,
        satoshis: q.outputs[0].satoshis,
        outputDescription: `${company.name} treasury ${company.treasury!.m}-of-${company.treasury!.n}`,
      },
      { lockingScript: q.memo_script, satoshis: 0, outputDescription: 'bShares payment memo' },
    ],
    labels: [BSHARES_LABEL],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  });
  if (!r.txid) throw new Error('The wallet did not return a transaction');
  return { txid: r.txid.toLowerCase(), rawtx: claimRawtx(r.tx) };
}

/** Director issues the locked $403 token for exactly the allotted shares into the investor's control. */
export async function issueShareToken(
  ctx: OneSatContext,
  offer: PlacementOffer,
  cert: ShareCertificate,
): Promise<{ outpoint: string; lockingScriptHex: string }> {
  if (offer.status !== 'approved') throw new Error('Approve the allotment first');
  if (!offer.investorPubKey || !offer.directorPubKey || !offer.unlockHeight)
    throw new Error('The offer is missing its lock keys');
  if (cert.shares !== offer.shares) throw new Error('Token must carry exactly the allotted shares');
  const script = shareTokenScript(cert, {
    directorPubKey: offer.directorPubKey,
    investorPubKey: offer.investorPubKey,
    unlockHeight: offer.unlockHeight,
  });
  const lockingScriptHex = script.toHex();
  const r = await ctx.wallet.createAction({
    description: `bShares: issue ${offer.shares} ${offer.ticker} shares to ${offer.investorHandle}`,
    outputs: [{ lockingScript: lockingScriptHex, satoshis: 1, outputDescription: '$403 share token (locked 2-of-2)' }],
    labels: [BSHARES_LABEL],
    options: { randomizeOutputs: false },
  });
  if (!r.txid) throw new Error('The wallet did not return a transaction');
  return { outpoint: `${r.txid}.0`, lockingScriptHex };
}
