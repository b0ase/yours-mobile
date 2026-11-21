/**
 * Pay-on-open (POTS-SUBSCRIPTIONS-PLAN.md v1). On app open / resume, every active standing order that is due
 * is paid from its pot: through checkAgentSpend (pot Stop, Stop all, daily cap), then one tx per order with
 * one output per period owed. Missed periods catch up to MAX_CATCH_UP at once; more asks first (declining
 * skips the older ones). Pure over its deps, so it is unit-tested without a wallet.
 *
 * Crash safety: each payment is signed, then recorded as pending (sub, periods, raw tx, txid), then broadcast,
 * then the sub is advanced and the pending record cleared. A run that finds a pending record rebroadcasts that
 * same raw tx (idempotent: one txid) and marks its periods paid; it never signs a fresh tx for them.
 */
import { appendAgentLog, checkAgentSpend, getAgentLog } from '../agents/agentAccounts';
import { serialSpend } from '../agents/spendQueue';
import { SUBSCRIPTIONS_ENABLED, PNEE_POTS_ENABLED } from '../storeBuild';
import { isPaused } from '../config/killSwitch';
import {
  MAX_CATCH_UP,
  advanced,
  amountPnee,
  amountSats,
  amountUsdKnown,
  dueItems,
  formatAmount,
  claimPeriod,
  clearPending,
  getPending,
  holdsClaim,
  getSub,
  isPayingPot,
  listSubs,
  releaseClaim,
  savePending,
  saveSub,
  servicePayee,
  type Payee,
  type PendingPayment,
  type Subscription,
} from './pots';
import { PayeeReviewError, legacyPin, scheduledOutputsRefusal, type PayeeDestination } from './payeeBinding';

/** A hung broadcast would hold the spend queue, and with it every agent and CLI spend on the device. */
export const BROADCAST_TIMEOUT_MS = 30_000;

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The network took too long to answer; will check and retry')), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

// PNEE pots are bWalletX only (storeBuild.ts PNEE_POTS_ENABLED): the wording is not in a store bundle.
const PNEE_NO_SEND = PNEE_POTS_ENABLED
  ? 'PNEE payments can’t be sent from this device'
  : 'This payment can’t be sent from this device';

export type PayDeps = {
  /**
   * The spending kill switch (config/killSwitch.ts). While it says paused, nothing is signed or broadcast; orders
   * wait and pay on a later run (b-Aware report, 24 Oct 2026: pot payments bypassed the pause). Default: the switch.
   */
  spendingPaused?: () => Promise<boolean>;
  /** Dollars per BSV now (0 = unknown: USD orders wait). */
  bsvUsd: number;
  /**
   * Where to pay this payee (address, or a resolved and verified paymail). Throws PayeeReviewError when the
   * destination doesn't verify (changed key or address, bad binding): the order is flagged needsReview and not paid.
   */
  resolve: (p: Payee) => Promise<string | PayeeDestination>;
  /** Sign (don't broadcast) one tx from the pot. */
  sign: (
    potId: string,
    outputs: { address: string; sats: number }[],
    memo?: string,
  ) => Promise<{ rawTx: string; txid: string }>;
  /** Broadcast a signed tx. Must be idempotent: the same raw tx again is fine. Any error is an unsure result. */
  broadcast: (rawTx: string) => Promise<void>;
  /**
   * Is this txid already on the network or mined (potSend potTxKnown)? Asked before a waiting payment is posted again:
   * a tx already mined can be answered REJECTED on a re-post (its inputs are spent, by itself), which must not leave it
   * stuck. Absent, or an error or timeout: not known (the same tx is posted again).
   */
  txKnown?: (txid: string) => Promise<boolean>;
  /**
   * Sign (don't broadcast) one PNEE transfer from a PNEE pot: `units` PNEEs (1 unit = 1¢) per output. Absent = PNEE
   * orders wait. rawTx is what broadcastPnee takes.
   */
  signPnee?: (
    potId: string,
    outputs: { address: string; units: number }[],
    memo?: string,
  ) => Promise<{ rawTx: string; txid: string }>;
  /** Broadcast a signed PNEE transfer (and hand it to the token overlay). Idempotent like broadcast. */
  broadcastPnee?: (rawTx: string) => Promise<void>;
  /** Bound on one broadcast (default BROADCAST_TIMEOUT_MS). A timeout is an unsure result: the record stays. */
  broadcastTimeoutMs?: number;
  /** More than MAX_CATCH_UP periods are owed: pay them all? */
  confirm?: (s: Subscription, missed: number) => Promise<boolean>;
  notify?: (title: string, body: string) => void;
  /** Service subscriptions allowed (false in a store build). */
  subsOn?: boolean;
  cap?: number;
};

