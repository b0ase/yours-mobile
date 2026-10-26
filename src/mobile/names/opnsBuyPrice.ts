/**
 * A listing's sheet price comes from its MAP metadata, but an OrdLock v2 purchase pays whatever the covenant's
 * payout output says. A seller could show a low price and take a high one, so before every buy the wallet reads
 * the payout from the listing's own locking script and refuses unless it equals the price the user approved.
 * Fails closed: anything that cannot be decoded or checked is refused.
 */
import { LockingScript, P2PKH, Utils } from '@bsv/sdk';
import { OrdLockV2 } from '@1sat/templates';

export type OpnsPayout = { sats: number; script: LockingScript; payee?: string };

/** The payout an OrdLock v2 listing demands (sats + script, and the P2PKH address when it is one), or null. */
export const opnsPayoutOf = (script: LockingScript): OpnsPayout | null => {
  try {
    const d = OrdLockV2.decode(script);
    if (!d) return null;
    const r = new Utils.Reader(d.payout);
    const sats = r.readUInt64LEBn().toNumber();
    const len = r.readVarIntNum();
    const out = LockingScript.fromBinary(r.read(len));
    if (!Number.isSafeInteger(sats) || sats < 0 || BigInt(sats) !== d.price) return null;
    let payee: string | undefined;
    const c = out.chunks;
    if (c.length === 5 && c[2]?.data?.length === 20 && out.toHex() === new P2PKH().lock(c[2].data).toHex())
      payee = Utils.toBase58Check(c[2].data, [0]);
    return { sats, script: out, payee };
  } catch {
    return null;
  }
};

export const PRICE_MISMATCH_MESSAGE =
  "This listing's contract asks for a different price than the one shown, so it wasn't bought. Nothing was spent.";

/**
 * Throws unless the listing's covenant pays exactly `approvedSats` (and no more than the sheet total, counting any
 * marketplace fee) and, when `approvedPayee` is given, pays that address. Returns the decoded payout.
 */
export const assertOpnsPayout = (
  script: LockingScript,
  approvedSats: number,
  opts: { marketFeeSats?: number; approvedTotalSats?: number; approvedPayee?: string } = {},
): OpnsPayout => {
  if (!Number.isSafeInteger(approvedSats) || approvedSats <= 0)
    throw new Error("Couldn't check this listing's price. Try again in a moment.");
  const p = opnsPayoutOf(script);
  if (!p) throw new Error("Couldn't check this listing's contract. Try again in a moment.");
  if (p.sats !== approvedSats) throw new Error(PRICE_MISMATCH_MESSAGE);
  const fee = opts.marketFeeSats ?? 0;
  const total = opts.approvedTotalSats ?? approvedSats;
  if (!Number.isSafeInteger(fee) || fee < 0 || p.sats + fee > total) throw new Error(PRICE_MISMATCH_MESSAGE);
  if (opts.approvedPayee !== undefined && p.payee !== opts.approvedPayee) throw new Error(PRICE_MISMATCH_MESSAGE);
  return p;
};
