import { cancelSub, formatAmount, formatPeriod, nextDue, pauseSub, resumeSub, type Subscription } from './pots';

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

const day = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** One standing order: payee, amount, next payment, Pause/Resume (one tap), Cancel. */
export const SubscriptionCard = ({ sub }: { sub: Subscription }) => {
  const st = STATUS[sub.status];
  const next = nextDue(sub);
  const live = sub.status === 'active' || sub.status === 'lowFunds';
  const over = sub.status === 'cancelled' || sub.status === 'ended';
  return (
    <div className="rounded-2xl p-3 flex flex-col gap-2" style={{ background: CARD }}>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-white truncate">{sub.payee.name}</div>
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
        </div>
      )}
      {sub.lastError && !over && (
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
