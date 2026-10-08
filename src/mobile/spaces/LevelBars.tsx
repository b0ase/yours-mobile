import { useEffect, useRef, useState } from 'react';
import { MicOff } from 'lucide-react';
import { levelToBars } from './levelMeter';

const BAR_GOLD = '#F5B800';
const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A small live level meter for one stage tile. It polls the level at ~10 Hz into its own state,
 * so only this meter re-renders. Muted: flat bars and a mic-off icon. Reduced motion: a static
 * indicator (full bars while speaking, flat otherwise).
 */
export function LevelBars({
  read,
  speaking,
  muted,
}: {
  read: () => number;
  speaking: boolean;
  muted: boolean;
}) {
  const [level, setLevel] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  const still = reducedMotion();
  useEffect(() => {
    if (muted || still) return;
    const id = window.setInterval(() => {
      const next = Math.round(readRef.current() * 50) / 50;
      setLevel((prev) => (prev === next ? prev : next));
    }, 100);
    return () => {
      window.clearInterval(id);
      setLevel(0);
    };
  }, [muted, still]);
  const heights = muted ? levelToBars(0) : still ? levelToBars(speaking ? 0.4 : 0) : levelToBars(level);
  return (
    <span className="inline-flex shrink-0 items-center gap-[2px]" aria-hidden="true" style={{ height: 12 }}>
      {muted && <MicOff size={11} color="#fff" style={{ marginRight: 2 }} />}
      {heights.map((h, i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: 12,
            borderRadius: 2,
            background: muted ? 'rgba(255,255,255,.45)' : BAR_GOLD,
            transform: `scaleY(${h})`,
            transformOrigin: 'bottom',
            transition: still ? undefined : 'transform 90ms linear',
          }}
        />
      ))}
    </span>
  );
}
