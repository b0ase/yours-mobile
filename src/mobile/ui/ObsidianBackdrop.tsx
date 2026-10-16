import { useRef, useState, type CSSProperties } from 'react';
import {
  GOLD_FALLBACK,
  GOLD_FRAG,
  POOL_FALLBACK,
  TINT_FRAG,
  poolColoursFor,
  poolFallbackFor,
  poolMode,
  prefersReducedMotion,
  usePool,
  type PoolColours,
} from './obsidianPool';
import { DEFAULT_ACCENT, accentById, type Accent } from '../theme/accents';
import { useAccentId } from '../theme/useAccent';

/**
 * Full-screen pool behind a screen's content. Put it first inside a container with `isolation: isolate` (it sits at
 * z-index -1, above that container's own background and below its content). `fixed` covers the viewport (or the
 * transformed panel on the wide layout); otherwise it fills the nearest positioned box.
 */
export const ObsidianBackdrop = ({
  dim = 0.35,
  fixed = true,
  fps = 30,
  pauseWhileTyping = true,
  className = '',
  style,
  variant = 'obsidian',
  pack,
}: {
  /** Paint the pool in this pack's colours (same shader, TINT_FRAG); null = the original. Left out: the current pack
   *  when it is a light one (White, Pink, Blue, Yellow …), so unlock and onboarding are paper, not obsidian. */
  pack?: Accent | null;
  /** 'gold' = the molten-gold pool (Name Store); default the obsidian pool. */
  variant?: 'obsidian' | 'gold';
  /** Dark overlay over the pool, 0 to 1, so text on it stays readable. */
  dim?: number;
  fixed?: boolean;
  /** Frame cap (0 = every frame). Backgrounds default to 30 fps; the Ask b hero runs uncapped. */
  fps?: number;
  /** Hold still while an input has focus (on by default for screens with forms). */
  pauseWhileTyping?: boolean;
  className?: string;
  style?: CSSProperties;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = accentById(useAccentId());
  if (pack === undefined)
    pack = current.id !== DEFAULT_ACCENT && current.kind !== 'colour' && current.scheme === 'light' ? current : null;
  const [still] = useState(prefersReducedMotion);
  // A background, not the show: 30 fps and still while typing by default (phones, the extension popup).
  const gold = variant === 'gold';
  const colours: PoolColours | undefined = !gold && pack ? poolColoursFor(pack) : undefined;
  const failed = usePool(canvas, {
    still,
    fps,
    pauseWhileTyping,
    frag: gold ? GOLD_FRAG : colours ? TINT_FRAG : undefined,
    colours,
  });
  return (
    <div
      aria-hidden
      data-pool={poolMode(!failed, still)}
      data-pool-dark={colours ? undefined : ''}
      className={`${fixed ? 'fixed' : 'absolute'} inset-0 overflow-hidden pointer-events-none ${className}`}
      style={{ zIndex: -1, ...style }}
    >
      {/* The gradient on its own layer: wide-layout CSS clears backgrounds on the screens' wrappers (mobile.css). */}
      <div
        className="absolute inset-0"
        style={{ background: gold ? GOLD_FALLBACK : colours && pack ? poolFallbackFor(pack) : POOL_FALLBACK }}
      />
      {!failed && <canvas ref={canvas} className="absolute inset-0 h-full w-full" />}
      {dim > 0 && <div className="absolute inset-0" style={{ background: `rgba(0,0,0,${dim})` }} />}
    </div>
  );
};
