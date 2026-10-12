import { useEffect, useState, type ReactNode } from 'react';

const SLIDE_MS = 7000;
const KEYFRAMES = `@keyframes bwx-kenburns{from{transform:scale(1)}to{transform:scale(1.12)}}
@media (prefers-reduced-motion: reduce){.bwx-kb{animation:none!important;transition:none!important}}`;

const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A wide banner of VexVoid stills: slow crossfade with a gentle Ken Burns zoom (both off under
 * prefers-reduced-motion). Black-and-gold gradient underneath, so it is gold by default while images load.
 */
export function StillsBanner({
  stills,
  children,
  className,
}: {
  stills: readonly string[];
  children?: ReactNode;
  className?: string;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (stills.length < 2 || reducedMotion()) return;
    const t = setInterval(() => setI((x) => (x + 1) % stills.length), SLIDE_MS);
    return () => clearInterval(t);
  }, [stills.length]);
  return (
    <div
      // `relative` only when the caller didn't position it: "relative absolute" lets relative win, and an
      // absolute backdrop with no children then collapses to zero height (the invisible Desktop banner).
      className={`${/\b(absolute|fixed)\b/.test(className ?? '') ? '' : 'relative '}overflow-hidden ${className ?? ''}`}
      style={{ background: 'radial-gradient(circle at 25% 30%, #5a420a 0%, #1c1606 45%, #000 100%)' }}
    >
      <style>{KEYFRAMES}</style>
      {stills.map((src, n) => (
        <img
          key={src}
          src={src}
          alt=""
          aria-hidden
          loading={n === 0 ? 'eager' : 'lazy'}
          className="bwx-kb absolute inset-0 w-full h-full object-cover"
          style={{
            opacity: n === i ? 1 : 0,
            transition: 'opacity 1.6s ease-in-out',
            animation: n === i ? `bwx-kenburns ${SLIDE_MS + 1600}ms ease-out forwards` : undefined,
          }}
        />
      ))}
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(90deg, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.45) 50%, rgba(0,0,0,0.15) 100%)',
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
