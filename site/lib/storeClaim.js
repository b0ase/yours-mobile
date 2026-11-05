// One claim rule for every Store payment: theme buys (themeBuys.js), theme editions (themeOrders.js), branded deposits
// (themeDeposits.js) and agent purchases (agentBuy.js) (P0, 3 Nov 2026; review 4 Nov 2026).
//
// tx 5916dd14… (owner's $1 theme buy): our server posted the payment to ARC and marked it paid on ANNOUNCED_TO_NETWORK,
// which only says ARC holds it; WhatsOnChain had no copy for ~16 minutes. tx 07e8ae73… (25 Oct) was marked paid the
// same way and never mined. And the buyer's wallet, which had only signed (noSend), lost the change on a restart.
// Now the buyer's bWalletX tells us the txid first (claim intent), broadcasts the payment itself
// (src/mobile/themeOrder/storePay.ts) and then claims it here:
//   1. the payment must match the quote: exactly the quoted sats to the pay address and this quote's memo, and its
//      input scripts must verify when the wallet sent their parents (BEEF): a forged tx can't hold a slug;
//   2. its txid is recorded on the row BEFORE any network call, and only if the row has no txid yet (a conditional
//      write): two claims with different txids can't both take one quote;
//   3. a claim INTENT stops there: nothing is posted anywhere (the wallet broadcasts next), but from now on the Store
//      knows the payment and re-checks it on its own (owned / mine / status), so the claim no longer depends on the
//      buyer's device;
//   4. a claim posts it to ARC with its unmined ancestors (arcSubmit): a harmless duplicate for a wallet that
//      broadcast it, the broadcast for a payer that only signed (a site visitor's wallet, an agent);
//   5. paid ONLY when the network has it: ARC SEEN_ON_NETWORK / ACCEPTED / MINED, or WhatsOnChain shows it. Otherwise
//      202 { pending: true }: the row stays 'quoted' with the txid set (no migration);
//   6. a claim with no rawtx (the wallet lost its copy: a reinstall, a restore) is accepted once the network has the
//      tx: the server reads it from WhatsOnChain and checks it like any other;
//   7. a payment that matches is honoured even after its quote ran out (owner's policy, 3 Nov 2026);
//   8. a pending payment the network never got (ARC 404/REJECTED and WhatsOnChain 404, an hour after the quote ran out
//      AND an hour after its txid was recorded: review 16 F7, an outbox retry pays an old quote) is let go: its txid
//      is cleared so the item can be bought again. If it shows up later, a claim records it;
//   9. one item, one payment (b-Aware shdx, 29 Oct 2026): a quote taken before the item was bought stayed payable after
//      it, so the buyer could be charged twice. `conflict(row, txid)` (the seller's rule: already owned, or another
//      payment for it on its way) is asked before the txid is recorded, so a claim intent is refused and the wallet
//      never broadcasts, and asked again right after the write: when two claims for the same item land together,
//      neither is told to go on while the other holds a txid (at worst both are refused and nothing is paid).
'use strict';

/** A pending payment is let go only this long after its quote ran out, and only when nobody has it (recheck). */
const PENDING_DEAD_MS = 60 * 60 * 1000;
/** owned / mine re-check pending rows in parallel, and give up on the slow ones after this long (maxDuration 30 s). */
const RECHECK_BUDGET_MS = 12_000;
const TXID_RE = /^[0-9a-f]{64}$/;

/**
 * Do the input scripts of `tx` verify? Only when every input carries its source transaction (the wallet's BEEF); a bare
 * raw tx can't be checked here and passes (its outputs and memo are still checked, and only the network marks it paid).
 */
async function scriptsVerify(tx) {
  const inputs = tx.inputs || [];
  if (!inputs.length || inputs.some((i) => !i.sourceTransaction)) return true;
  try {
    return (await tx.verify('scripts only')) === true;
  } catch {
    return false;
  }
}

