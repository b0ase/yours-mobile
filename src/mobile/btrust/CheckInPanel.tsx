/**
 * bTrust check-in ("I'm still here"): countdown to the heirs' date and a one-tap check-in.
 * The tap only previews the re-lock (checkIn() in inheritance.ts, pure). Spending the owner branch
 * and re-locking is not wired yet, so nothing is signed or broadcast here.
 */
import { useState } from 'react';
import { checkIn, type InheritancePlan } from './inheritance';
import { countdown } from './checkin';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const TONE = { ok: '#32D583', soon: GOLD, open: '#F97066' } as const;

type Props = {
  plan: InheritancePlan;
  height: number;
  months: number;
  /** Called with the re-dated plan. The signing step behind it is a stub until check-in ships. */
  onPreview: (next: InheritancePlan) => void;
};

export const CheckInPanel = ({ plan, height, months, onPreview }: Props) => {
  const [note, setNote] = useState('');
  const c = countdown(plan, height);
  const headline =
    c.tone === 'open'
      ? 'Your heirs can claim now. Check in to push the date back.'
      : `${c.heirsDays} ${c.heirsDays === 1 ? 'day' : 'days'} until your heirs can claim`;

  const tap = () => {
    try {
      const next = checkIn(plan, height, months);
      onPreview(next);
      setNote(
        `Next date: block ${next.heirsHeight.toLocaleString('en-GB')} (about ${months} months). ` +
          'One-tap re-lock is coming: for now, save the new plan and give each heir a copy.',
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Check-in failed');
    }
  };

  return (
    <div className="flex flex-col gap-2 text-sm text-white" aria-label="Check in">
      <div className="rounded-xl p-3 border" style={{ borderColor: TONE[c.tone] }}>
        <div className="font-bold" style={{ color: TONE[c.tone] }}>
          {headline}
        </div>
        <div className="text-xs" style={{ color: MUTED }}>
          Block {height.toLocaleString('en-GB')} now. Heirs from block {plan.heirsHeight.toLocaleString('en-GB')}, lead
          heir alone in about {c.leadDays} days.
        </div>
      </div>
      <button
        type="button"
        className="rounded-xl px-3 py-3 text-base font-bold border-0 cursor-pointer"
        style={{ background: GOLD }}
        disabled={!height}
        onClick={tap}
      >
        I&apos;m still here
      </button>
      {note && (
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          {note}
        </p>
      )}
    </div>
  );
};
