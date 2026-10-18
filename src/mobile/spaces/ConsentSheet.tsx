/**
 * Transcription consent (transcription.ts). Two sheets, never combined:
 *  - 'listen': the notice before joining a transcribed Space. Acknowledging it is NOT consent to be
 *    transcribed; listeners are never recorded.
 *  - 'speak': before the mic goes live. A separate explicit tick, or "Don't transcribe me", which
 *    still lets you speak, labelled "(not transcribed)". bWalletX only: in a store build the speak
 *    branch folds away (TRANSCRIPTION_ENABLED), so a store user is never asked and never transcribed.
 */
import { useState } from 'react';
import { TranscribingBadge } from './GreenRoom';
import { TRANSCRIPTION_ENABLED } from '../storeBuild';

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#8a8f98';

export const ConsentSheet = ({
  kind,
  notice,
  onAgree,
  onDecline,
}: {
  kind: 'listen' | 'speak';
  notice: string;
  /** listen: "Got it". speak: only enabled once the box is ticked. */
  onAgree: () => void;
  /** listen: leave the Space. speak: speak untranscribed. */
  onDecline: () => void;
}) => {
  const [ticked, setTicked] = useState(false);
  const speak = TRANSCRIPTION_ENABLED && kind === 'speak';
  if (!TRANSCRIPTION_ENABLED && kind === 'speak') return null;
  return (
    <div className="fixed inset-0 z-[1000] flex items-end" style={{ background: 'rgba(0,0,0,.6)' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={speak ? 'Transcribe my voice?' : 'This Space is transcribed'}
        className="w-full rounded-t-2xl p-5"
        style={{ background: '#121316', paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}
      >
        <div className="flex items-center gap-2">
          <TranscribingBadge />
          <p className="text-white font-semibold">{speak ? 'Transcribe my voice?' : 'This Space is transcribed'}</p>
        </div>
        {!speak ? (
          <p className="mt-3 text-sm" style={{ color: '#d1d5db' }}>
            {notice}
          </p>
        ) : (
          <label className="mt-3 flex items-start gap-3 text-sm" style={{ color: '#d1d5db' }}>
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 shrink-0"
              checked={ticked}
              onChange={(e) => setTicked(e.target.checked)}
            />
            <span>{notice}</span>
          </label>
        )}
        <div className="mt-4 flex flex-col gap-2">
          <button
            onClick={onAgree}
            disabled={speak && !ticked}
            className="w-full rounded-full py-3 font-semibold disabled:opacity-40"
            style={{ background: GOLD, color: '#010101' }}
          >
            {speak ? 'Speak, transcribed' : 'Got it, join'}
          </button>
          <button
            onClick={onDecline}
            className="w-full rounded-full py-3 font-semibold"
            style={{ border: `1px solid ${MUTED}`, color: '#fff' }}
          >
            {speak ? 'Don’t transcribe me' : 'Leave'}
          </button>
        </div>
      </div>
    </div>
  );
};
