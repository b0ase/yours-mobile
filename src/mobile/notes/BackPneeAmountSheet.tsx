import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { fmtUsd } from '../locks/schedule';
import {
  BACK_PNEE_EXPLAINER,
  BACK_PNEE_PRESETS,
  BACK_PNEE_QUESTION,
  backPneeSummary,
  parseBsvAmount,
} from './backPnee';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const CARD = '#17191E';

/**
 * Lock screen › Back PNEEs, second sheet (owner, 10 Oct 2026): after the Back PNEEs card, how much BSV to lock.
 * Continue opens the lock builder filled in for the PNEEs pot (the usual review and type-LOCK confirm follow).
 */
export const BackPneeAmountSheet = ({
  rate,
  onClose,
  onContinue,
}: {
  rate: number;
  onClose: () => void;
  onContinue: (bsv: number) => void;
}) => {
  const [raw, setRaw] = useState('');
  useBackClose(true, onClose);
  const bsv = parseBsvAmount(raw);
  const sum = bsv ? backPneeSummary(bsv, rate) : null;

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full max-h-[88vh] overflow-y-auto rounded-t-2xl p-4 flex flex-col gap-3"
        style={{ background: '#101114', paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Lock size={20} color={GOLD} />
          <span className="flex-1 text-base font-bold text-white">{BACK_PNEE_QUESTION}</span>
          <button type="button" aria-label="Close" onClick={onClose} className="p-1 border-0 bg-transparent">
            <X size={18} color={MUTED} />
          </button>
        </div>
        <p className="text-xs m-0" style={{ color: MUTED }}>
          {BACK_PNEE_EXPLAINER}
        </p>
        <label className="rounded-xl p-3 flex items-center gap-2" style={{ background: CARD }}>
          <input
            inputMode="decimal"
            autoFocus
            placeholder="0.00"
            aria-label="Amount in BSV"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-2xl font-bold text-white"
          />
          <span className="text-sm font-bold" style={{ color: GOLD }}>
            BSV
          </span>
        </label>
        <div className="text-xs" style={{ color: MUTED }}>
          {sum && rate > 0
            ? `≈ ${fmtUsd(sum.usd)} · backs up to ${fmtUsd(sum.maxPneeUsd)} of PNEEs`
            : rate > 0
              ? `1 BSV ≈ ${fmtUsd(rate)}`
              : ' '}
        </div>
        <div className="grid grid-cols-4 gap-2">
          {BACK_PNEE_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setRaw(String(p))}
              className="rounded-full border py-2 text-xs font-bold bg-transparent cursor-pointer"
              style={{ borderColor: bsv === p ? GOLD : '#F5B80055', color: GOLD }}
            >
              {p} BSV
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={!bsv}
          onClick={() => bsv && onContinue(bsv)}
          className="rounded-xl py-3 text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
          style={{ background: 'linear-gradient(135deg, #de973f, #f9dd63)', color: '#1a1300' }}
        >
          Continue
        </button>
      </div>
    </div>,
    document.body,
  );
};
