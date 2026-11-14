// Exchange › Contracts (src/mobile/contracts/contractNft.ts): a contract is a PUBLIC 1Sat NFT, so buyers can
// read and audit it. Each copy is the same envelope inscribed again; a buyer's copy is minted in the
// transaction that pays the author. This module parses envelopes; the chain checks are shared with
// strategies (strategyKeys.js).
const { ProtoWallet, Utils } = require('@bsv/sdk');

const CONTRACT_TYPE = 'application/vnd.bwalletx.contract+json';
const CONTRACT_FORMAT = 'bwalletx.contract-nft/1';

function parseContractEnvelope(text) {
  try {
    const o = JSON.parse(text);
    if (o?.format !== CONTRACT_FORMAT || !o.contract || typeof o.contract !== 'object' || !o.sale || !o.author)
      return null;
    if (o.contract.format !== 'bwalletx.contract/1' || typeof o.contract.name !== 'string') return null;
    const price = Number(o.sale.priceUsd);
    const copies = Number(o.sale.copies);
    if (!(price >= 0) || !Number.isInteger(copies) || copies < 1 || typeof o.sale.payTo !== 'string') return null;
    if (!['testnet', 'mainnet'].includes(o.contract.network)) return null;
    return o;
  } catch {
    return null;
  }
}

// ---- author signatures (owner, 14 Nov 2026: "paid contract listing need an author's signature"; b-Aware row 115) ----
// Same scheme as the wallet (src/mobile/contracts/contractNft.ts: canonical, contractSigningBytes,
// contractAuthorKey; its contractSign.test.ts checks this file against it): BRC-43 [2,'bwallet contract'], keyID '1',
// counterparty 'anyone', by author.identityKey, over the canonical JSON of the envelope without authorSig. The site
// is deployed on its own (site/ is the Vercel root) and can't import the wallet's TypeScript, so it is mirrored here.
const CONTRACT_SIGN_PROTOCOL = [2, 'bwallet contract'];
const CONTRACT_SIGN_KEY_ID = '1';
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;

/** Key-order-independent JSON value (objects with sorted keys; arrays keep their order). */
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;

/** The bytes the author signs: the canonical envelope with authorSig left out. */
const contractSigningBytes = (env) => {
  const { authorSig: _sig, ...rest } = env;
  return Utils.toArray(JSON.stringify(canonical(rest)), 'utf8');
};

/** The author's identity key when authorSig is a valid signature by author.identityKey; null otherwise. */
async function contractAuthorKey(env) {
  const key = env?.author?.identityKey;
  const sig = env?.authorSig;
  if (typeof key !== 'string' || !PUBKEY_RE.test(key) || typeof sig !== 'string' || !/^[0-9a-f]{16,200}$/i.test(sig))
    return null;
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: contractSigningBytes(env),
      signature: Utils.toArray(sig, 'hex'),
      protocolID: CONTRACT_SIGN_PROTOCOL,
      keyID: CONTRACT_SIGN_KEY_ID,
      counterparty: key,
    });
    return valid === true ? key : null;
  } catch {
    return null;
  }
}

/** Same contract: the same canonical descriptor and the same description (as the wallet's copiedFrom). */
const sameContract = (a, b) =>
  JSON.stringify(canonical(a.contract)) === JSON.stringify(canonical(b.contract)) && a.description === b.description;

/**
 * Why the catalogue refuses to list `env`, as [status, error], or null to list it. `earlier` = envelopes already in
 * the catalogue (any contract; only the same contract counts).
 * - A paid listing must be signed by its author: author.identityKey a compressed key, authorSig valid by it, and the
 *   payee the author's own address. A listing that claims a key or carries a signature must verify too (a free one
 *   from the wallet's own publish is signed); a free listing with neither is accepted, as before.
 * - The earliest listing of a contract stays: a later one under another author is refused. Authors are compared by
 *   their verified identity key when both listings are signed, otherwise by author.address (unsigned free listings
 *   and older rows). The wallet also refuses to buy a later copy (copiedFrom); this keeps it out of the catalogue.
 */
async function listingRefusal(env, earlier = []) {
  const paid = Number(env.sale.priceUsd) > 0;
  const claimsKey = env.author.identityKey !== undefined || env.authorSig !== undefined;
  let key = null;
  if (paid || claimsKey) {
    if (typeof env.author.identityKey !== 'string' || !PUBKEY_RE.test(env.author.identityKey))
      return [400, paid ? 'A paid contract must carry its author’s identity key' : 'Bad author identity key'];
    key = await contractAuthorKey(env);
    if (!key) return [400, 'This contract isn’t signed by its author'];
  }
  if (paid && env.sale.payTo !== env.author.address) return [400, 'A paid contract must pay its author’s address'];
  for (const e of earlier) {
    if (!e || typeof e !== 'object' || !e.author || !sameContract(e, env)) continue;
    const theirs = key ? await contractAuthorKey(e) : null;
    const same = key && theirs ? theirs === key : e.author.address === env.author.address;
    if (!same) return [409, 'This contract is already listed by another author'];
  }
  return null;
}

module.exports = {
  CONTRACT_TYPE,
  CONTRACT_FORMAT,
  CONTRACT_SIGN_PROTOCOL,
  CONTRACT_SIGN_KEY_ID,
  canonical,
  contractAuthorKey,
  contractSigningBytes,
  listingRefusal,
  parseContractEnvelope,
};
