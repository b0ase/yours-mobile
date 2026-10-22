// Handle NFTs (docs/HANDLE-NFTS.md): a bWalletX handle (name@bwalletx.com) represented by a 1Sat ordinal.
//
// Until a handle is tokenised, its DB row (bwallet_paymail_aliases) is the source of truth. Once tokenised
// (nft_origin set), the chain wins: the handle belongs to the identity key bound IN THE TRANSACTION THAT
// CREATED THE NFT'S CURRENT OUTPUT. A binding is a MAP SET on that output, signed by an identity key:
//   - self-claim:   signer = to                         (the holder names its own key)
//   - designation:  signer = the key bound at `spent`   (the previous holder hands it to `to`)
// Anything else (a marketplace sale, a send from another tool, a bad signature) leaves the handle UNBOUND:
// it answers nothing (404) until the holder self-claims, so payments never reach the wrong person.
//
// Keyless and read-only: the server signs nothing and holds no keys.
'use strict';
const { ProtoWallet, Script, Transaction, Utils } = require('@bsv/sdk');

const PROTOCOL = 'bwalletx-handle';
const CONTENT_TYPE = 'application/json';
const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5';
const SIGN_PROTOCOL = [2, 'bwallet paymail'];
const SIGN_KEY_ID = '1';
const KEY_RE = /^0[23][0-9a-f]{64}$/;
const OUTPOINT_RE = /^([0-9a-f]{64})_(\d{1,6})$/;
const ALIAS_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
const SIG_RE = /^[0-9a-f]{16,200}$/;
const GENESIS = 'genesis';
const TTL_MS = 60 * 1000;

const SERVICES = {
  latest: 'https://ordinals.gorillapool.io/api/inscriptions',
  rawTx: 'https://api.whatsonchain.com/v1/bsv/main/tx',
};

const normOutpoint = (s) =>
  String(s || '')
    .replace('.', '_')
    .toLowerCase();

/** The inscription body for a handle NFT (UTF-8 JSON). */
function handleContent(alias, domain) {
  return JSON.stringify({ p: PROTOCOL, v: 1, alias, domain });
}

/** Canonical binding message (same shape as every signed paymail request: lib/paymail.js signedMessage). */
function bindingMessage({ alias, origin, spent, to, signer }) {
  const fields = { alias, origin: origin || '', signer, spent, to };
  const keys = Object.keys(fields).sort();
  return ['bwallet-paymail', 'v1', 'handle-bind', ...keys.map((k) => `${k}=${fields[k] ?? ''}`)].join('|');
}

/** MAP keys a binding uses on the NFT output. */
const MAP_KEYS = {
  alias: 'handle.alias',
  origin: 'handle.origin',
  spent: 'handle.spent',
  to: 'handle.to',
  signer: 'handle.signer',
  sig: 'handle.sig',
};

/** Flatten an output script's chunks, re-parsing the tail @bsv/sdk keeps after a top-level OP_RETURN. */
function chunksOf(script) {
  const out = [];
  for (const ch of script.chunks) {
    if (ch.op === 0x6a && ch.data && ch.data.length) {
      out.push({ op: 0x6a });
      try {
        out.push(...Script.fromBinary(ch.data).chunks);
      } catch {
        /* unparsable tail */
      }
    } else out.push(ch);
  }
  return out;
}

const utf8 = (d) => {
  try {
    return Utils.toUTF8(d);
  } catch {
    return null;
  }
};

/** The first MAP SET on one output as { key: value }, or null. */
function readMap(script) {
  const chunks = chunksOf(script);
  for (let c = 0; c < chunks.length; c++) {
    const d = chunks[c].data;
    if (!d || d.length !== MAP_PREFIX.length || utf8(d) !== MAP_PREFIX) continue;
    if (utf8(chunks[c + 1]?.data || []) !== 'SET') continue;
    const m = {};
    for (let k = c + 2; k + 1 < chunks.length; k += 2) {
      const key = chunks[k].data;
      const val = chunks[k + 1].data;
      if (!key) break;
      const ks = utf8(key);
      if (ks === '|' || ks === null) break;
      if (!(ks in m)) m[ks] = val ? (utf8(val) ?? '') : '';
    }
    return m;
  }
  return null;
}

