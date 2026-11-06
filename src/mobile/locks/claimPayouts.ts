/**
 * Pots & Locks › Claim: the payout card for each plan after a claim (lines, a dollar-target surplus to re-lock, the
 * tail's "Lock next payouts" batch). Moved out of LockScreen so it can be tested.
 *
 * Only pieces the claim actually spent count (review 21 N1): a matured piece left locked (a claim that stopped part
 * way, a lock not in this wallet) gets no line, no payout and no re-lock offer; it is claimed by a later Claim.
 */
import { fmtBsv, fmtUsd, payoutFor, resplitTail, surplusHeight, type LockPlan } from './schedule';

export type PlanPayout = {
  plan: LockPlan;
  lines: string[];
  relock?: { height: number; sats: number; usdTarget?: number; extend?: boolean };
  batch?: ReturnType<typeof resplitTail>;
};

/** `spent`: outpoints the claim spent (claimLocks). Records `paidUsd` on the pieces it pays (the caller saves). */
export function planPayouts(
  plans: LockPlan[],
  height: number,
  spent: Set<string>,
  todays: number | null,
): PlanPayout[] {
  const out: PlanPayout[] = [];
  for (const p of plans) {
    const ready = p.pieces.filter((x) => !x.claimed && x.height <= height && spent.has(`${x.txid}.${x.vout}`));
    if (!ready.length) continue;
    const target = surplusHeight(p, height);
    const lines: string[] = [];
    let surplus = 0;
    let batch: ReturnType<typeof resplitTail> | undefined;
    for (const x of ready) {
      if (x.tail && p.pendingAmounts?.length) {
        batch = resplitTail(p.pendingAmounts, x.height, p.frequency ?? 'daily', p.customDays);
        lines.push(
          `${fmtBsv(p.pendingAmounts[0])} payout. The remaining ${p.pendingAmounts.length - 1} payouts were held in one lock and are now in your wallet.`,
        );
        continue;
      }
      if (p.mode !== 'usd-target' || !x.usdTarget) {
        lines.push(`${fmtBsv(x.sats)} to your wallet`);
        continue;
      }
      const r = payoutFor(x.sats, x.usdTarget, todays, target != null);
      if (r.kind === 'wait')
        lines.push(`${fmtBsv(x.sats)} claimed. ${r.reason} The full piece is in your wallet as BSV.`);
      else if (r.kind === 'short') {
        x.paidUsd = r.paidUsd;
        lines.push(`Paid ${fmtUsd(r.paidUsd)} of ${fmtUsd(r.targetUsd)} (${fmtBsv(r.paySats)})`);
      } else {
        x.paidUsd = r.paidUsd;
        surplus += r.surplusSats;
        lines.push(
          `Paid ${fmtUsd(r.paidUsd)} (${fmtBsv(r.paySats)})${r.relock ? `, surplus ${fmtBsv(r.surplusSats)}` : ''}`,
        );
      }
    }
    out.push({
      plan: p,
      lines,
      relock:
        surplus && target != null
          ? { height: target, sats: surplus, usdTarget: p.usdPerPayout, extend: p.surplusTo === 'extend' }
          : undefined,
      batch: batch?.pieces.length ? batch : undefined,
    });
  }
  return out;
}
