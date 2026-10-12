// OpNS name → identity key, for paymail pki / profile / verify on our domains (e.g. alice@bwalletx.com).
//
// Read-only and keyless. A name counts as bound only when the transaction that created its CURRENT
// (unspent) output carries the binding, so a sold name never keeps the seller's key:
//   - PushDrop publish (@1sat/actions ≥ 0.0.234 registerOpns): the name coin is locked in a signed
//     PushDrop with fields `identity` (33-byte key) and `profile` (DAG-CBOR {domain, name?, avatar?}).
//     The lock key and the field signature must both derive from that identity key (protocol
//     [0,'onesat'], keyID `opns:<spent txid>_<vout>`, counterparty anyone), and profile.domain must be
//     one of ours: the name's owner chose this ecosystem.
//   - Legacy MAP binding: `opns.idKey` set in a MAP of that same transaction.
// Claimed bWallet aliases always win; this is only consulted when no alias matches (lib/paymail.js).
'use strict';
const { PrivateKey, ProtoWallet, PublicKey, PushDrop, Script, Transaction, Utils } = require('@bsv/sdk');

const OPNS_PROTOCOL = [0, 'onesat'];
const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5';
const KEY_RE = /^0[23][0-9a-f]{64}$/;
const NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const OUTPOINT_RE = /^([0-9a-f]{64})[._](\d{1,6})$/;
const TTL_MS = 60 * 1000;

const SERVICES = {
  opns: 'https://ordinals.gorillapool.io/api/opns',
  origin: 'https://api.1sat.app/1sat/opns/origin',
  latest: 'https://ordinals.gorillapool.io/api/inscriptions',
  rawTx: 'https://api.whatsonchain.com/v1/bsv/main/tx',
};

const anyone = new ProtoWallet(new PrivateKey(1));

/** Minimal DAG-CBOR reader: the profile map only uses text keys and text / byte-string values. */
function cborDecode(bytes) {
  let i = 0;
  const len = (info) => {
    if (info < 24) return info;
    const n = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
    if (!n || i + n > bytes.length) throw new Error('cbor: bad length');
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + bytes[i++];
    return v;
  };
  const item = (depth) => {
    if (depth > 4 || i >= bytes.length) throw new Error('cbor: truncated');
    const b = bytes[i++];
    const major = b >> 5;
    const n = len(b & 31);
    if (major === 2 || major === 3) {
      if (i + n > bytes.length) throw new Error('cbor: truncated');
      const v = bytes.slice(i, i + n);
      i += n;
      return major === 3 ? Utils.toUTF8(v) : Uint8Array.from(v);
    }
    if (major === 5) {
      const m = {};
      for (let k = 0; k < n; k++) {
        const key = item(depth + 1);
        if (typeof key !== 'string') throw new Error('cbor: non-text key');
        m[key] = item(depth + 1);
      }
      return m;
    }
    if (major === 0) return n;
    throw new Error('cbor: unsupported type');
  };
  const v = item(0);
  if (i !== bytes.length) throw new Error('cbor: trailing bytes');
  return v;
}

/** `{ identityKey, profile }` from a signed OpNS PushDrop publish, or null. Verifies key + signature. */
async function readPushDrop(tx, vout) {
  let decoded;
  try {
    decoded = PushDrop.decode(tx.outputs[vout].lockingScript);
  } catch {
    return null;
  }
  const fields = decoded.fields.map((f) => [...f]);
  const signature = fields.pop();
  if (!signature || fields.length % 2 !== 0) return null;
  let identityKey = null;
  let profile = null;
  let identities = 0;
  for (let k = 0; k < fields.length; k += 2) {
    let key;
    try {
      key = Utils.toUTF8(fields[k]);
    } catch {
      continue;
    }
    const value = fields[k + 1];
    if (key === 'identity') {
      identities++;
      if (value.length === 33 && (value[0] === 2 || value[0] === 3)) identityKey = Utils.toHex(value);
    } else if (key === 'profile') {
      try {
        const m = cborDecode(value);
        if (m && typeof m === 'object' && typeof m.domain === 'string' && m.domain) {
          profile = { domain: m.domain, name: typeof m.name === 'string' ? m.name : undefined };
        }
      } catch {
        return null;
      }
    }
  }
  if (identities !== 1 || !identityKey || !profile) return null;
  const lockKey = decoded.lockingPublicKey.toString();
  const data = fields.flat();
  // keyID = the outpoint the publish spent (the name coin); try each input, the coin is normally first.
  for (const input of tx.inputs) {
    const txid = input.sourceTXID || (input.sourceTransaction && input.sourceTransaction.id('hex'));
    if (!txid) continue;
    const keyID = `opns:${txid}_${input.sourceOutputIndex}`;
    try {
      const { publicKey } = await anyone.getPublicKey({ protocolID: OPNS_PROTOCOL, keyID, counterparty: identityKey });
      if (publicKey !== lockKey) continue;
      const { valid } = await anyone.verifySignature({
        data,
        signature,
        protocolID: OPNS_PROTOCOL,
        keyID,
        counterparty: identityKey,
      });
      if (valid) return { identityKey, profile };
    } catch {
      /* not this input */
    }
  }
  return null;
}

