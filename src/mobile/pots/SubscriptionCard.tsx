import { PNEE_POTS_ENABLED } from '../storeBuild';
import { useState } from 'react';
import { resolvePayee } from './potSend';
import { approveReview, keyFingerprint, pointsSomewhereNew } from './payeeBinding';
import {
  amountSats,
  cancelSub,
  formatAmount,
  formatPeriod,
  moveSub,
  potCurrencyOk,
  nextDue,
  pauseSub,
  resumeSub,
  type Pot,
  type Subscription,
} from './pots';

const MUTED = '#98A2B3';
const LINE = '#2b2f36';
const CARD = '#17191E';

const STATUS: Record<Subscription['status'], { label: string; color: string }> = {
  active: { label: 'Active', color: '#6CE9A6' },
  lowFunds: { label: 'Low funds', color: '#FDB022' },
  paused: { label: 'Paused', color: MUTED },
  cancelled: { label: 'Cancelled', color: '#FDA29B' },
  ended: { label: 'Ended', color: MUTED },
};

const NEEDS_APPROVAL = { label: 'Paused · approve', color: '#FDA29B' };

const day = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * One standing order: payee, amount, next payment, Pause/Resume (one tap), Cancel. With `rate`, a dollar order shows
 * about how much BSV it would take today (it pays that day's rate when due); with `pots`, a Pays-from picker.
 */
export const SubscriptionCard = ({
  sub,
  rate,
  pots,
  potLabel,
}: {
  sub: Subscription;
  rate?: number;
  pots?: Pot[];
  /** Shown as "Paid from <pot>" when there is no Pays-from picker (the Pots & Locks › Subscriptions tab). */
  potLabel?: string;
}) => {
  // Waiting for the user to approve a new destination: paused for payments, whatever the status says.
  const st =
    sub.needsReview && (sub.status === 'active' || sub.status === 'lowFunds') ? NEEDS_APPROVAL : STATUS[sub.status];
  const next = nextDue(sub);
  const live = sub.status === 'active' || sub.status === 'lowFunds';
  const over = sub.status === 'cancelled' || sub.status === 'ended';
  // Pays from: only pots that pay in this order's unit.
  const from = pots?.filter((p) => potCurrencyOk(p.unit, sub.amount.currency));
  return (
    <div className="rounded-2xl p-3 flex flex-col gap-2" style={{ background: CARD }}>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-white truncate">
            {sub.payee.name}
            {sub.payee.origin && (
              <span className="font-normal" style={{ color: MUTED }} data-testid="sub-card-origin">
                {' '}
                · {sub.payee.origin.replace(/^https:\/\//, '')}
              </span>
            )}
          </div>
          <div className="text-[11px] truncate" style={{ color: MUTED }}>
            {formatAmount(sub.amount)} {formatPeriod(sub.period)}
            {sub.maxCount !== null ? ` · ${sub.paidCount} of ${sub.maxCount} paid` : ` · ${sub.paidCount} paid`}
          </div>
        </div>
        <span
          className="text-[10px] font-bold rounded px-1.5 py-0.5"
          style={{ background: `${st.color}22`, color: st.color }}
        >
          {st.label.toUpperCase()}
        </span>
      </div>
      {!over && next !== null && (
        <div className="text-xs text-white">
          Next: {day(next)} · {formatAmount(sub.amount)}
          {sub.amount.currency === 'USD' && rate && rate > 0 && amountSats(sub.amount, rate) !== null
            ? ` · about ${(amountSats(sub.amount, rate)! / 1e8).toFixed(5)} BSV today`
            : ''}
        </div>
      )}
      {!over && from && from.length > 1 && (
        <label className="flex items-center justify-between gap-2 text-xs" style={{ color: MUTED }}>
          Pays from
          <select
            value={sub.potId}
            onChange={(e) => moveSub(sub.id, e.target.value, Date.now(), rate ?? 0)}
            className="rounded-lg px-2 py-1.5 text-xs font-bold text-white"
            style={{ background: LINE, border: 0 }}
          >
            {from.map((p) => (
              <option key={p.identityAddress} value={p.identityAddress}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {potLabel && !(from && from.length > 1 && !over) && (
        <div className="text-xs" style={{ color: MUTED }}>
          Paid from {potLabel}
        </div>
      )}
      {sub.payee.origin && sub.description && (
        <div className="text-xs truncate" style={{ color: MUTED }}>
          {sub.description}
        </div>
      )}
      {sub.lastReceipt && (
        <div className="text-xs truncate" style={{ color: MUTED }}>
          Last paid {day(sub.lastReceipt.at)} · ${sub.lastReceipt.usd.toFixed(2)} ·{' '}
          {PNEE_POTS_ENABLED && sub.amount.currency === 'PNEE'
            ? 'in PNEEs'
            : `${(sub.lastReceipt.sats / 1e8).toFixed(8)} BSV`}{' '}
          · {sub.lastReceipt.txid.slice(0, 10)}…
        </div>
      )}
      {sub.needsReview && !over && <ReviewPayee sub={sub} />}
      {sub.lastError && !over && !sub.needsReview && (
        <div className="text-xs" style={{ color: '#FDA29B' }}>
          Last try: {sub.lastError}
        </div>
      )}
      {!over && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => (live ? pauseSub(sub.id) : resumeSub(sub.id))}
            className="flex-1 rounded-lg px-3 py-2 text-sm font-bold border-0"
            style={{ background: LINE, color: '#fff' }}
          >
            {live ? 'Pause' : 'Resume'}
          </button>
          <button
            type="button"
            onClick={() => window.confirm(`Cancel payments to ${sub.payee.name}?`) && cancelSub(sub.id)}
            className="flex-1 rounded-lg px-3 py-2 text-sm font-bold border-0"
            style={{ background: '#F0443822', color: '#FDA29B' }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};

/** One side of the review card: an address and, when known, the wallet key behind it. */
const Dest = ({ label, address, pubkey }: { label: string; address?: string; pubkey?: string }) => (
  <div className="text-xs flex flex-col" style={{ color: MUTED }}>
    <span>{label}</span>
    <span className="text-white break-all" data-testid={`sub-review-${label.toLowerCase()}`}>
      {address ?? 'not recorded'}
    </span>
    {pubkey && <span>wallet key {keyFingerprint(pubkey)}</span>}
  </div>
);

/**
 * A payee whose destination changed or couldn't be verified (b-Aware row 73): nothing is paid until the user taps
 * Approve on the destination shown here, old next to new. Approve pins exactly what is shown; the scheduler never
 * moves a pin by itself.
 */
const ReviewPayee = ({ sub }: { sub: Subscription }) => {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const review = sub.needsReview;
  const served = review?.servedAddress;
  // Approve looks the payee up again with the set-up checks: it pins only what this card shows (or, when the
  // destination itself was refused, what the confirm shows), never an address nothing ties to the payee's key.
  const approve = async () => {
    setBusy(true);
    setErr('');
    try {
      // When the payee moved on since this card was raised, approveReview shows the new destination here and throws.
      await approveReview(sub, resolvePayee, (d) => {
        const who = d.pubkey ? `wallet key ${keyFingerprint(d.pubkey)}` : 'no wallet key';
        return window.confirm(`Pay ${sub.payee.paymail ?? sub.payee.name} at ${d.address} (${who}) from now on?`);
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="rounded-lg p-2 flex flex-col gap-1.5"
      style={{ background: '#F0443822' }}
      data-testid="sub-needs-review"
    >
      {served && (
        <div className="text-xs font-bold text-white" data-testid="sub-review-headline">
          {pointsSomewhereNew(sub.payee.paymail ?? sub.payee.name)}
        </div>
      )}
      <div className="text-xs" style={{ color: '#FDA29B' }}>
        Not paying: {review?.reason}
      </div>
      {served && (
        <div className="flex flex-col gap-1">
          <Dest label="Was" address={sub.payee.pinnedAddress} pubkey={sub.payee.pinnedKey} />
          <Dest label="Now" address={served} pubkey={review?.servedKey} />
        </div>
      )}
      {err && (
        <div className="text-xs" style={{ color: '#FDA29B' }}>
          {err}
        </div>
      )}
      {served ? (
        <button
          type="button"
          onClick={() => void approve()}
          disabled={busy}
          className="rounded-lg px-3 py-2 text-sm font-bold border-0"
          style={{ background: LINE, color: '#fff' }}
          data-testid="sub-review-approve"
        >
          {busy ? 'Checking…' : 'Approve new destination'}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void approve()}
          disabled={busy}
          className="rounded-lg px-3 py-2 text-sm font-bold border-0"
          style={{ background: LINE, color: '#fff' }}
        >
          {busy ? 'Checking…' : 'Check new destination'}
        </button>
      )}
    </div>
  );
};
