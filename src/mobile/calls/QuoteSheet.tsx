import { useEffect, useState } from 'react';
import { Clock, Phone } from 'lucide-react';
import { bareName } from '../names/names';
import { fmtSats, useBsvUsd, usdToSats } from '../money/money';
import { acceptQuote, declineQuote } from './store';
import {
  amountLabel,
  costForMinutes,
  maxSpendPresets,
  payInterval,
  rateLabel,
  secondsLeftUnderCap,
  WARN_BEFORE_S,
  type Meter,
  type RateCard,
} from './rateCard';
import { formatDuration, type CallState } from './machine';

const GOLD = '#F5B800';

/**
 * bPhone, caller side, before anything rings: "They charge $2.00 / min. Max spend?" One tap on a
 * preset accepts the rate and dials. The cap is the most this call can cost; the call ends when
 * it is reached.
 */
export const QuoteSheet = ({ s }: { s: Extract<CallState, { phase: 'quote' }> }) => {
  const rate = useBsvUsd();
  const presets = maxSpendPresets(s.card);
  const [cap, setCap] = useState(presets[Math.min(1, presets.length - 1)]);
  const [busy, setBusy] = useState(false);
  const flat = s.card.per === 'call';
  const sats = s.card.asset.kind === 'bsv' ? usdToSats(cap, rate) : null;
  const minutes = flat
    ? null
    : presets.map((p, i) => [p, [15, 30, 60][i] ?? Math.round(p / costForMinutes(s.card, 1))] as const);
  return (
    <div className="flex flex-col items-center gap-5 w-full px-6 relative z-[1]" aria-label="Call price">
      <div
        className="w-full rounded-2xl p-4 flex flex-col gap-2"
        style={{ background: '#17191E', border: '1px solid #2b2f36' }}
      >
        <div className="text-xs text-[#98A2B3]">{bareName(s.peer.label)} charges to receive calls</div>
        <div className="text-xl font-bold text-white">{rateLabel(s.card)}</div>
        {!flat && (
          <div className="text-xs text-[#98A2B3]">
            Paid every {payInterval(s.card)} seconds from your wallet while you talk. You can hang up any time.
          </div>
        )}
        {flat && <div className="text-xs text-[#98A2B3]">Paid once, when they answer.</div>}
      </div>
      {!flat && (
        <div className="w-full flex flex-col gap-2">
          <div className="text-xs text-[#98A2B3]">Max spend on this call</div>
          <div className="flex gap-2">
            {presets.map((p, i) => (
              <button
                key={p}
                onClick={() => setCap(p)}
                aria-pressed={cap === p}
                className="flex-1 rounded-xl py-2 text-sm font-semibold"
                style={
                  cap === p ? { background: GOLD, color: '#1a1300' } : { border: '1px solid #2b2f36', color: '#fff' }
                }
              >
                {amountLabel(s.card.asset, p)}
                <div className="text-[10px] font-normal opacity-80">≈ {minutes?.[i]?.[1]} min</div>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="text-xs text-[#98A2B3] text-center">
        {flat ? `You will pay ${amountLabel(s.card.asset, cap)}` : `Up to ${amountLabel(s.card.asset, cap)}`}
        {sats !== null ? ` (≈ ${fmtSats(sats)})` : ''}
        {s.card.asset.kind === 'bsv' ? ', in BSV at the live rate' : ''}
      </div>
      <div className="flex gap-6">
        <button className="flex flex-col items-center gap-2" onClick={declineQuote} aria-label="Cancel">
          <span className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: '#2b2f36' }}>
            <Phone size={26} color="#fff" style={{ transform: 'rotate(135deg)' }} />
          </span>
          <span className="text-xs text-[#c9ccd1]">Cancel</span>
        </button>
        <button
          className="flex flex-col items-center gap-2 disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void acceptQuote(cap);
          }}
          aria-label="Accept and call"
        >
          <span className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: '#2ecc71' }}>
            <Phone size={26} color="#fff" />
          </span>
          <span className="text-xs text-[#c9ccd1]">Accept &amp; call</span>
        </button>
      </div>
    </div>
  );
};

/** Caller side, in the call: what has gone out so far, and a warning as the cap nears. */
export const SpendLine = ({ meter, since }: { meter: Meter; since: number }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsedS = (now - since) / 1000;
  const left = secondsLeftUnderCap(meter, elapsedS);
  const warn = Number.isFinite(left) && left <= WARN_BEFORE_S;
  return (
    <div className="flex flex-col items-center gap-1 text-xs" aria-live="polite">
      <div className="text-[#F5B800] font-semibold">
        {meter.card.per === 'call' ? 'Paid ' : 'Spent '}
        {amountLabel(meter.card.asset, meter.paidUnits)}
        {meter.card.per !== 'call' && (
          <span className="text-[#98A2B3] font-normal"> of {amountLabel(meter.card.asset, meter.maxUnits)}</span>
        )}
        {meter.paying && <span className="text-[#98A2B3] font-normal"> · paying…</span>}
        {meter.stopped && <span className="text-[#ff6b6b] font-normal"> · payments stopped</span>}
      </div>
      {warn && (
        <div className="flex items-center gap-1 text-[#ff9f43]">
          <Clock size={12} /> Max spend in {formatDuration(left * 1000)}
        </div>
      )}
    </div>
  );
};

/** Callee side, in the call: how far the caller has paid. */
export const PaidThroughLine = ({
  card,
  paidThroughS,
  paidUnits,
  since,
}: {
  card: RateCard;
  paidThroughS: number;
  paidUnits: number;
  since: number;
}) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsedS = (now - since) / 1000;
  const ahead = paidThroughS - elapsedS;
  const flat = card.per === 'call';
  return (
    <div className="text-xs" aria-live="polite">
      <span className="text-[#F5B800] font-semibold">Received {amountLabel(card.asset, paidUnits)}</span>
      {!flat && paidThroughS > 0 && (
        <span className="text-[#98A2B3]"> · paid {ahead >= 0 ? `${Math.ceil(ahead)} s ahead` : 'late'}</span>
      )}
      {paidThroughS <= 0 && <span className="text-[#98A2B3]"> · waiting for the first payment</span>}
    </div>
  );
};
