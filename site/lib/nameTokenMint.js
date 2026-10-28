// Free name token mint (owner, 28 Oct 2026; bitcoin-corp docs/PROVABLE-NAMES.md, main route).
//
// After a name is claimed, it is minted as a 1-sat one-of-one inscription and sent straight to the owner's ordinal
// address. The inscription carries the name and the owner's signed binding (name -> identity key, version n), so the
// token says, in the owner's own signature, which key the name was bound to when it was minted.
//
// Who pays: bCorp, through a funded SPONSOR key on this server (env BWALLET_NAME_SPONSOR_WIF). Why this design:
//   - no user key ever reaches the server: the user signs only the request and the binding (already public);
//   - the sponsor key holds only a small float of bCorp's sats, so the worst case of a leaked key is that float;
//   - the token output goes directly to the owner's ordinal address, so we never hold the user's token, not even
//     for one transaction.
// Off unless BWALLET_NAME_MINT_ENABLED=1 (money-ok gate). At most BWALLET_NAME_MINT_DAILY mints per process per day.
// We do not pay any indexer: the paymail server finds the holder by following spends (lib/nameTokenHolder.js).
'use strict';
const { LockingScript, P2PKH, PrivateKey, SatoshisPerKilobyte, Script, Transaction, Utils } = require('@bsv/sdk');

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const CONTENT_TYPE = 'application/bwalletx-name+json';
const ADDRESS_RE = /^1[1-9A-HJ-NP-Za-km-z]{24,34}$/;

/** The inscription body: the name and the owner's binding (enough for anyone to re-check the signature). */
const nameTokenContent = ({ alias, domain, binding }) =>
  JSON.stringify({
    p: 'bwalletx-name',
    v: 1,
    name: `${alias}@${domain}`,
    identityKey: binding.identityKey,
    binding: { seq: binding.seq, timestamp: binding.timestamp, signature: binding.signature, scheme: binding.scheme },
  });

/** 1Sat ordinal inscription envelope + P2PKH to `ordAddress`. */
function inscriptionScript(ordAddress, contentType, body) {
  const s = new Script();
  s.writeOpCode(0x00) // OP_FALSE
    .writeOpCode(0x63) // OP_IF
    .writeBin(Utils.toArray('ord', 'utf8'))
    .writeOpCode(0x51) // OP_1: content type field
    .writeBin(Utils.toArray(contentType, 'utf8'))
    .writeOpCode(0x00) // OP_0: content field
    .writeBin(Utils.toArray(body, 'utf8'))
    .writeOpCode(0x68); // OP_ENDIF
  const p2pkh = new P2PKH().lock(ordAddress);
  return new LockingScript(Script.fromHex(s.toHex() + p2pkh.toHex()).chunks);
}

/** Default chain access: the sponsor's unspent outputs and raw transactions. */
const wocChain = (f = fetch) => ({
  async utxos(address) {
    const r = await f(`${WOC}/address/${address}/unspent`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`utxo lookup failed (${r.status})`);
    return ((await r.json()) || []).map((u) => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value }));
  },
  async tx(txid) {
    const r = await f(`${WOC}/tx/${txid}/hex`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const tx = Transaction.fromHex((await r.text()).trim());
    return tx.id('hex') === txid ? tx : null;
  },
});

/** Is the free mint switched on, with a valid sponsor key? */
function sponsorKey(env = process.env) {
  if (String(env.BWALLET_NAME_MINT_ENABLED || '') !== '1') return null;
  try {
    return PrivateKey.fromWif(String(env.BWALLET_NAME_SPONSOR_WIF || '').trim());
  } catch {
    return null;
  }
}

/**
 * makeSponsor({env, chain, broadcast, now}) → mint({alias, domain, binding, ordAddress}) → {txid, origin}.
 * One mint at a time per process (no two mints spend the same sponsor output).
 */
function makeSponsor({ env = process.env, chain = wocChain(), broadcast, now = () => Date.now() } = {}) {
  let queue = Promise.resolve();
  let day = '';
  let count = 0;
  const run = async ({ alias, domain, binding, ordAddress }) => {
    const key = sponsorKey(env);
    if (!key) throw Object.assign(new Error('Free name tokens are not switched on yet'), { status: 503 });
    if (!ADDRESS_RE.test(String(ordAddress)))
      throw Object.assign(new Error('Invalid ordinal address'), { status: 400 });
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) ((day = today), (count = 0));
    const max = Number(env.BWALLET_NAME_MINT_DAILY) || 50;
    if (count >= max) throw Object.assign(new Error('Free name tokens are paused for today'), { status: 429 });
    const from = key.toAddress();
    const utxos = (await chain.utxos(from)).filter((u) => u.satoshis > 1).sort((a, b) => b.satoshis - a.satoshis);
    if (!utxos.length) throw Object.assign(new Error('The free mint has run out of funds'), { status: 503 });
    const tx = new Transaction();
    let total = 0;
    for (const u of utxos.slice(0, 3)) {
      const src = await chain.tx(u.txid);
      if (!src) continue;
      tx.addInput({
        sourceTransaction: src,
        sourceOutputIndex: u.vout,
        unlockingScriptTemplate: new P2PKH().unlock(key),
      });
      total += u.satoshis;
      if (total > 2000) break;
    }
    if (!tx.inputs.length) throw Object.assign(new Error('The free mint has run out of funds'), { status: 503 });
    tx.addOutput({
      lockingScript: inscriptionScript(ordAddress, CONTENT_TYPE, nameTokenContent({ alias, domain, binding })),
      satoshis: 1,
    });
    tx.addOutput({ lockingScript: new P2PKH().lock(from), change: true });
    await tx.fee(new SatoshisPerKilobyte(Number(env.BWALLET_NAME_MINT_SAT_PER_KB) || 100));
    await tx.sign();
    if (!broadcast) throw Object.assign(new Error('No broadcaster'), { status: 503 });
    await broadcast(tx);
    count++;
    const txid = tx.id('hex');
    return { txid, origin: `${txid}_0`, rawTx: tx.toHex() };
  };
  return (args) => {
    const p = queue.then(() => run(args));
    queue = p.catch(() => undefined);
    return p;
  };
}

module.exports = { makeSponsor, sponsorKey, inscriptionScript, nameTokenContent, wocChain, CONTENT_TYPE };
