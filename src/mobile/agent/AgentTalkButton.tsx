import { Mic } from 'lucide-react';
import { HoldRing, TalkSheetView } from './TalkVisuals';
import { useHoldToTalk } from './useHoldToTalk';
import { voiceNote } from './voiceText';

const GOLD = 'var(--bw-accent-hi)';

/**
 * Push-to-talk in Ask b's chat bar (owner, 12 Oct 2026): the Dock's round gold ring, scaled to the bar, with a mic
 * in it (owner, 14 Oct 2026: a b glyph here read as a second, pointless b button on the Ask b screen).
 * Hold = listen (bars + live transcript); release = the words land in the composer to edit and send (never sent
 * for you); slide away or Escape = cancel. Without voice on this device: a note, and the b just focuses the composer.
 */
export const AgentTalkButton = ({
  disabled,
  onTranscript,
  onNote,
}: {
  disabled?: boolean;
  onTranscript: (text: string) => void;
  onNote: (note: string) => void;
}) => {
  const focusComposer = () => document.querySelector<HTMLTextAreaElement>('[data-agent-input]')?.focus();
  const { phase, sheet, supported, handlers, listening } = useHoldToTalk({
    disabled,
    onTap: () => {
      if (supported === false) onNote(voiceNote('unavailable', 'web'));
      focusComposer();
    },
    onListen: (ok) => !ok && onNote(voiceNote('unavailable', 'web')),
    onUnsupportedRelease: focusComposer,
    onResult: (r) => {
      if ('text' in r) onTranscript(r.text);
      else onNote(r.note);
      window.setTimeout(focusComposer, 50);
    },
  });
  return (
    <>
      {sheet && (
        <TalkSheetView
          sheet={sheet}
          phase={phase}
          idleText="Listening… let go to type it in"
          hint="Let go to edit, then send · slide away to cancel"
          sendingHint="Writing it down…"
          noteHint="Let go to type to b instead"
        />
      )}
      <button
        type="button"
        disabled={disabled}
        aria-label={supported === false ? 'Type to b' : 'Press and hold to talk to b'}
        title={supported === false ? 'Voice is not available here' : 'Hold to talk'}
        data-testid="agent-talk-b"
        {...handlers}
        className="relative shrink-0 h-10 w-10 rounded-full flex items-center justify-center border-0 select-none transition-transform disabled:opacity-40"
        style={{
          background: '#010101',
          boxShadow: `0 0 0 2px ${GOLD}, 0 4px 12px rgba(0,0,0,0.6)`,
          transform: phase === 'pressing' ? 'scale(0.94)' : listening ? 'scale(1.06)' : undefined,
          WebkitTouchCallout: 'none',
          WebkitUserSelect: 'none',
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        <HoldRing phase={phase} inset={4} />
        <Mic size={18} color={GOLD} aria-hidden="true" className="pointer-events-none" />
      </button>
    </>
  );
};
