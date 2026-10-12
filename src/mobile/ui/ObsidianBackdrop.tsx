import { useRef, useState, type CSSProperties } from 'react';
import { POOL_FALLBACK, poolMode, prefersReducedMotion, usePool } from './obsidianPool';

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
}: {
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
  const [still] = useState(prefersReducedMotion);
  // A background, not the show: 30 fps and still while typing by default (phones, the extension popup).
  const failed = usePool(canvas, { still, fps, pauseWhileTyping });
  return (
    <div
      aria-hidden
      data-pool={poolMode(!failed, still)}
      className={`${fixed ? 'fixed' : 'absolute'} inset-0 overflow-hidden pointer-events-none ${className}`}
      style={{ zIndex: -1, ...style }}
    >
      {/* The gradient on its own layer: wide-layout CSS clears backgrounds on the screens' wrappers (mobile.css). */}
      <div className="absolute inset-0" style={{ background: POOL_FALLBACK }} />
      {!failed && <canvas ref={canvas} className="absolute inset-0 h-full w-full" />}
      {dim > 0 && <div className="absolute inset-0" style={{ background: `rgba(0,0,0,${dim})` }} />}
    </div>
  );
};
