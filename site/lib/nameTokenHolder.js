// Who holds a name token right now, read from the chain (bitcoin-corp docs/PROVABLE-NAMES.md, owner 28 Oct 2026).
//
// A name token (a paymail name or an OpNS name) is a 1-sat ordinal. Whoever holds that sat owns the name. We do NOT
// trust one indexer for this: on 28 Oct the GorillaPool OpNS indexer still showed our mint addresses as owners of
// a47 / aaap after both had been gifted on chain. So we follow the spends ourselves, from the mint outpoint:
//
//   1. Is the current outpoint spent? (WhatsOnChain /tx/<txid>/<vout>/spent; 404 = unspent.)
//   2. If spent, fetch the spending tx (WhatsOnChain hex, then JungleBus) and apply the ordinal rule: the sat sits at
//      offset = (sats of the inputs before ours) + (its offset inside our output); it lands in the output that covers
//      that offset. An offset past the last output means the sat went to the miner (the name is burned: null).
//   3. Repeat until unspent (at most maxHops).
//
// OrdLock listings (v1 and v2) are recognised: a listed name reports `listed: true` and the seller's last address.
// A purchase or a cancel is just another spend, so following it lands on the buyer or back on the seller.
//
// The chain access is injected (`chain`), so tests run on recorded transactions and another tracker can be swapped
// in behind the same `nameTokenHolder(origin)` interface.
'use strict';
const { Transaction, Utils } = require('@bsv/sdk');

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const OUTPOINT_RE = /^([0-9a-f]{64})[._](\d{1,6})$/;
// Recogniser bytes copied from @1sat/types (ORD_LOCK_PREFIX, ORD_LOCK_V2_PREFIX), first 32 bytes each.
const ORDLOCK_V1 = '2097dfd76851bf465e8f715593b217714858bbe9570ff3bd5e33840a34e20ff0';
const ORDLOCK_V2 = '76009c637576ab76aa517f517f517f517f517f517f517f517f517f517f517f51';

/** Default chain access (read-only, keyless). */
const wocChain = (f = fetch) => ({
  /** {txid, vin} of the tx spending txid:vout, or null when unspent. Throws when it can't tell. */
  async spentBy(txid, vout) {
    const r = await f(`${WOC}/tx/${txid}/${vout}/spent`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`spent lookup failed (${r.status})`);
    const j = await r.json();
    if (!j || !/^[0-9a-f]{64}$/.test(String(j.txid)) || !Number.isInteger(j.vin)) throw new Error('bad spent answer');
    return { txid: j.txid, vin: j.vin };
  },
  async tx(txid) {
    for (const url of [`${WOC}/tx/${txid}/hex`, `https://junglebus.gorillapool.io/v1/transaction/get/${txid}/bin`]) {
      try {
        const r = await f(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const tx = url.endsWith('/hex')
          ? Transaction.fromHex((await r.text()).trim())
          : Transaction.fromBinary(Array.from(new Uint8Array(await r.arrayBuffer())));
        if (tx.id('hex') === txid) return tx;
      } catch {
        /* next source */
      }
    }
    return null;
  },
});

/** The P2PKH address inside a locking script (plain, or under an inscription envelope), else null. */
function ownerAddress(scriptHex) {
  const m = /76a914([0-9a-f]{40})88ac/.exec(scriptHex);
  return m ? Utils.toBase58Check(Utils.toArray(m[1], 'hex'), [0]) : null;
}
const listingKind = (scriptHex) =>
  scriptHex.includes(ORDLOCK_V2) ? 'ordlock-v2' : scriptHex.includes(ORDLOCK_V1) ? 'ordlock' : null;

/** Which output of `tx` holds the sat at `offset` (sum over outputs), and its offset inside it; null if burned. */
function outputForOffset(tx, offset) {
  let at = 0;
  for (let i = 0; i < tx.outputs.length; i++) {
    const s = Number(tx.outputs[i].satoshis);
    if (offset < at + s) return { vout: i, inner: offset - at };
    at += s;
  }
  return null;
}

/**
 * makeNameTokenHolder({chain, maxHops}) → nameTokenHolder(origin): resolves to
 *   { origin, outpoint, address, listed, listing, hops: [outpoint…], burned } or throws when the chain can't tell.
 */
function makeNameTokenHolder({ chain = wocChain(), maxHops = 200 } = {}) {
  const txCache = new Map();
  const getTx = async (txid) => {
    if (!txCache.has(txid)) {
      const tx = await chain.tx(txid);
      if (!tx) throw new Error(`could not fetch ${txid}`);
      txCache.set(txid, tx);
      if (txCache.size > 500) txCache.delete(txCache.keys().next().value);
    }
    return txCache.get(txid);
  };
  return async function nameTokenHolder(origin) {
    const m = OUTPOINT_RE.exec(String(origin || '').toLowerCase());
    if (!m) throw new Error('origin must be <txid>_<vout>');
    let txid = m[1];
    let vout = Number(m[2]);
    let inner = 0; // the sat's offset inside the current output (0 for a 1-sat name token)
    const hops = [`${txid}_${vout}`];
    let lastAddress = null;
    for (let hop = 0; hop <= maxHops; hop++) {
      const tx = await getTx(txid);
      const out = tx.outputs[vout];
      if (!out) throw new Error(`no output ${txid}_${vout}`);
      const hex = out.lockingScript.toHex();
      const listing = listingKind(hex);
      const address = listing ? null : ownerAddress(hex);
      if (address) lastAddress = address;
      const spend = await chain.spentBy(txid, vout);
      if (!spend) {
        return {
          origin: hops[0],
          outpoint: `${txid}_${vout}`,
          address: address || (listing ? lastAddress : null),
          listed: !!listing,
          listing,
          burned: false,
          hops,
        };
      }
      const next = await getTx(spend.txid);
      let offset = inner;
      for (let i = 0; i < spend.vin; i++) {
        const inp = next.inputs[i];
        const src = await getTx(inp.sourceTXID);
        offset += Number(src.outputs[inp.sourceOutputIndex].satoshis);
      }
      const land = outputForOffset(next, offset);
      if (!land)
        return { origin: hops[0], outpoint: null, address: null, listed: false, listing: null, burned: true, hops };
      txid = spend.txid;
      vout = land.vout;
      inner = land.inner;
      hops.push(`${txid}_${vout}`);
    }
    throw new Error('too many hops');
  };
}

module.exports = { makeNameTokenHolder, wocChain, ownerAddress, outputForOffset, listingKind, ORDLOCK_V1, ORDLOCK_V2 };