export type PayOutcome =
  | { id: string; ok: true; count: number; txid: string }
  | { id: string; ok: false; reason: string };

let running: Promise<PayOutcome[]> | null = null;

/** A Web Locks API, as navigator.locks offers it (shared by every tab, popup and side panel of one origin). */
type Locks = { request: <T>(name: string, options: object, cb: () => Promise<T>) => Promise<T> };
export const PAY_LOCK = 'bwx-pots-pay';
/**
 * One pay run at a time on the device, not just in this tab (b-Aware row 233, BL-01): `running` and serialSpend live
 * in one JS realm, so two tabs (or the popup and a tab) each paid the same period with a different tx. A run that
 * waited for the lock starts from what is in storage, so it finds the period paid. Without navigator.locks, the
 * per-period claim in run() is the guard. A lock that can't be taken rejects: nothing is paid (fail closed).
 */
const acrossTabs = <T>(fn: () => Promise<T>): Promise<T> => {
  const locks = (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;
  return locks && typeof locks.request === 'function' ? locks.request(PAY_LOCK, {}, fn) : fn();
};

const IN_OTHER_TAB = 'Being paid in another window';

/** Pay everything due. Concurrent calls share one run, and tabs take turns, so a quick resume can't pay twice. */
export const payDue = (deps: PayDeps, now = Date.now()): Promise<PayOutcome[]> =>
  (running ??= acrossTabs(() => run(deps, now)).finally(() => (running = null)));

/** Still payable right now, by what is in storage (not a snapshot): the user may have paused or cancelled. */
const live = (id: string): Subscription | null => {
  const cur = getSub(id);
  return cur && (cur.status === 'active' || cur.status === 'lowFunds') ? cur : null;
};

/** Patch only the fields this run owns onto a fresh read; never write a snapshot back. */
const patch = (id: string, f: (cur: Subscription) => Partial<Subscription>): Subscription | null => {
  const cur = getSub(id);
  return cur ? saveSub({ ...cur, ...f(cur) }) : null;
};

const fail = (s: Subscription, reason: string, deps: PayDeps, lowFunds = false): PayOutcome => {
  // lastError always; status only moves between active and lowFunds, never out of paused/cancelled/ended.
  patch(s.id, (cur) => ({
    lastError: reason,
    ...(lowFunds && (cur.status === 'active' || cur.status === 'lowFunds') ? { status: 'lowFunds' as const } : {}),
  }));
  deps.notify?.(`Payment to ${s.payee.name} didn’t go through`, reason);
  return { id: s.id, ok: false, reason };
};

/** This payment is on the pot's log (and so on its day ledger) already. */
const booked = (potId: string, txid: string) =>
  getAgentLog(potId).some((e) => e.action === 'sub-pay' && e.txid === txid);

const paused = (deps: PayDeps) => (deps.spendingPaused ?? (() => isPaused('spending')))().catch(() => true);

async function run(deps: PayDeps, now: number): Promise<PayOutcome[]> {
  // The pause stops pot payments too: no new signature and no broadcast of an already-signed one.
  if (await paused(deps)) return [];
  const cap = deps.cap ?? MAX_CATCH_UP;
  const subsOn = deps.subsOn ?? SUBSCRIPTIONS_ENABLED;
  const out: PayOutcome[] = [];
  /**
   * Pots whose waiting payment got an unsure broadcast in this run (an error or a timeout, record kept): the tx may be
   * out, and a new signature from the pot could pick the same coins (they come from the indexer), so one order would be
   * refused and pending forever. Nothing more is signed from such a pot in this run; its orders wait for the next.
   */
  const unsure = new Set<string>();
  /** This run, as the owner of a per-period claim (pots.ts claimPeriod): the cross-tab guard without navigator.locks. */
  const runId = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // Orders with a waiting payment first, so every unsure pot is known before any new signature (stable order otherwise).
  const ids = listSubs()
    .map((x) => x.id)
    .sort((a, b) => Number(!getPending(a)) - Number(!getPending(b)));
  for (const id of ids) {
    let s = getSub(id);
    if (!s) continue;
    const pending = getPending(id);
    if (pending) {
      // b-Aware 25 Oct 2026: a waiting payment is only sent while its order is still live and its pot allows it.
      // Cancelled, paused or ended, or the pot stopped: keep the record (nothing new is signed for it), don't send.
      // Re-read, cap check and broadcast-and-log as one queued step, like the fresh branch below: the log entry lands
      // only after the broadcast, so a spend running beside this one could otherwise pass the same daily cap.
      const r = await serialSpend(async (): Promise<PayOutcome> => {
        const cur = live(id);
        // Gated against the pot the signed tx spends (pending.potId), not the order's current pot (moveSub). Already
        // booked (a kill after the log, before the record was cleared): its dollars are on the cap already, so only
        // Stop and Stop all are checked again.
        const usd = booked(pending.potId, pending.txid) ? 0 : pending.usd;
        const gate = cur ? checkAgentSpend(pending.potId, usd, now) : null;
        if (!cur || !gate?.ok) {
          return {
            id,
            ok: false,
            reason: gate && !gate.ok ? gate.reason : 'Stopped: the waiting payment was not sent',
          };
        }
        return settlePending(cur, pending, deps, now, unsure, true);
      });
      out.push(r);
      if (!r.ok) continue; // still unsettled: never sign anything new for this order
    }
    // Re-read: an earlier order in this run may have taken a while, and the user may have paused or cancelled.
    s = live(id);
    if (!s) continue;
    if (s.needsReview) {
      // Waiting for the user to confirm a new destination: never pay automatically, don't re-alert every open.
      if (dueItems(s, now, cap).missed) out.push({ id: s.id, ok: false, reason: s.needsReview.reason });
      continue;
    }
    let plan = dueItems(s, now, cap);
    if (!plan.missed) continue;
    if (s.catchUp === 'latest' && plan.missed > 1) {
      // App subscriptions never stack up: skip every missed period but the latest, then pay that one once.
      const skip = plan.missed - 1;
      s = patch(s.id, (cur) => ({ periodIndex: cur.periodIndex + skip }))!;
      appendAgentLog(s.potId, {
        at: now,
        action: 'sub-skip',
        detail: `Skipped ${skip} missed payment${skip === 1 ? '' : 's'} to ${s.payee.name}`,
        usd: 0,
      });
      plan = dueItems(s, now, 1);
    }
    if (s.payee.service && (!subsOn || !servicePayee(s.payee.service))) {
      out.push(fail(s, 'This service subscription isn’t available in this version', deps));
      continue;
    }
    if (plan.needsConfirm) {
      const all = deps.confirm ? await deps.confirm(s, plan.missed).catch(() => false) : false;
      if (!live(s.id)) continue; // paused or cancelled while we asked
      if (all) plan = dueItems(s, now, plan.missed);
      else {
        // Skip the older periods; pay only the most recent `cap`.
        const skip = plan.missed - cap;
        s = patch(s.id, (cur) => ({ periodIndex: cur.periodIndex + skip }))!;
        appendAgentLog(s.potId, {
          at: now,
          action: 'sub-skip',
          detail: `Skipped ${plan.missed - cap} missed payments to ${s.payee.name}`,
          usd: 0,
        });
        plan = dueItems(s, now, cap);
      }
    }
    const count = plan.due.length;
    const pnee = s.amount.currency === 'PNEE';
    const units = pnee ? amountPnee(s.amount) : null;
    const sats = pnee ? null : amountSats(s.amount, deps.bsvUsd);
    if (pnee && (units === null || !deps.signPnee || !deps.broadcastPnee)) {
      out.push(fail(s, PNEE_NO_SEND, deps));
      continue;
    }
    // No rate: a dollar order can't be priced in sats, and a sats order can't be priced in dollars for the cap. Both
    // wait (b-Aware row 267: a sats order was gated, and booked, as $0). Try again next open, no alert.
    const each = amountUsdKnown(s.amount, deps.bsvUsd);
    if (!pnee && (sats === null || each === null)) {
      out.push({ id: s.id, ok: false, reason: 'No price right now' });
      continue;
    }
    const usd = (each ?? 0) * count;
    // Pot only, never the main balance: no fallback if the pot is gone or isn't a pot.
    if (!isPayingPot(s.potId)) {
      out.push(fail(s, 'Only a pot can pay. Pick a pot for this subscription.', deps));
      continue;
    }
    // The plan (count, usd, due times) is for these periods only: if they were paid while this order waited for its
    // turn (another tab or run), the step below pays nothing rather than paying the next periods early.
    const from = s.periodIndex;
    // Cap check, sign and log as one step, queued with agent spends so the two can't both pass the daily cap.
    const r = await serialSpend(async (): Promise<PayOutcome | null> => {
      let s = live(id);
      if (!s || s.periodIndex !== from) return null;
      // Another tab signed and recorded these periods already: its record is settled on a later run, never re-signed.
      if (getPending(id)) return { id, ok: false, reason: IN_OTHER_TAB };
      // A payment from this pot is unsure in this run: its coins may be in flight. Left for the next run, no alert.
      if (unsure.has(s.potId))
        return { id: s.id, ok: false, reason: 'Waiting for an earlier payment from this pot to go through' };
      const gate = checkAgentSpend(s.potId, usd, now);
      if (!gate.ok) {
        return fail(s, gate.reason, deps);
      }
      let address: string;
      try {
        const d = await deps.resolve(s.payee);
        const dest = typeof d === 'string' ? { address: d } : d;
        address = dest.address;
        // A paymail order with no pinned address (older order, or an app subscription's first payment): pin only
        // what it already paid or was approved for; otherwise stop and ask once (payeeBinding.ts legacyPin).
        if (s.payee.paymail && !s.payee.pinnedAddress) {
          const pins = legacyPin(s, dest);
          s =
            patch(s.id, (cur) => {
              const { pinOnFirstPay: _first, ...payee } = cur.payee;
              return { payee: { ...payee, ...pins } };
            }) ?? s;
        }
      } catch (e) {
        if (e instanceof PayeeReviewError) {
          const reason = e.message;
          patch(s.id, () => ({
            lastError: reason,
            needsReview: {
              reason,
              at: now,
              ...(e.servedKey ? { servedKey: e.servedKey } : {}),
              ...(e.servedAddress ? { servedAddress: e.servedAddress } : {}),
              ...(e.legacy ? { legacy: true } : {}),
            },
          }));
          deps.notify?.(`Check who ${s.payee.name} is paid to`, reason);
          return { id: s.id, ok: false, reason };
        }
        return fail(s, e instanceof Error ? e.message : String(e), deps);
      }
      // Last look before anything is signed: a Pause or Cancel tapped while resolving stops it here.
      const fresh = live(s.id);
      if (!fresh || fresh.periodIndex !== s.periodIndex) return null;
      // The outputs pay the checked destination exactly the scheduled amount, nothing more and nowhere else.
      const perPeriod = pnee ? units! : sats!;
      const outputs = Array.from({ length: count }, () => ({ address, amount: perPeriod }));
      const refused = scheduledOutputsRefusal(outputs, address, perPeriod, count);
      if (refused) return fail(s, refused, deps);
      // Claim these periods before signing, so a tab that starts now sees them taken (b-Aware row 233).
      if (!claimPeriod(id, s.periodIndex, runId, now)) return { id, ok: false, reason: IN_OTHER_TAB };
      try {
        let signed: { rawTx: string; txid: string };
        try {
          signed = pnee
            ? await deps.signPnee!(
                s.potId,
                outputs.map((o) => ({ address: o.address, units: o.amount })),
                s.memo,
              )
            : await deps.sign(
                s.potId,
                outputs.map((o) => ({ address: o.address, sats: o.amount })),
                s.memo,
              );
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          return fail(s, m, deps, /not enough|insufficient/i.test(m));
        }
        // Signed but not sent: if another tab took these periods meanwhile (claim lost, or its record is there), this tx
        // is dropped unsent. Nothing was broadcast and pot signing holds no coins, so nothing is lost.
        if (!holdsClaim(s.id, runId) || getPending(s.id)) return { id: s.id, ok: false, reason: IN_OTHER_TAB };
        const p: PendingPayment = {
          subId: s.id,
          potId: s.potId,
          periodIndex: s.periodIndex,
          count,
          dueTimes: plan.due,
          ...signed,
          usd,
          at: now,
          to: address,
          ...(pnee ? { unit: 'PNEE' as const } : { sats: sats! * count }),
        };
        savePending(p); // before the broadcast: from here on these periods are only ever paid by this tx
        return await settlePending(s, p, deps, now, unsure, false);
      } finally {
        releaseClaim(id, runId);
      }
    });
    if (r) out.push(r);
  }
  return out;
}

/**
 * Broadcast a recorded payment (again, if it may already be out) and, once accepted, mark its periods paid. An unsure
 * result (error or timeout, record kept) adds the pot to `unsure`: nothing more is signed from it in this run.
 */
async function settlePending(
  s: Subscription,
  p: PendingPayment,
  deps: PayDeps,
  now: number,
  unsure: Set<string>,
  /** A waiting payment from an earlier run (not a tx just signed): its status is asked for first. */
  repost: boolean,
): Promise<PayOutcome> {
  // Checked again at broadcast time: the pause may have been switched on while this order was resolving or signing.
  if (await paused(deps)) return { id: s.id, ok: false, reason: 'Spending is paused' };
  const ms = deps.broadcastTimeoutMs ?? BROADCAST_TIMEOUT_MS;
  // A waiting payment the network already has (seen or mined) is paid: settled without posting it again. A re-post of a
  // mined tx can be answered REJECTED (its inputs are spent, by itself), which would leave it waiting for good.
  const known =
    repost && deps.txKnown
      ? await withTimeout(deps.txKnown(p.txid), ms).then(
          (k) => k === true,
          () => false,
        )
      : false;
  // Otherwise the SAME signed tx is posted again (same txid, same signature): idempotent at the network, accepted once,
  // so it can never pay twice. A fresh signature for these periods is what could, and none is made while the record
  // exists. Any error or a timeout is an unsure result: the record stays.
  if (!known)
    try {
      if (p.unit === 'PNEE') {
        if (!deps.broadcastPnee) throw new Error(PNEE_NO_SEND);
        await withTimeout(deps.broadcastPnee(p.rawTx), deps.broadcastTimeoutMs ?? BROADCAST_TIMEOUT_MS);
      } else await withTimeout(deps.broadcast(p.rawTx), deps.broadcastTimeoutMs ?? BROADCAST_TIMEOUT_MS);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      // Unknown outcome: keep the record and retry this exact tx next time; no more signing from this pot in this run.
      unsure.add(p.potId);
      patch(s.id, () => ({ lastError: m }));
      deps.notify?.(`Payment to ${s.payee.name} is waiting to go through`, m);
      return { id: s.id, ok: false, reason: m };
    }
  // Booked once per txid, whichever run settles it, before the order advances: a run killed after the advance but
  // before the log left the payment off the cap for good, so its cap space was spent twice (b-Aware row 272).
  if (!booked(p.potId, p.txid))
    appendAgentLog(p.potId, {
      at: now,
      action: 'sub-pay',
      detail: `Paid ${s.payee.name} ${formatAmount(s.amount)}${p.count > 1 ? ` × ${p.count}` : ''}`,
      usd: p.usd,
      txid: p.txid,
    });
  // Already advanced past these periods (crash after saveSub, before clearPending)? Then only clear.
  const cur = getSub(s.id) ?? s;
  if (cur.periodIndex === p.periodIndex) {
    const next = advanced(cur, p.count);
    // The user may have paused or cancelled while this was paying: keep that.
    saveSub({
      ...next,
      status: cur.status === 'paused' || cur.status === 'cancelled' ? cur.status : next.status,
      lastReceipt: { at: now, txid: p.txid, usd: p.usd, sats: p.sats ?? 0, ...(p.to ? { to: p.to } : {}) },
    });
  }
  clearPending(s.id);
  return { id: s.id, ok: true, count: p.count, txid: p.txid };
}
