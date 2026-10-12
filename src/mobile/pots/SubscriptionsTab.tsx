import { useEffect, useState } from 'react';
import { useBsvUsd } from '../money/money';
import { getPot, listPots, listSubs, monthlyUsd, onPotsChange } from './pots';
import { SubscriptionCard } from './SubscriptionCard';
import { subsForTab } from './subsList';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';

/** Gold art for the empty state: a payment flowing out of a pot, once a period. */
const PotArt = () => (
  <svg width="120" height="96" viewBox="0 0 120 96" aria-hidden="true">
    <defs>
      <linearGradient id="subs-gold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#FFE38A" />
        <stop offset="0.55" stopColor={GOLD} />
        <stop offset="1" stopColor="#9A6B00" />
      </linearGradient>
    </defs>
    <ellipse cx="44" cy="30" rx="30" ry="8" fill="none" stroke="url(#subs-gold)" strokeWidth="3" />
    <path d="M14 30 Q14 78 44 82 Q74 78 74 30" fill="#F5B80018" stroke="url(#subs-gold)" strokeWidth="3" />
    <circle cx="44" cy="54" r="11" fill="url(#subs-gold)" />
    <text x="44" y="59" textAnchor="middle" fontSize="13" fontWeight="800" fill="#1a1300">
      $
    </text>
    <path d="M78 52 H104" stroke="url(#subs-gold)" strokeWidth="3" strokeLinecap="round" strokeDasharray="2 7" />
    <path d="M100 44 L110 52 L100 60" fill="none" stroke="url(#subs-gold)" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

/**
 * Pots & Locks › Subscriptions: every subscription in one list (who it pays, dollars, how often, which pot pays it,
 * next payment, status) with Pause/Resume and Cancel. Those only change the wallet's own schedule; nothing is signed
 * or paid here. bWalletX only (SUBSCRIPTIONS_ENABLED), the caller gates it.
 */
const SubscriptionsTab = () => {
  const rate = useBsvUsd();
  const [, tick] = useState(0);
  useEffect(() => onPotsChange(() => tick((n) => n + 1)), []);
  const subs = subsForTab(listSubs());
  const pots = listPots();
  const live = subs.filter((s) => s.status === 'active' || s.status === 'lowFunds');

  if (subs.length === 0)
    return (
      <div
        className="rounded-2xl p-5 flex flex-col items-center gap-3 text-center"
        style={{ background: '#F5B8000f', border: `1px solid ${GOLD}44` }}
      >
        <PotArt />
        <div className="text-base font-bold text-white">No subscriptions yet</div>
        <p className="text-xs m-0" style={{ color: MUTED }}>
          A subscription pays a set dollar amount once a day, week, month or year, always from a pot you choose. Put a
          little in a pot and only that pot can pay; the rest of your wallet is never touched. You approve each one
          once, and can pause or cancel it here any time.
        </p>
      </div>
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-bold text-white">
        {subs.length} subscription{subs.length === 1 ? '' : 's'}
        {live.length && rate > 0 ? ` · about $${monthlyUsd(live, rate).toFixed(2)} a month` : ''}
      </div>
      {subs.map((s) => (
        <SubscriptionCard
          key={s.id}
          sub={s}
          rate={rate}
          pots={pots}
          potLabel={getPot(s.potId)?.name ?? 'a pot that is no longer here'}
        />
      ))}
      <p className="text-[11px] m-0 text-center" style={{ color: MUTED }}>
        Each payment is in BSV at that day&apos;s rate, when it is due. Pausing skips payments until you resume.
      </p>
    </div>
  );
};

export default SubscriptionsTab;
