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
import { appendAgentLog, checkAgentSpend } from '../agents/agentAccounts';
import { SUBSCRIPTIONS_ENABLED } from '../storeBuild';
import {
  MAX_CATCH_UP,
  advanced,
  amountSats,
  amountUsd,
  dueItems,
  formatAmount,
  clearPending,
  getPending,
  getSub,
  listSubs,
  savePending,
  saveSub,
  servicePayee,
  type Payee,
  type PendingPayment,
  type Subscription,
} from './pots';

export type PayDeps = {
  /** Dollars per BSV now (0 = unknown: USD orders wait). */
  bsvUsd: number;
  /** Where to pay this payee (address, or a resolved paymail). */
  resolve: (p: Payee) => Promise<string>;
  /** Sign (don't broadcast) one tx from the pot. */
  sign: (potId: string, outputs: { address: string; sats: number }[]) => Promise<{ rawTx: string; txid: string }>;
  /** Broadcast a signed tx. Must be idempotent: the same raw tx again is fine (already known / mined). */
  broadcast: (rawTx: string) => Promise<void>;
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

/** Pay everything due. Concurrent calls share one run, so a quick resume can't pay twice. */
export const payDue = (deps: PayDeps, now = Date.now()): Promise<PayOutcome[]> =>
  (running ??= run(deps, now).finally(() => (running = null)));

const fail = (s: Subscription, reason: string, deps: PayDeps, lowFunds = false): PayOutcome => {
  saveSub({ ...s, lastError: reason, status: lowFunds ? 'lowFunds' : s.status });
  deps.notify?.(`Payment to ${s.payee.name} didn’t go through`, reason);
  return { id: s.id, ok: false, reason };
};

async function run(deps: PayDeps, now: number): Promise<PayOutcome[]> {
  const cap = deps.cap ?? MAX_CATCH_UP;
  const subsOn = deps.subsOn ?? SUBSCRIPTIONS_ENABLED;
  const out: PayOutcome[] = [];
  for (let s of listSubs()) {
    const pending = getPending(s.id);
    if (pending) {
      const r = await settlePending(s, pending, deps, now);
      out.push(r);
      if (!r.ok) continue; // still unsettled: never sign anything new for this order
      s = getSub(s.id) ?? s;
    }
    let plan = dueItems(s, now, cap);
    if (!plan.missed) continue;
    if (s.payee.service && (!subsOn || !servicePayee(s.payee.service))) {
      out.push(fail(s, 'This service subscription isn’t available in this version', deps));
      continue;
    }
    if (plan.needsConfirm) {
      const all = deps.confirm ? await deps.confirm(s, plan.missed).catch(() => false) : false;
      if (all) plan = dueItems(s, now, plan.missed);
      else {
        // Skip the older periods; pay only the most recent `cap`.
        s = saveSub({ ...s, periodIndex: s.periodIndex + plan.missed - cap });
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
    const sats = amountSats(s.amount, deps.bsvUsd);
    if (sats === null) {
      out.push({ id: s.id, ok: false, reason: 'No price right now' }); // try again next open, no alert
      continue;
    }
    const usd = amountUsd(s.amount, deps.bsvUsd) * count;
    const gate = checkAgentSpend(s.potId, usd, now);
    if (!gate.ok) {
      out.push(fail(s, gate.reason, deps));
      continue;
    }
    let address: string;
    try {
      address = await deps.resolve(s.payee);
    } catch (e) {
      out.push(fail(s, e instanceof Error ? e.message : String(e), deps));
      continue;
    }
    let signed: { rawTx: string; txid: string };
    try {
      signed = await deps.sign(
        s.potId,
        Array.from({ length: count }, () => ({ address, sats })),
      );
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      out.push(fail(s, m, deps, /not enough|insufficient/i.test(m)));
      continue;
    }
    const p: PendingPayment = {
      subId: s.id,
      potId: s.potId,
      periodIndex: s.periodIndex,
      count,
      dueTimes: plan.due,
      ...signed,
      usd,
      at: now,
    };
    savePending(p); // before the broadcast: from here on these periods are only ever paid by this tx
    out.push(await settlePending(s, p, deps, now));
  }
  return out;
}

/** Broadcast a recorded payment (again, if it may already be out) and, once accepted, mark its periods paid. */
async function settlePending(s: Subscription, p: PendingPayment, deps: PayDeps, now: number): Promise<PayOutcome> {
  try {
    await deps.broadcast(p.rawTx);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (!/already|duplicate/i.test(m)) {
      // Unknown outcome: keep the record and retry this exact tx next time.
      saveSub({ ...s, lastError: m });
      deps.notify?.(`Payment to ${s.payee.name} is waiting to go through`, m);
      return { id: s.id, ok: false, reason: m };
    }
  }
  // Already advanced past these periods (crash after saveSub, before clearPending)? Then only clear.
  const cur = getSub(s.id) ?? s;
  if (cur.periodIndex === p.periodIndex) {
    const next = advanced(cur, p.count);
    // The user may have paused or cancelled while this was paying: keep that.
    saveSub({ ...next, status: cur.status === 'paused' || cur.status === 'cancelled' ? cur.status : next.status });
    appendAgentLog(s.potId, {
      at: now,
      action: 'sub-pay',
      detail: `Paid ${s.payee.name} ${formatAmount(s.amount)}${p.count > 1 ? ` × ${p.count}` : ''}`,
      usd: p.usd,
      txid: p.txid,
    });
  }
  clearPending(s.id);
  return { id: s.id, ok: true, count: p.count, txid: p.txid };
}
