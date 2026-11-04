// One claim rule for every Store payment: theme buys (themeBuys.js), theme editions (themeOrders.js), branded deposits
// (themeDeposits.js) and agent purchases (agentBuy.js) (P0, 3 Nov 2026).
//
// tx 5916dd14… (owner's $1 theme buy): our server posted the payment to ARC and marked it paid on ANNOUNCED_TO_NETWORK,
// which only says ARC holds it; WhatsOnChain had no copy for ~16 minutes. tx 07e8ae73… (25 Oct) was marked paid the
// same way and never mined. And the buyer's wallet, which had only signed (noSend), lost the change on a restart.
// Now the buyer's bWalletX broadcasts the payment itself (src/mobile/themeOrder/storePay.ts) and then claims it here:
//   1. the payment must match the quote: exactly the quoted sats to the pay address and this quote's memo;
//   2. its txid is recorded on the row BEFORE any network call, so a timeout or a second claim can't take a second
//      payment for the same quote;
//   3. it is posted to ARC with its unmined ancestors (arcSubmit): a harmless duplicate for a wallet that broadcast it,
//      the broadcast for a payer that only signed (a site visitor's wallet, an agent, an older app);
//   4. paid ONLY when the network has it: ARC SEEN_ON_NETWORK / ACCEPTED / MINED, or WhatsOnChain shows it. Otherwise
//      202 { pending: true }: the row stays 'quoted' with the txid set (no migration), and a claim retry or the
//      owner's next look (owned / mine) checks again;
//   5. a payment that matches is honoured even after its quote ran out (owner's policy, 3 Nov 2026): the money moved,
//      so the buyer gets what they paid for;
//   6. a pending payment the network never got (ARC 404/REJECTED and WhatsOnChain 404, an hour after the quote ran out)
//      is let go: its txid is cleared so the item can be bought again. If it shows up later, a claim retry records it.
'use strict';

/** A pending payment is let go only this long after its quote ran out, and only when nobody has it (recheck). */
const PENDING_DEAD_MS = 60 * 60 * 1000;
const TXID_RE = /^[0-9a-f]{64}$/;

/**
 * deps:
 *  - kind: 'buy' | 'order' | 'deposit' (the paid-txid ledger's kind);
 *  - getByQuote(quoteId), getByTxid(txid), update(id, patch): the table's store;
 *  - ledger: paidTxids (reserve);
 *  - parse(rawtx) → { tx, beefHex } (paymail.js parseIncoming); check(tx, row) → null | error code (themeOrders checkPayment);
 *  - broadcast(tx, beefHex) → arcSubmit result (never throws); network(txid) → 'seen' | 'out' | 'missing' | 'unclear';
 *  - paid(row, txid) → [200, body]: marks the row paid (and its own side effects: notify, expiry, clash);
 *  - paidBody(row) → body for a retry of a claim that already went through;
 *  - pendingBody(row, txid) → the extra fields of a 202 (pack, order…);
 *  - now(), log.
 */
function makeStoreClaim(deps) {
  const { kind, getByQuote, getByTxid, update, ledger, parse, check, paid, paidBody, pendingBody } = deps;
  const now = deps.now || (() => Date.now());
  const log = deps.log || ((...a) => console.warn(...a));
  const broadcast = deps.broadcast || (async () => null);
  const network = async (txid) => {
    try {
      return (await deps.network(txid)) || 'unclear';
    } catch {
      return 'unclear';
    }
  };

  /**
   * A pending row (status 'quoted', txid set): mark it paid if the network has it now, let it go if the network never
   * got it ('missing', an hour past its quote), else leave it pending. Returns 'paid' | 'pending' | 'dead' | 'none'.
   */
  const recheck = async (row) => {
    if (!row) return 'none';
    if (row.status !== 'quoted') return 'paid';
    if (!row.txid) return 'none';
    const st = await network(row.txid);
    if (st === 'seen') {
      await paid(row, row.txid);
      return 'paid';
    }
    if (st === 'missing' && now() > Date.parse(row.quote_expires_at) + PENDING_DEAD_MS) {
      log(`store ${kind}: pending payment ${row.txid} never reached the network; quote ${row.quote_id} released`);
      await update(row.id, { txid: null });
      return 'dead';
    }
    return 'pending';
  };

  /** fields: { identityKey, quoteId, txid, rawtx }. Returns [status, body]. */
  const claim = async ({ identityKey, quoteId, txid, rawtx }) => {
    if (!TXID_RE.test(txid)) return [400, { error: 'txid' }];
    const row = await getByQuote(quoteId);
    if (!row || row.identity_key !== identityKey) return [404, { error: 'quote_not_found' }];
    if (row.status !== 'quoted') {
      if (row.txid === txid) return [200, paidBody(row)]; // a retry of a claim that went through
      log(`store ${kind}: a second payment ${txid} for quote ${quoteId}, already paid by ${row.txid}: refund by hand`);
      return [409, { error: 'quote_used' }];
    }
    const resuming = !!row.txid && row.txid === txid;
    if (row.txid && !resuming) {
      // Another payment for this quote is out. Only one the network never got gives way.
      const r = await recheck(row);
      if (r === 'paid') return [409, { error: 'quote_used' }];
      if (r !== 'dead') return [409, { error: 'payment_pending' }];
      row.txid = null;
    }
    let tx = null;
    let beefHex = null;
    if (rawtx) {
      try {
        ({ tx, beefHex } = parse(rawtx));
      } catch {
        if (!resuming) return [400, { error: 'rawtx' }];
      }
    } else if (!resuming) return [400, { error: 'rawtx' }];
    if (tx) {
      if (tx.id('hex') !== txid) return [400, { error: 'txid_mismatch' }];
      const bad = check(tx, row);
      if (bad) return [402, { error: bad }];
    }
    if (!resuming) {
      const other = await getByTxid(txid);
      if (other && other.id !== row.id) return [409, { error: 'tx_used' }];
      // One txid, one paid record across orders, purchases and deposits (site/lib/paidTxids.js).
      if ((await ledger.reserve(txid, kind, row.id)) !== 'ok') return [409, { error: 'tx_used' }];
      if (now() > Date.parse(row.quote_expires_at))
        log(`store ${kind}: payment ${txid} for quote ${quoteId} came after the quote ran out; honoured`);
      // Recorded before any network call: from here a retry is the same payment, never a second one.
      await update(row.id, { txid });
    }
    const pendingRow = { ...row, txid };
    const sent = tx ? await Promise.resolve(broadcast(tx, beefHex)).catch((e) => ({ error: String(e) })) : null;
    const st = sent && sent.accepted ? 'seen' : await network(txid);
    if (st === 'seen') return paid(pendingRow, txid);
    const status = (sent && sent.txStatus) || st;
    log(`store ${kind}: payment ${txid} pending (${status}${sent && sent.orphan ? ', orphan' : ''})`);
    const body = { ...pendingBody(pendingRow, txid), txid, pending: true, status };
    if (sent && sent.orphan) body.orphan = true;
    // ARC refused it and nobody has it: say so (the row keeps the txid; recheck lets it go if it never lands).
    if (sent && sent.refused && st === 'missing') return [502, { ...body, error: 'broadcast_failed' }];
    return [202, body];
  };

  return { claim, recheck };
}

module.exports = { makeStoreClaim, PENDING_DEAD_MS };
