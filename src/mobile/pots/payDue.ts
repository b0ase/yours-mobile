/**
 * Pay-on-open (POTS-SUBSCRIPTIONS-PLAN.md v1). On app open / resume, every active standing order that is due
 * is paid from its pot: through checkAgentSpend (pot Stop, Stop all, daily cap), then one tx per order with
 * one output per period owed. Missed periods catch up to MAX_CATCH_UP at once; more asks first (declining
 * skips the older ones). Pure over its deps, so it is unit-tested without a wallet.
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
  getSub,
  listSubs,
  saveSub,
  servicePayee,
  type Payee,
  type Subscription,
} from './pots';

export type PayDeps = {
  /** Dollars per BSV now (0 = unknown: USD orders wait). */
  bsvUsd: number;
  /** Where to pay this payee (address, or a resolved paymail). */
  resolve: (p: Payee) => Promise<string>;
  /** Sign + broadcast one tx from the pot. */
  pay: (potId: string, outputs: { address: string; sats: number }[]) => Promise<string>;
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
        appendAgentLog(s.potId, { at: now, action: 'sub-skip', detail: `Skipped ${plan.missed - cap} missed payments to ${s.payee.name}`, usd: 0 });
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
    let txid: string;
    try {
      txid = await deps.pay(s.potId, Array.from({ length: count }, () => ({ address, sats })));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      out.push(fail(s, m, deps, /not enough|insufficient/i.test(m)));
      continue;
    }
    // The user may have paused or cancelled while this was paying: keep that.
    const cur = getSub(s.id) ?? s;
    const next = advanced(s, count);
    saveSub({ ...next, status: cur.status === 'paused' || cur.status === 'cancelled' ? cur.status : next.status });
    appendAgentLog(s.potId, {
      at: now,
      action: 'sub-pay',
      detail: `Paid ${s.payee.name} ${formatAmount(s.amount)}${count > 1 ? ` × ${count}` : ''}`,
      usd,
      txid,
    });
    out.push({ id: s.id, ok: true, count, txid });
  }
  return out;
}
