// Paymail name prices (owner pricing, 27 Oct 2026): priced by the NAME, not by how many a key holds.
// 5+ characters: free. 4: $10. 3: $100. 1-2: $1000. Reserved / held names are never sold (paymail.js).
// Social names (.x / .gmail) are free and proof-gated. Paid in BSV at the live rate to BWALLET_NAME_FEE_ADDRESS.
// (Was 1 cent per new name, 10 Oct 2026.)
// Env (Vercel only): BWALLET_NAME_FEE_ADDRESS = the revenue address. Empty = fee OFF (nothing changes).
'use strict';
const { P2PKH, Transaction } = require('@bsv/sdk');

/** Legacy 1 cent fee (kept for callers that still quote it). */
const FEE_USD = 0.01;
/** USD by plain-alias length (owner, 27 Oct 2026). Anything longer is free. */
const PRICE_TIERS = Object.freeze({ 1: 1000, 2: 1000, 3: 100, 4: 10 });
/** The USD price of a (valid, unreserved) alias: 0 = free. Social aliases are free. */
const namePriceUsd = (alias) => {
  const a = String(alias || '').toLowerCase();
  if (a.includes('.')) return 0;
  return PRICE_TIERS[a.length] || 0;
};
/** "$1" / "1¢" for messages. */
const usdLabel = (usd) => (usd >= 1 ? `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}` : `${Math.round(usd * 100)}¢`);
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

/** Whole sats for `usd` (default 1 cent) at `rate` (USD per BSV), rounded up. */
const requiredSats = (rate, usd = FEE_USD) => Math.ceil((usd / rate) * 1e8);

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
 * `usd` is the price (default 1 cent). Returns { ok: true, satoshis, rate, usd } or { ok: false, error }.
 */
async function checkFeeTx({
  txid,
  usd = FEE_USD,
  txHex,
  address,
  c = chain,
  broadcast,
  parse = (h) => ({ tx: Transaction.fromHex(h), beefHex: null }),
}) {
  const label = usdLabel(usd);
  if (!/^[0-9a-f]{64}$/.test(String(txid || ''))) return { ok: false, error: `Pay the ${label} name fee first` };
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
  if (!tx) return { ok: false, error: `We can't see your ${label} payment yet. Try again in a moment.` };
  const script = new P2PKH().lock(address).toHex();
  const paid = tx.outputs.filter((o) => o.lockingScript.toHex() === script).reduce((s, o) => s + Number(o.satoshis), 0);
  const need = requiredSats(rate, usd);
  if (paid < Math.floor(need * (1 - SLIPPAGE)))
    return { ok: false, error: `That payment is less than the ${label} name fee` };
  return { ok: true, satoshis: paid, rate, usd };
}

module.exports = {
  FEE_USD,
  PRICE_TIERS,
  namePriceUsd,
  usdLabel,
  SLIPPAGE,
  feeAddress,
  requiredSats,
  checkFeeTx,
  chain,
};
