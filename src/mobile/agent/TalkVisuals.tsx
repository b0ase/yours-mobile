import { B_HOLD_MS, type BHoldPhase } from '../phone/gesture';
import { levelToBars } from '../spaces/levelMeter';
import type { TalkSheet } from './holdToTalk';

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#98A2B3';

/** The talk sheet above a held b: level bars, live transcript and the hint line (Dock and Ask b composer). */
export const TalkSheetView = ({
  sheet,
  phase,
  idleText,
  hint,
  sendingHint,
  noteHint,
}: {
  sheet: TalkSheet;
  phase: BHoldPhase;
  idleText: string;
  hint: string;
  sendingHint: string;
  noteHint: string;
}) => {
  const bars = levelToBars(sheet.level, 5);
  const cancelling = phase === 'cancelling';
  return (
    <div
      role="status"
      aria-live="polite"
      className="bw-talk-sheet absolute left-0 right-0 z-[102] px-3 pb-2 pointer-events-none"
      style={{ bottom: '100%' }}
    >
      <div
        className="rounded-2xl px-4 py-3 flex flex-col items-center gap-2 backdrop-blur-md"
        style={{ background: 'rgba(23,25,30,0.95)', border: `1px solid ${cancelling ? '#F04438' : '#2b2f36'}` }}
      >
        <div className="flex items-end gap-1 h-8" aria-hidden>
          {bars.map((h, i) => (
            <span
              key={i}
              className="w-1.5 rounded-full transition-[height] duration-100"
              style={{ height: `${Math.round(h * 32)}px`, background: cancelling ? MUTED : GOLD }}
            />
          ))}
        </div>
        <p className="m-0 text-center text-[15px] leading-snug text-white min-h-[1.4em] max-h-24 overflow-hidden">
          {sheet.note ?? (sheet.text || (sheet.sending ? '' : idleText))}
        </p>
        <p className="m-0 text-[11px]" style={{ color: cancelling ? '#F04438' : MUTED }}>
          {sheet.sending ? sendingHint : sheet.note ? noteHint : cancelling ? 'Let go to cancel' : hint}
        </p>
      </div>
    </div>
  );
};

/** The gold ring round a b button: fills while pressing, pulses while listening, grey while cancelling. */
export const HoldRing = ({ phase, inset = 5 }: { phase: BHoldPhase; inset?: number }) =>
  phase === 'idle' ? null : (
    <svg className="absolute pointer-events-none" style={{ inset: -inset }} viewBox="0 0 62 62" aria-hidden>
      <circle
        cx="31"
        cy="31"
        r="29"
        fill="none"
        stroke={phase === 'cancelling' ? MUTED : GOLD}
        strokeWidth="3"
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray="100"
        transform="rotate(-90 31 31)"
        className={phase === 'pressing' ? 'bw-hold-ring' : phase === 'listening' ? 'bw-listen-ring' : undefined}
        style={phase === 'pressing' ? { animationDuration: `${B_HOLD_MS}ms` } : undefined}
      />
    </svg>
  );
