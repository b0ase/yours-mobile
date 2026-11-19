// Exchange › Contracts (src/mobile/contracts/contractNft.ts): a contract is a PUBLIC 1Sat NFT, so buyers can
// read and audit it. Each copy is the same envelope inscribed again; a buyer's copy is minted in the
// transaction that pays the author. This module parses envelopes; the chain checks are shared with
// strategies (strategyKeys.js).
const { Hash, ProtoWallet, Utils } = require('@bsv/sdk');

const CONTRACT_TYPE = 'application/vnd.bwalletx.contract+json';
const CONTRACT_FORMAT = 'bwalletx.contract-nft/1';

function parseContractEnvelope(text) {
  try {
    const o = JSON.parse(text);
    if (o?.format !== CONTRACT_FORMAT || !o.contract || typeof o.contract !== 'object' || !o.sale || !o.author)
      return null;
    if (o.contract.format !== 'bwalletx.contract/1' || typeof o.contract.name !== 'string') return null;
    if (/[\ud800-\udfff]/.test(o.contract.name.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))) return null;
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

/**
 * What makes two listings the same contract (b-Aware row 352, UID 630, and its review). Free text (name, version,
 * summary, the envelope's description) never does. Mirrors the wallet's contractKeys (src/mobile/contracts/
 * contractNft.ts) line for line; a test runs both on the same fixtures.
 * - A listing with code (every paid one must have it; codeProblem) IS its code: `hash:` + its code hash in lower case,
 *   and `src:` + sha256 of its normalised source. Params, spend paths, oracle and network are text typed around the
 *   code, so a junk param, `5` for "5" or an empty oracle don't make a new contract. Two listings are the same contract
 *   when they share either key, so dropping the code hash or the source of an original that has both doesn't either.
 * - A free listing with no code: `free:` + the canonical JSON of its normalised format, network, params, spend paths,
 *   oracle and NAME (without the name every unrelated free contract on one network would be "the same").
 * Known limit: a real edit to the code itself is a different contract; the backstop is the signed author handle on the
 * sheet.
 */
const CODE_HASH_RE = /^[0-9a-f]{64}$/i;
const FREE_IDENTITY_FIELDS = ['format', 'network', 'params', 'spendPaths', 'oracle', 'name'];

/** Source as identity sees it: NFKC, CRLF/CR → LF, trailing whitespace per line and blank lines at the ends dropped. */
const normaliseSource = (s) =>
  typeof s === 'string'
    ? s
        .normalize('NFKC')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((l) => l.replace(/\s+$/u, ''))
        .join('\n')
        .trim()
    : '';

/** Every string and number as NFKC-trimmed text; null, '', [] and {} dropped (undefined); object keys sorted. */
const tidy = (v) => {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) {
    const a = v.map(tidy).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v)
      .map(([k, x]) => [k.normalize('NFKC').trim(), tidy(x)])
      .filter(([k, x]) => k !== '' && x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  const s = String(v).normalize('NFKC').trim();
  return s === '' ? undefined : s;
};

/** The identity keys of a contract descriptor (see above). Never empty. */
const contractKeys = (c) => {
  const src = c && typeof c === 'object' ? c : {};
  const keys = [];
  if (typeof src.codeHash === 'string' && CODE_HASH_RE.test(src.codeHash))
    keys.push(`hash:${src.codeHash.toLowerCase()}`);
  const source = normaliseSource(src.source);
  if (source !== '') keys.push(`src:${Utils.toHex(Hash.sha256(Utils.toArray(source, 'utf8')))}`);
  if (keys.length) return keys;
  const picked = {};
  for (const k of FREE_IDENTITY_FIELDS) picked[k] = src[k];
  return [`free:${JSON.stringify(tidy(picked) ?? {})}`];
};

/** One string for an envelope's contract: its code hash, else its source, else its free fields (contractKeys[0]). */
const contractId = (e) => contractKeys(e?.contract)[0];

/**
 * Why a PAID listing can't be listed, or null: it must carry code, a valid code hash (64 hex characters) or a
 * source that isn't blank once normalised, and a code hash it carries must be valid (buyers are shown it, and it is
 * the identity).
 */
const codeProblem = (c) => {
  const hash = c?.codeHash;
  const hasHash = hash !== undefined && hash !== null && hash !== '';
  if (hasHash && (typeof hash !== 'string' || !CODE_HASH_RE.test(hash)))
    return 'A paid contract’s code hash must be 64 hex characters';
  if (!hasHash && normaliseSource(c?.source) === '')
    return 'A paid contract must include its source or code hash, so buyers can read what they are paying for';
  return null;
};

/**
 * Older wallets list paid contracts unsigned. The released wallet shows this text as it is, after it has minted,
 * so it says what to do (owner, 14 Nov 2026).
 */
const UPDATE_TO_SIGN =
  "This contract wasn't listed: paid contracts now carry your signature, which needs bWalletX 5.2.57 or later. Update when it's available, then publish it again.";

/**
 * Why the catalogue won't list (or serve) `env`, as [status, error], or null. A paid listing must be signed by its
 * author: author.identityKey a compressed key, authorSig valid by it, and the payee the author's own address. A
 * listing that claims a key or carries a signature must verify too (a free one from the wallet's own publish is
 * signed); a free listing with neither is accepted, as before.
 */
async function envelopeRefusal(env) {
  const paid = Number(env.sale.priceUsd) > 0;
  const author = env.author;
  if (paid && author.identityKey === undefined && env.authorSig === undefined) return [400, UPDATE_TO_SIGN];
  const noCode = paid ? codeProblem(env.contract) : null;
  if (noCode) return [400, noCode];
  if (paid || author.identityKey !== undefined || env.authorSig !== undefined) {
    if (typeof author.identityKey !== 'string' || !PUBKEY_RE.test(author.identityKey))
      return [400, paid ? 'A paid contract must carry its author’s identity key' : 'Bad author identity key'];
    if (!(await contractAuthorKey(env))) return [400, 'This contract isn’t signed by its author'];
  }
  if (paid && env.sale.payTo !== author.address) return [400, 'A paid contract must pay its author’s address'];
  return null;
}

/**
 * May `later` be listed after `earlier` (the same contract: they share a contractKeys key)? A signed listing can be
 * listed again only under the same key. After an unsigned one only a listing from the same author address may follow,
 * signed or not: a signed clone of a legacy unsigned listing must not win and shut the real author out (b-Aware row
 * 352). `key` is the verified identity key (contractAuthorKey) or null.
 */
const mayFollow = (earlier, later) =>
  earlier.key ? later.key === earlier.key : earlier.env.author.address === later.env.author.address;

/**
 * Chain order of two origins: the earlier block first; unconfirmed ranks after confirmed. In one block (or both
 * unconfirmed) it is the order the catalogue first saw them, never the position in the block: a copier who sees the
 * original in the mempool can get an earlier position in the same block (re-review of f3ff8a37). Negative = `a` first.
 */
function chainOrder(a, b) {
  if (a.pos && b.pos && a.pos.height !== b.pos.height) return a.pos.height - b.pos.height;
  if (!a.pos !== !b.pos) return a.pos ? -1 : 1;
  return a.seen - b.seen || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0);
}