/**
 * deps:
 *  - kind: 'buy' | 'order' | 'deposit' (the paid-txid ledger's kind);
 *  - getByQuote(quoteId), getByTxid(txid), update(id, patch): the table's store;
 *  - setTxidIfEmpty(id, txid) → true when this call set it (PATCH … txid=is.null); optional, update() otherwise;
 *  - ledger: paidTxids (reserve);
 *  - parse(rawtx) → { tx, beefHex } (paymail.js parseIncoming); check(tx, row) → null | error code (themeOrders checkPayment);
 *  - broadcast(tx, beefHex) → arcSubmit result (never throws); network(txid) → 'seen' | 'out' | 'missing' | 'unclear';
 *  - fetchTx(txid) → Transaction (WhatsOnChain), for a claim without rawtx once the network has it; optional;
 *  - verify(tx) → boolean (default scriptsVerify);
 *  - paid(row, txid) → [200, body]: marks the row paid (and its own side effects: notify, expiry, clash);
 *  - paidBody(row) → body for a retry of a claim that already went through;
 *  - pendingBody(row, txid) → the extra fields of a 202 (pack, order…);
 *  - conflict(row, txid) → null | [status, body]: why this buyer may not pay for this row's item now (rule 9); optional;
 *  - now(), log.
 */
