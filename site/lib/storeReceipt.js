// Store receipts (owner 17 Oct 2026: "we promised receipts"). The quote for a Store purchase carries a receipt the
// Store signs; the buyer's wallet inscribes it as a 1-sat SVG card in the SAME transaction that pays, so the receipt
// and the payment can be checked together (src/mobile/storeReceipt/receipt.ts verifies both).
//
// Signature: ECDSA (secp256k1, low-S, DER hex) over sha256 of the receipt's canonical JSON (keys sorted, no `sig`).
// Key: STORE_RECEIPT_WIF (Vercel env only; never in git). Without it receipts are still issued, unsigned, and the
// wallet shows them as "not signed". The public key is published by the buy-quote route as `signer` and by
// GET /api/theme-orders?store-key.
'use strict';
const { PrivateKey, PublicKey, Signature, Utils } = require('@bsv/sdk');

/** JSON with object keys sorted at every level: the exact bytes that get signed. */
const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .filter((k) => v[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v);

const signerKey = (env = process.env) => {
  const wif = String(env.STORE_RECEIPT_WIF || '').trim();
  if (!wif) return null;
  try {
    return PrivateKey.fromWif(wif);
  } catch {
    return null;
  }
};

/** The Store's public key (hex), or null when receipts are not being signed. */
const storeKey = (env = process.env) => signerKey(env)?.toPublicKey().toString() ?? null;

/** Sign a receipt: adds `signer` and `sig`. Returns it unchanged (unsigned) when no key is configured. */
function signReceipt(fields, env = process.env) {
  const key = signerKey(env);
  if (!key) return { ...fields };
  const body = { ...fields, signer: key.toPublicKey().toString() };
  const sig = key.sign(Utils.toArray(canonical(body), 'utf8')).toDER('hex');
  return { ...body, sig };
}

/** True when `sig` is a valid signature by `signer` over the rest of the receipt. */
function verifyReceipt(r) {
  if (!r || typeof r.sig !== 'string' || typeof r.signer !== 'string') return false;
  try {
    const { sig, ...body } = r;
    return PublicKey.fromString(r.signer).verify(Utils.toArray(canonical(body), 'utf8'), Signature.fromDER(sig, 'hex'));
  } catch {
    return false;
  }
}

module.exports = { canonical, signReceipt, verifyReceipt, storeKey };
