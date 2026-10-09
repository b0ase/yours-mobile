// 1 cent fee for a NEW plain paymail name (owner, 10 Oct 2026; anti-squatting). Renames pay too; names
// that existed before are grandfathered; the forward left behind by a rename is free.
// Env (Vercel only): BWALLET_NAME_FEE_ADDRESS = the revenue address. Empty = fee OFF (nothing changes).
'use strict';
const { P2PKH, Transaction } = require('@bsv/sdk');

const FEE_USD = 0.01;
/** Rates move between the app quoting and the server checking: accept 20% under the server's price. */
const SLIPPAGE = 0.2;
const ADDRESS_RE = /^1[1-9A-HJ-NP-Za-km-z]{24,34}$/;

let warned = false;
/** The fee address, or '' when the fee is off (logs once). */
function feeAddress(env = process.env) {
  const a = String(env.BWALLET_NAME_FEE_ADDRESS || '').trim();
  if (a && ADDRESS_RE.test(a)) return a;
  if (!warned) {
    warned = true;
    console.log(
      a
        ? 'name fee OFF: BWALLET_NAME_FEE_ADDRESS is not a valid address'
        : 'name fee OFF: BWALLET_NAME_FEE_ADDRESS not set',
    );
  }
  return '';
}

/** Whole sats for $0.01 at `rate` (USD per BSV), rounded up. */
const requiredSats = (rate) => Math.ceil((FEE_USD / rate) * 1e8);

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
let rateCache = { at: 0, rate: 0 };
/** Default chain access; tests inject their own. */
const chain = {
  async tx(txid) {
    for (const url of [`${WOC}/tx/${txid}/hex`, `https://junglebus.gorillapool.io/v1/transaction/get/${txid}/bin`]) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
  async bsvUsd() {
    if (Date.now() - rateCache.at < 5 * 60_000 && rateCache.rate > 0) return rateCache.rate;
    const r = await fetch(`${WOC}/exchangerate`, { signal: AbortSignal.timeout(8000) });
    const rate = Number((await r.json())?.rate) || 0;
    if (rate > 0) rateCache = { at: Date.now(), rate };
    return rate;
  },
};

/**
 * Did `txid` pay the name fee to `address`? The app may also send the raw tx (`txHex`): used only when
 * the indexers haven't seen it yet, and then only after our own broadcast of it is accepted.
 * Returns { ok: true, satoshis } or { ok: false, error }.
 */
async function checkFeeTx({
  txid,
  txHex,
  address,
  c = chain,
  broadcast,
  parse = (h) => ({ tx: Transaction.fromHex(h), beefHex: null }),
}) {
  if (!/^[0-9a-f]{64}$/.test(String(txid || ''))) return { ok: false, error: 'Pay the 1¢ name fee first' };
  const rate = await c.bsvUsd().catch(() => 0);
  if (!(rate > 0)) return { ok: false, error: "Couldn't check the BSV price. Try again in a minute." };
  let tx = await c.tx(txid).catch(() => null);
  if (!tx && txHex) {
    try {
      const { tx: t, beefHex } = parse(String(txHex));
      if (t.id('hex') === txid && broadcast) {
        await broadcast(t, beefHex);
        tx = t;
      }
    } catch {
      tx = null;
    }
  }
  if (!tx) return { ok: false, error: "We can't see your 1¢ payment yet. Try again in a moment." };
  const script = new P2PKH().lock(address).toHex();
  const paid = tx.outputs.filter((o) => o.lockingScript.toHex() === script).reduce((s, o) => s + Number(o.satoshis), 0);
  const need = requiredSats(rate);
  if (paid < Math.floor(need * (1 - SLIPPAGE)))
    return { ok: false, error: 'That payment is less than the 1¢ name fee' };
  return { ok: true, satoshis: paid };
}

module.exports = { FEE_USD, SLIPPAGE, feeAddress, requiredSats, checkFeeTx, chain };