/** The 1Sat inscription on one output: { contentType, content (utf8) } or null. */
function readInscription(script) {
  const ch = script.chunks;
  for (let i = 0; i + 2 < ch.length; i++) {
    if (ch[i].op !== 0 || ch[i + 1].op !== 0x63 || utf8(ch[i + 2].data || []) !== 'ord') continue;
    let contentType = '';
    for (let j = i + 3; j < ch.length; j += 2) {
      const tag = ch[j];
      if (tag.op === 0x68) break;
      if (tag.op === 0 && !tag.data?.length) {
        return { contentType, content: utf8(ch[j + 1]?.data || []) ?? '' };
      }
      const isType = tag.op === 0x51 || (tag.data && tag.data.length === 1 && tag.data[0] === 1);
      if (isType) contentType = utf8(ch[j + 1]?.data || []) ?? '';
    }
    return null;
  }
  return null;
}

/** Parse the handle content JSON; returns { alias, domain } or null. */
function parseHandleContent(ins) {
  if (!ins || !String(ins.contentType).toLowerCase().startsWith(CONTENT_TYPE)) return null;
  try {
    const j = JSON.parse(ins.content);
    if (j?.p !== PROTOCOL || j.v !== 1 || !ALIAS_RE.test(String(j.alias))) return null;
    return { alias: String(j.alias), domain: String(j.domain || '').toLowerCase() };
  } catch {
    return null;
  }
}

/** The binding fields on output `vout` of `tx`, or null (no / malformed binding). */
function readBinding(tx, vout) {
  const out = tx.outputs[vout];
  if (!out) return null;
  const m = readMap(out.lockingScript);
  if (!m) return null;
  const b = {
    alias: String(m[MAP_KEYS.alias] || '').toLowerCase(),
    origin: normOutpoint(m[MAP_KEYS.origin]),
    spent: m[MAP_KEYS.spent] === GENESIS ? GENESIS : normOutpoint(m[MAP_KEYS.spent]),
    to: String(m[MAP_KEYS.to] || '').toLowerCase(),
    signer: String(m[MAP_KEYS.signer] || '').toLowerCase(),
    sig: String(m[MAP_KEYS.sig] || '').toLowerCase(),
  };
  if (!ALIAS_RE.test(b.alias) || !KEY_RE.test(b.to) || !KEY_RE.test(b.signer) || !SIG_RE.test(b.sig)) return null;
  if (b.spent !== GENESIS && !OUTPOINT_RE.test(b.spent)) return null;
  if (b.origin && !OUTPOINT_RE.test(b.origin)) return null;
  return b;
}

/** Is `b.sig` a valid BRC-43 signature by `b.signer` over bindingMessage(b)? */
async function verifyBinding(b) {
  if (!b || !KEY_RE.test(b.signer) || !SIG_RE.test(b.sig)) return false;
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(bindingMessage(b), 'utf8'),
      signature: Utils.toArray(b.sig, 'hex'),
      protocolID: SIGN_PROTOCOL,
      keyID: SIGN_KEY_ID,
      counterparty: b.signer,
    });
    return valid === true;
  } catch {
    return false;
  }
}

/** Does `tx` spend `outpoint` (txid_vout)? */
function spends(tx, outpoint) {
  const m = OUTPOINT_RE.exec(outpoint);
  if (!m) return false;
  return tx.inputs.some((i) => {
    const txid = i.sourceTXID || (i.sourceTransaction && i.sourceTransaction.id('hex'));
    return txid === m[1] && Number(i.sourceOutputIndex) === Number(m[2]);
  });
}

/**
 * Who owns a handle now. Pure precedence, all chain access injected:
 *   chain.latest(origin) → { outpoint, spent } | null   (throws when the indexer can't answer)
 *   chain.tx(txid)       → Transaction | null
 * Returns { key, location, via } where key = null means "answer nothing":
 *   db         not tokenised: the row's identity key
 *   frozen     an operator froze it (stolen-NFT dispute): nothing
 *   stale      indexer down: the last verified holder (the row)
 *   gone       the NFT is burned / spent with no successor: nothing
 *   same       the NFT hasn't moved since the last verified binding: the row
 *   self       moved, and the new output carries a self-claim: the claimer
 *   designated moved one hop, signed over by the previous holder: the named key
 *   unbound    moved without a valid binding: nothing
 */