/** `opns.idKey` from a MAP SET anywhere in the transaction (legacy binding), or null. */
function readMapIdKey(tx) {
  for (const out of tx.outputs) {
    // @bsv/sdk keeps everything after a top-level OP_RETURN as one data chunk: re-parse it.
    const chunks = [];
    for (const ch of out.lockingScript.chunks) {
      if (ch.op === 0x6a && ch.data && ch.data.length) {
        try {
          chunks.push(...Script.fromBinary(ch.data).chunks);
        } catch {
          /* unparsable tail */
        }
      } else chunks.push(ch);
    }
    for (let c = 0; c < chunks.length; c++) {
      const d = chunks[c].data;
      if (!d || d.length !== MAP_PREFIX.length || Utils.toUTF8(d) !== MAP_PREFIX) continue;
      const cmd = chunks[c + 1] && chunks[c + 1].data;
      if (!cmd || Utils.toUTF8(cmd) !== 'SET') continue;
      for (let k = c + 2; k + 1 < chunks.length; k += 2) {
        const key = chunks[k].data;
        const val = chunks[k + 1].data;
        if (!key || !val) break;
        const ks = Utils.toUTF8(key);
        if (ks === '|') break;
        if (ks === 'opns.idKey') {
          const v = Utils.toUTF8(val).trim().toLowerCase();
          return KEY_RE.test(v) ? v : null;
        }
      }
    }
  }
  return null;
}

const getJson = async (f, url) => {
  const r = await f(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) return null;
  return r.json().catch(() => null);
};

/**
 * Make a cached resolver. `resolve(name, ourDomains)` → `{ name, identityKey, displayName, via }` or null.
 * Results (hits and misses) are cached for TTL_MS; lookups never throw.
 */
function makeOpnsResolver({ f = fetch, now = () => Date.now(), ttl = TTL_MS } = {}) {
  const cache = new Map();
  const lookup = async (name, ourDomains) => {
    const rec = await getJson(f, `${SERVICES.opns}/${encodeURIComponent(name)}`);
    let origin = rec && typeof rec.origin === 'string' ? rec.origin : '';
    if (!origin) {
      const o = await getJson(f, `${SERVICES.origin}/${encodeURIComponent(name)}`);
      origin = o && typeof o.outpoint === 'string' ? o.outpoint : '';
    }
    const om = OUTPOINT_RE.exec(origin);
    if (!om) return null;
    // The name's current location; it must be unspent.
    const latest = await getJson(f, `${SERVICES.latest}/${om[1]}_${om[2]}/latest?script=false`);
    const lm = latest && typeof latest.outpoint === 'string' ? OUTPOINT_RE.exec(latest.outpoint) : null;
    if (!lm || latest.spend) return null;
    const vout = Number(lm[2]);
    const hexRes = await f(`${SERVICES.rawTx}/${lm[1]}/hex`, { signal: AbortSignal.timeout(5000) });
    if (!hexRes.ok) return null;
    const tx = Transaction.fromHex((await hexRes.text()).trim());
    if (tx.id('hex') !== lm[1] || !tx.outputs[vout]) return null;
    const pd = await readPushDrop(tx, vout);
    if (pd) {
      if (!ourDomains.includes(pd.profile.domain.trim().toLowerCase())) return null;
      return { name, identityKey: pd.identityKey, displayName: pd.profile.name || name, via: 'opns-pushdrop' };
    }
    const idKey = readMapIdKey(tx);
    if (idKey) return { name, identityKey: idKey, displayName: name, via: 'opns-map' };
    return null;
  };
  return async function resolve(name, ourDomains) {
    const n = String(name || '').toLowerCase();
    if (!NAME_RE.test(n)) return null;
    const key = `${n}|${ourDomains.join(',')}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.value;
    let value = null;
    try {
      value = await lookup(n, ourDomains);
    } catch {
      value = null;
    }
    if (value && (!KEY_RE.test(value.identityKey) || !PublicKey.fromString(value.identityKey))) value = null;
    cache.set(key, { value, until: now() + ttl });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return value;
  };
}

module.exports = { makeOpnsResolver, readPushDrop, readMapIdKey, cborDecode, SERVICES, OPNS_PROTOCOL };
