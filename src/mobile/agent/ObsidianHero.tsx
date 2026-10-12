import { useEffect, useState } from 'react';
import bGlyph from '../brand/bwalletx-glyph.svg';
import { BSPACES_ENABLED, MARKET_ENABLED } from '../storeBuild';
import { ObsidianBackdrop } from '../ui/ObsidianBackdrop';
import { prefersReducedMotion } from '../ui/obsidianPool';

/**
 * Ask b's opening (owner, 11 Oct 2026): a pool of liquid obsidian with the gold b in the middle, which then makes
 * room for what b can do. Each option only fills in the message box; nothing is sent (or paid for) until Send.
 *
 * The pool is ui/ObsidianBackdrop (one shader, shared with the welcome / unlock / restore screens), uncapped here.
 */

type Option = { label: string; prompt: string };

// Opens with "Ask b", then gentle questions (owner, 12 Oct 2026), not commands.
const OPTIONS: Option[] = [
  { label: 'Ask b', prompt: 'Hi b. What can you help me with?' },
  {
    label: 'Would you like to create a savings pot?',
    prompt: 'Help me create a savings pot. Ask me what it is for, how much, and until when.',
  },
  {
    label: 'Is there someone you’d like to send money to?',
    prompt: 'Help me send BSV to someone. Ask me who to and how much.',
  },
  {
    label: 'Shall we set up pocket money for someone?',
    prompt: 'Help me set up a regular payment to someone, like pocket money. Ask me who, how much and how often.',
  },
  ...(MARKET_ENABLED
    ? [
        {
          label: 'Curious about a token?',
          prompt: 'Tell me about a token I might like, then ask if I want to buy some and how much.',
        },
      ]
    : []),
  ...(BSPACES_ENABLED
    ? [
        {
          label: 'Fancy going live in a Space?',
          prompt: 'Help me start a live Space in one of my rooms. Ask me which room and the topic.',
        },
      ]
    : []),
  {
    label: 'Is anything not working as it should?',
    prompt: "Something isn't working in my wallet. Help me find out what and fix it.",
  },
];

/** How long each suggestion floats in the pool, and its fade. */
const LINE_MS = 3600;
const FADE_MS = 900;
/** One start time per page load, shared by every hero. */
const HERO_EPOCH = Date.now();

/**
 * Ask b (owner, 11 Oct 2026: "pure simplicity"): the obsidian pool, a big gold b in the middle, and one suggestion at
 * a time drifting in and out of the pool. Tapping the line fills the message box; nothing is sent until Send.
 */
export const ObsidianHero = ({
  onPick,
  compact = false,
  extra = [],
}: {
  onPick: (prompt: string) => void;
  compact?: boolean;
  extra?: Option[];
}) => {
  const [still] = useState(prefersReducedMotion);
  const lines = [...OPTIONS, ...extra];
  // Clock-driven: the line index and fade come from one page-load clock, so re-renders never stack timers
  // or reset to "Ask b" (owner, 12 Oct 2026: fades glitching).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const cycle = LINE_MS + FADE_MS;
  const since = Math.max(0, now - HERO_EPOCH - 1400);
  const i = Math.floor(since / cycle) % Math.max(1, lines.length);
  const shown = now - HERO_EPOCH >= 1400 && since % cycle < LINE_MS;
  const line = lines[i % lines.length];
  const mark = compact ? 120 : 176;
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden"
      style={{ isolation: 'isolate' }}
    >
      <ObsidianBackdrop fixed={false} dim={0} fps={0} pauseWhileTyping={false} />
      <img
        src={bGlyph}
        alt="Ask b"
        width={mark}
        height={mark}
        className="relative"
        style={{ filter: 'drop-shadow(0 0 36px rgba(245,184,0,.5)) drop-shadow(0 8px 24px rgba(0,0,0,.85))' }}
      />
      <button
        type="button"
        onClick={() => onPick(line.prompt)}
        aria-live="polite"
        className="relative mt-10 border-0 bg-transparent px-6 cursor-pointer"
        style={{
          color: '#F3E7C2',
          fontWeight: 500,
          fontSize: compact ? 22 : 30,
          letterSpacing: '-0.01em',
          lineHeight: 1.25,
          maxWidth: 720,
          textShadow: '0 2px 18px rgba(0,0,0,.9)',
          opacity: shown || still ? 1 : 0,
          filter: shown || still ? 'blur(0)' : 'blur(6px)',
          transition: `opacity ${FADE_MS}ms ease, filter ${FADE_MS}ms ease`,
          minHeight: '1.6em',
        }}
      >
        {line.label}
      </button>
    </div>
  );
};