async function resolveHandle(row, chain) {
  if (!row) return { key: null, location: null, via: 'none' };
  if (!row.nft_origin) return { key: row.identity_key, location: null, via: 'db' };
  if (row.nft_frozen) return { key: null, location: row.nft_location, via: 'frozen' };
  let latest;
  try {
    latest = await chain.latest(row.nft_origin);
  } catch {
    return { key: row.nft_unbound ? null : row.identity_key, location: row.nft_location, via: 'stale' };
  }
  const loc = latest && normOutpoint(latest.outpoint);
  if (!loc || !OUTPOINT_RE.test(loc) || latest.spent) return { key: null, location: null, via: 'gone' };
  if (loc === row.nft_location) {
    return row.nft_unbound
      ? { key: null, location: loc, via: 'unbound' }
      : { key: row.identity_key, location: loc, via: 'same' };
  }
  const [, txid, vout] = OUTPOINT_RE.exec(loc);
  let tx = null;
  try {
    tx = await chain.tx(txid);
  } catch {
    tx = null;
  }
  if (!tx || tx.id('hex') !== txid) {
    // Can't read the new output yet: keep the last verified holder for now (re-checked after the TTL).
    return { key: row.nft_unbound ? null : row.identity_key, location: row.nft_location, via: 'stale' };
  }
  const b = readBinding(tx, Number(vout));
  const ok =
    b &&
    b.alias === String(row.alias).toLowerCase() &&
    b.origin === normOutpoint(row.nft_origin) &&
    b.spent !== GENESIS &&
    spends(tx, b.spent) &&
    (await verifyBinding(b));
  if (ok && b.signer === b.to) return { key: b.to, location: loc, via: 'self' };
  if (ok && !row.nft_unbound && b.signer === row.identity_key && b.spent === row.nft_location)
    return { key: b.to, location: loc, via: 'designated' };
  return { key: null, location: loc, via: 'unbound' };
}

/** Default chain access (GorillaPool latest location + WhatsOnChain raw tx). Tests inject their own. */
function makeChain(f = fetch) {
  return {
    async latest(origin) {
      const r = await f(`${SERVICES.latest}/${normOutpoint(origin)}/latest?script=false`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`indexer ${r.status}`);
      const j = await r.json();
      return { outpoint: String(j?.outpoint || ''), spent: !!j?.spend };
    },
    async tx(txid) {
      const r = await f(`${SERVICES.rawTx}/${txid}/hex`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      return Transaction.fromHex((await r.text()).trim());
    },
  };
}

/**
 * Cached resolver. `resolve(row)` → resolveHandle result; untokenised rows skip the cache and the chain.
 * `onMove(row, result)` is called (best effort) when the chain shows a new verified or unbound state,
 * so the DB row follows the NFT.
 */
function makeHandleResolver({ chain = makeChain(), now = () => Date.now(), ttl = TTL_MS, onMove } = {}) {
  const cache = new Map();
  const resolve = async (row) => {
    if (!row || !row.nft_origin) return resolveHandle(row, chain);
    const k = String(row.alias);
    const hit = cache.get(k);
    if (hit && hit.until > now()) return hit.value;
    const value = await resolveHandle(row, chain);
    const moved =
      value.via === 'self' ||
      value.via === 'designated' ||
      (value.via === 'unbound' && (!row.nft_unbound || value.location !== row.nft_location));
    if (moved && onMove) await Promise.resolve(onMove(row, value)).catch(() => undefined);
    cache.set(k, { value, until: now() + ttl });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return value;
  };
  resolve.forget = (alias) => cache.delete(String(alias));
  return resolve;
}

/**
 * First tokenisation: is `tx` (the origin tx) a valid handle mint of `alias` on one of `domains`, at `vout`,
 * with a genesis self-binding by `identityKey`? Returns null when valid, else the reason.
 */
async function checkMint(tx, vout, { alias, identityKey, domains }) {
  const out = tx.outputs[vout];
  if (!out) return 'No such output';
  if (Number(out.satoshis) !== 1) return 'Not a 1-sat ordinal';
  const c = parseHandleContent(readInscription(out.lockingScript));
  if (!c || c.alias !== alias) return 'That inscription is not this handle';
  if (!domains.includes(c.domain)) return 'That inscription names another domain';
  const b = readBinding(tx, vout);
  if (!b || b.alias !== alias || b.spent !== GENESIS || b.origin) return 'The mint has no binding';
  if (b.signer !== identityKey || b.to !== identityKey) return 'The mint is bound to another key';
  if (!(await verifyBinding(b))) return 'Bad binding signature';
  return null;
}

module.exports = {
  PROTOCOL,
  CONTENT_TYPE,
  GENESIS,
  MAP_KEYS,
  MAP_PREFIX,
  SERVICES,
  OUTPOINT_RE,
  handleContent,
  bindingMessage,
  readMap,
  readInscription,
  parseHandleContent,
  readBinding,
  verifyBinding,
  spends,
  resolveHandle,
  makeChain,
  makeHandleResolver,
  checkMint,
  normOutpoint,
};
