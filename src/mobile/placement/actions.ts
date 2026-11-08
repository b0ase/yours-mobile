// bShares wallet actions, all through the BRC-100 wallet (keys never leave it; nothing custodial).
// Nothing here runs without the person tapping a button and approving in the wallet. Tests never broadcast.
import type { OneSatContext } from '@1sat/actions';
import { SHARE_LOCK_PROTOCOL, shareLockKeyId, type Company, type PlacementOffer } from './placement';
import type { PlacementQuote } from './api';
import { shareTokenScript, type ShareCertificate } from './token';

/** The seed-derived key this wallet uses for one tranche's share lock (investor or director side). */
export async function shareLockKey(ctx: OneSatContext, offerId: string): Promise<string> {
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: SHARE_LOCK_PROTOCOL,
    keyID: shareLockKeyId(offerId),
    counterparty: 'self',
  });
  return publicKey;
}

/** Checks a bit-sign quote pays exactly this offer's treasury amount and carries a data-only memo. */
export function checkQuote(company: Company, offer: PlacementOffer, q: PlacementQuote): string | null {
  if (!company.treasury) return 'The treasury multisig is not set up yet';
  if (q.outputs.length !== 1) return 'The quote must have exactly one treasury output';
  const [o] = q.outputs;
  if (o.lockingScript.toLowerCase() !== company.treasury.lockingScriptHex.toLowerCase())
    return 'The quote does not pay the company treasury';
  if (o.satoshis !== offer.sats) return 'The quote amount does not match the offer';
  const m = q.memo_script.toLowerCase();
  if (!(m.startsWith('006a') || m.startsWith('6a'))) return 'The quote memo is not a data output';
  return null;
}

/**
 * Investor pays the tranche to the treasury multisig script with the quote's OP_RETURN memo, which is
 * what binds this payment to this investor's claim (bit-sign offers/[id]/claim). Returns the txid.
 */
export async function payTreasury(
  ctx: OneSatContext,
  company: Company,
  offer: PlacementOffer,
  q: PlacementQuote,
): Promise<string> {
  if (offer.status !== 'accepted' && offer.status !== 'offered') throw new Error('Accept the offer first');
  const bad = checkQuote(company, offer, q);
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
    labels: ['bshares'],
    options: { randomizeOutputs: false },
  });
  if (!r.txid) throw new Error('The wallet did not return a transaction');
  return r.txid;
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
    labels: ['bshares'],
    options: { randomizeOutputs: false },
  });
  if (!r.txid) throw new Error('The wallet did not return a transaction');
  return { outpoint: `${r.txid}.0`, lockingScriptHex };
}