const checked = new Map();
/** envelopeRefusal + contractAuthorKey for a catalogue row. An origin's inscription never changes: kept per origin. */
async function checkRow(origin, env) {
  const memo = `${origin}|${env.authorSig ?? ''}`;
  if (checked.has(memo)) return checked.get(memo);
  const out = { refused: await envelopeRefusal(env), key: await contractAuthorKey(env) };
  if (checked.size > 5000) checked.clear();
  checked.set(memo, out);
  return out;
}

/**
 * The listings the catalogue serves, from rows `{ origin, envelope, created_at }`, as { served, unchecked } (Sets of
 * origins):
 * - a row that fails envelopeRefusal is left out (older unsigned or badly signed paid listings: fail closed);
 * - two listings are of one contract when they share an identity key (contractKeys). When two such listings disagree
 *   about the author (mayFollow), the earliest ON CHAIN stays (chainOrder, from `position(origin)`, asked only for
 *   listings in such a dispute) and a later one that may not follow an earlier kept one is left out. So listing first
 *   in the catalogue is no way to take over an author's contract. Keys are compared pair by pair, never chained: a
 *   listing carrying one contract's code hash and another's source can't join two unrelated contracts into one;
 * - `position` throws when it couldn't find out (null = unconfirmed). Then the order isn't known, so NONE of the
 *   listings in that dispute (and in disputes joined to it) is served and all are `unchecked` (re-review of f3ff8a37:
 *   a failed lookup for the original must never serve the copy). A position the caller already holds doesn't fail, so
 *   a proven order stays served.
 */
async function judgeListings(rows, position) {
  const all = [];
  const byKey = new Map();
  for (const r of rows) {
    if (!r?.envelope || typeof r.envelope !== 'object' || !r.envelope.author || !r.envelope.sale) continue;
    const { refused, key } = await checkRow(r.origin, r.envelope);
    if (refused) continue;
    const seen = Date.parse(r.created_at);
    const l = {
      origin: r.origin,
      env: r.envelope,
      key,
      seen: seen || Infinity,
      ids: contractKeys(r.envelope.contract),
    };
    all.push(l);
    for (const id of l.ids) {
      if (!byKey.has(id)) byKey.set(id, []);
      byKey.get(id).push(l);
    }
  }
  // Disputes: two listings of one contract that don't agree about the author. Their chain order decides.
  const disputes = new Map(all.map((l) => [l, new Set()]));
  for (const same of byKey.values())
    for (const a of same)
      for (const b of same) if (a !== b && !(mayFollow(a, b) && mayFollow(b, a))) disputes.get(a).add(b);
  const failed = [];
  for (const l of all) {
    if (!disputes.get(l).size) continue;
    try {
      l.pos = (await position(l.origin)) ?? null;
    } catch {
      failed.push(l);
    }
  }
  const unchecked = new Set();
  const stuck = new Set();
  for (const f of failed) {
    const todo = [f];
    while (todo.length) {
      const l = todo.pop();
      if (stuck.has(l)) continue;
      stuck.add(l);
      unchecked.add(l.origin);
      todo.push(...disputes.get(l));
    }
  }
  const served = new Set();
  const kept = new Map();
  for (const l of all.filter((x) => !stuck.has(x)).sort(chainOrder)) {
    const earlier = l.ids.flatMap((id) => kept.get(id) ?? []);
    if (!earlier.every((k) => mayFollow(k, l))) continue;
    served.add(l.origin);
    for (const id of l.ids) {
      if (!kept.has(id)) kept.set(id, []);
      kept.get(id).push(l);
    }
  }
  return { served, unchecked };
}
const servedListings = async (rows, position) => (await judgeListings(rows, position)).served;

module.exports = {
  CONTRACT_TYPE,
  CONTRACT_FORMAT,
  CONTRACT_SIGN_PROTOCOL,
  CONTRACT_SIGN_KEY_ID,
  UPDATE_TO_SIGN,
  canonical,
  chainOrder,
  contractAuthorKey,
  codeProblem,
  contractId,
  contractKeys,
  normaliseSource,
  contractSigningBytes,
  envelopeRefusal,
  judgeListings,
  mayFollow,
  parseContractEnvelope,
  servedListings,
};
