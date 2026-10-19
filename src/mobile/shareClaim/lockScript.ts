import { BSV21, Cosign } from '@1sat/templates';
import { LockingScript, PublicKey, type Script } from '@bsv/sdk';

/**
 * The share lock: a BSV-21 transfer inscription on top of a 1Sat Cosign script.
 *
 *   OP_FALSE OP_IF "ord" OP_1 "application/bsv-20" OP_0 {"p":"bsv-20","op":"transfer","id":…,"amt":"N"} OP_ENDIF
 *   OP_DUP OP_HASH160 <hash160(holder lockPubKey)> OP_EQUALVERIFY OP_CHECKSIGVERIFY <companyPubKey> OP_CHECKSIG
 *
 * Why Cosign rather than bare OP_2 … OP_CHECKMULTISIG: it is the 2-of-2 that 1Sat indexers already understand
 * (MNEE uses it), so the BSV-21 balance is credited to the holder's lock address instead of an unowned script.
 * Spending needs BOTH signatures: <companySig> <holderSig> <holderPubKey>.
 */
export type ShareLock = { tokenId: string; amount: number; holderPubKey: string; companyPubKey: string };

const hex = (k: string) => PublicKey.fromString(k).toString();

export function buildShareLock(p: ShareLock): LockingScript {
  if (!Number.isSafeInteger(p.amount) || p.amount <= 0) throw new Error('amount must be a positive whole number');
  const holder = hex(p.holderPubKey);
  const company = hex(p.companyPubKey);
  if (holder === company) throw new Error('holder and company keys must differ');
  const cosign = Cosign.lock(PublicKey.fromString(holder).toAddress(), company);
  return BSV21.transfer(p.tokenId, BigInt(p.amount)).lock(cosign);
}

export type DecodedShareLock = { tokenId: string; amount: number; holderAddress: string; companyPubKey: string };

export function decodeShareLock(script: Script): DecodedShareLock | null {
  const t = BSV21.decode(script);
  if (!t || !t.isTransfer()) return null;
  const c = Cosign.decode(script);
  if (!c) return null;
  const id = t.getTokenId();
  const amt = t.getAmount();
  if (!id || amt > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { tokenId: id, amount: Number(amt), holderAddress: c.address, companyPubKey: c.cosigner.toLowerCase() };
}

/** True when `script` is exactly the lock we expect (byte equality, then a decode cross-check). */
export function matchesShareLock(script: Script, p: ShareLock): boolean {
  if (script.toHex() !== buildShareLock(p).toHex()) return false;
  const d = decodeShareLock(script);
  return (
    !!d &&
    d.tokenId === p.tokenId &&
    d.amount === p.amount &&
    d.holderAddress === PublicKey.fromString(p.holderPubKey).toAddress() &&
    d.companyPubKey === hex(p.companyPubKey)
  );
}
