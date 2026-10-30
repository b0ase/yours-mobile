import { useEffect, useState } from 'react';
import { B_OUTLINE_D, B_OUTLINE_VIEWBOX } from '../brand/bOutline';
import bGlyph from '../brand/bwalletx-glyph.svg';
import { IDEAS, ideaPrompt, shuffled } from './ideas';
import { ObsidianBackdrop } from '../ui/ObsidianBackdrop';
import { prefersReducedMotion } from '../ui/obsidianPool';
import { accentById, DEFAULT_ACCENT } from '../theme/accents';
import { useAccentId } from '../theme/useAccent';

/**
 * Ask b's opening (owner, 11 Oct 2026): a pool of liquid obsidian with the gold b in the middle, which then makes
 * room for what b can do. Each option only fills in the message box; nothing is sent (or paid for) until Send.
 *
 * The pool is ui/ObsidianBackdrop (one shader, shared with the welcome / unlock / restore screens), uncapped here.
 */

type Option = { label: string; prompt: string };

// "Ask b", then ~100 things b can help with, shuffled once per page load (ideas.ts). Each only fills the bar.
const OPTIONS: Option[] = [
  { label: 'Ask b', prompt: 'Hi b. What can you help me with?' },
  ...shuffled(IDEAS).map((i) => ({ label: i.label, prompt: ideaPrompt(i.label) })),
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
  options,
}: {
  onPick: (prompt: string) => void;
  compact?: boolean;
  extra?: Option[];
  /** Context lines in place of the default ones (e.g. the empty chat pane, chat/askBHint.ts). */
  options?: Option[];
}) => {
  const [still] = useState(prefersReducedMotion);
  const lines = options?.length ? options : [...OPTIONS, ...extra];
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
  // Theme packs (owner, 15 Oct 2026): the same pool in the pack's colours; Mono = pale silk with an outline b
  // like the splash, suggestions in the pack's ink. Gold stays the original.
  const pack = accentById(useAccentId());
  const themed = pack.id !== DEFAULT_ACCENT && pack.kind !== 'colour';
  const light = themed && pack.scheme === 'light';
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden"
      style={{ isolation: 'isolate' }}
    >
      <ObsidianBackdrop fixed={false} dim={0} fps={0} pauseWhileTyping={false} pack={themed ? pack : null} />
      {light ? (
        <svg
          role="img"
          aria-label="Ask b"
          width={mark}
          height={mark}
          viewBox={B_OUTLINE_VIEWBOX}
          fill="none"
          stroke={pack.group === 'mono' ? pack.text : pack.accent}
          strokeWidth={4}
          strokeLinejoin="round"
          className="relative"
          style={{
            filter: `drop-shadow(0 0 28px rgb(${pack.group === 'mono' ? '0 0 0 / .08' : 'var(--bw-accent-rgb) / .35'}))`,
          }}
        >
          {/* One unioned outline + the counter (brand/bOutline.ts): no stem lines inside the bowl. */}
          <path d={B_OUTLINE_D} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
        </svg>
      ) : (
        <img
          src={bGlyph}
          alt="Ask b"
          width={mark}
          height={mark}
          className="relative"
          style={{
            filter: 'drop-shadow(0 0 36px rgb(var(--bw-accent-rgb) / .5)) drop-shadow(0 8px 24px rgba(0,0,0,.85))',
          }}
        />
      )}
      <button
        type="button"
        onClick={() => onPick(line.prompt)}
        aria-live="polite"
        className="relative mt-10 border-0 bg-transparent px-6 cursor-pointer"
        style={{
          color: light ? pack.text : '#F3E7C2',
          fontWeight: 500,
          fontSize: compact ? 22 : 30,
          letterSpacing: '-0.01em',
          lineHeight: 1.25,
          maxWidth: 720,
          textShadow: light ? '0 1px 12px rgb(255 255 255 / .9)' : '0 2px 18px rgba(0,0,0,.9)',
          opacity: shown || still ? 1 : 0,
          filter: shown || still ? 'blur(0)' : 'blur(6px)',
          transition: `opacity ${FADE_MS}ms ease, filter ${FADE_MS}ms ease`,
          // Fixed 3-line slot, top-aligned: a wrapping or rotating question never moves the b above it.
          height: '3.75em',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
        }}
      >
        {line.label}
      </button>
    </div>
  );
};