function makeStoreClaim(deps) {
  const { kind, getByQuote, getByTxid, update, ledger, parse, check, paid, paidBody, pendingBody } = deps;
  const now = deps.now || (() => Date.now());
  const log = deps.log || ((...a) => console.warn(...a));
  const broadcast = deps.broadcast || (async () => null);
  const verify = deps.verify || scriptsVerify;
  const network = async (txid) => {
    try {
      return (await deps.network(txid)) || 'unclear';
    } catch {
      return 'unclear';
    }
  };
  const setTxid = async (row, txid) => {
    if (typeof deps.setTxidIfEmpty === 'function') return (await deps.setTxidIfEmpty(row.id, txid)) === true;
    await update(row.id, { txid });
    return true;
  };
  const conflict = async (row, txid) =>
    typeof deps.conflict === 'function' ? ((await deps.conflict(row, txid)) ?? null) : null;
  /** A claim refused by rule 9. Without intent the payer may have broadcast already: say so for a refund by hand. */
  const refuse = (verdict, { quoteId, txid, intent }) => {
    if (!intent)
      log(
        `store ${kind}: payment ${txid} for quote ${quoteId} refused (${verdict[1]?.error}); refund by hand if it was sent`,
      );
    return verdict;
  };

  /**
   * A pending row (status 'quoted', txid set): mark it paid if the network has it now; let it go if the network never
   * got it ('missing', an hour past its quote). Returns 'paid' | 'pending' | 'missing' (not seen anywhere right now,
   * still inside the hour) | 'dead' (let go) | 'none'.
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
    if (st !== 'missing') return 'pending';
    // Dated from the later of the quote running out and the txid being recorded (the paid-txid ledger's time): a
    // payment recorded a minute ago on a two-hour-old quote is not dead. Can't tell when: not dead (fail closed).
    const recorded =
      typeof ledger.reservedAt === 'function'
        ? await Promise.resolve(ledger.reservedAt(row.txid)).catch(() => Infinity)
        : undefined;
    const since = Math.max(Date.parse(row.quote_expires_at), recorded ?? 0);
    if (now() > since + PENDING_DEAD_MS) {
      log(`store ${kind}: pending payment ${row.txid} never reached the network; quote ${row.quote_id} released`);
      await update(row.id, { txid: null });
      return 'dead';
    }
    return 'missing';
  };

  /**
   * Re-check many pending rows at once, inside RECHECK_BUDGET_MS; the slow ones are simply checked next time.
   * `each(row, verdict)` hears each verdict that came back in time.
   */
  const recheckAll = async (rows, each) => {
    const all = Promise.allSettled(
      (rows || []).map((r) =>
        recheck(r).then((v) => {
          if (each) each(r, v);
          return v;
        }),
      ),
    );
    await Promise.race([all, new Promise((ok) => setTimeout(ok, deps.recheckBudgetMs ?? RECHECK_BUDGET_MS))]);
  };

  /** fields: { identityKey, quoteId, txid, rawtx, intent }. Returns [status, body]. */
  const claim = async ({ identityKey, quoteId, txid, rawtx, intent = false }) => {
    if (!TXID_RE.test(txid)) return [400, { error: 'txid' }];
    const row = await getByQuote(quoteId);
    if (!row || row.identity_key !== identityKey) return [404, { error: 'quote_not_found' }];
    if (row.status !== 'quoted') {
      if (row.txid === txid) return [200, paidBody(row)]; // a retry of a claim that went through
      log(`store ${kind}: a second payment ${txid} for quote ${quoteId}, already paid by ${row.txid}: refund by hand`);
      return [409, { error: 'quote_used' }];
    }
    let resuming = !!row.txid && row.txid === txid;
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
    } else if (!resuming) {
      // No copy from the wallet: only a payment the network already has, read back from the network, is taken.
      if (intent || typeof deps.fetchTx !== 'function') return [400, { error: 'rawtx' }];
      if ((await network(txid)) !== 'seen')
        return [202, { ...pendingBody(row, txid), txid, pending: true, unverified: true }];
      tx = await Promise.resolve(deps.fetchTx(txid)).catch(() => null);
      if (!tx) return [202, { ...pendingBody(row, txid), txid, pending: true, unverified: true }];
    }
    if (tx) {
      if (tx.id('hex') !== txid) return [400, { error: 'txid_mismatch' }];
      const bad = check(tx, row);
      if (bad) return [402, { error: bad }];
      if (!(await verify(tx))) return [402, { error: 'bad_signature' }];
    }
    if (!resuming) {
      const other = await getByTxid(txid);
      if (other && other.id !== row.id) return [409, { error: 'tx_used' }];
      // Rule 9: already owned, or another payment for the item on its way: nothing is recorded or sent.
      const before = await conflict(row, txid);
      if (before) return refuse(before, { quoteId, txid, intent });
      // One txid, one paid record across orders, purchases and deposits (site/lib/paidTxids.js).
      if ((await ledger.reserve(txid, kind, row.id)) !== 'ok') return [409, { error: 'tx_used' }];
      if (now() > Date.parse(row.quote_expires_at))
        log(`store ${kind}: payment ${txid} for quote ${quoteId} came after the quote ran out; honoured`);
      // Recorded before any network call, and only if no other txid got there first.
      if (!(await setTxid(row, txid))) {
        const again = await getByQuote(quoteId);
        if (!again || again.txid !== txid) return [409, { error: 'payment_pending' }];
      }
      // Rule 9 again, now that this txid is visible: a claim for the same item that wrote at the same moment sees this
      // one, and this one sees it. Whoever sees another gives way and clears its txid, before anything is sent.
      const after = await conflict({ ...row, txid }, txid);
      if (after) {
        await update(row.id, { txid: null });
        return refuse(after, { quoteId, txid, intent });
      }
      resuming = true;
    }
    const pendingRow = { ...row, txid };
    if (intent) return [202, { ...pendingBody(pendingRow, txid), txid, pending: true, intent: true }];
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

  return { claim, recheck, recheckAll };
}

/**
 * In-app Store clients send the protocol they speak (src/mobile/themeOrder/api.ts STORE_PROTOCOL). Older bWalletX
 * builds (5.2.49 and earlier) don't: they sign noSend, let us broadcast and lose the change on a reload, so they are
 * asked to update before they can quote or claim (review 4 Nov 2026, F12). Agents and the site's deposit form are
 * not in-app clients and aren't gated.
 */
const STORE_PROTOCOL = '2';
/**
 * An old app shows `MESSAGES[error] ?? error`, and its MESSAGES has no entry for a new code, so the body carries the
 * sentence itself (06c L3); `code` is for anything that reads codes.
 */
const UPDATE_REQUIRED_TEXT = 'Please update bWalletX to the latest version to buy from the Store.';
const protocolError = (body) =>
  String(((body || {}).fields || {}).store || '') === STORE_PROTOCOL
    ? null
    : [426, { error: UPDATE_REQUIRED_TEXT, code: 'update_required' }];

module.exports = {
  makeStoreClaim,
  scriptsVerify,
  protocolError,
  PENDING_DEAD_MS,
  RECHECK_BUDGET_MS,
  STORE_PROTOCOL,
  UPDATE_REQUIRED_TEXT,
};
