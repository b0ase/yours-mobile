/**
 * The bBot (Head of Design, 2 Nov 2026): our own helper-robot mascot. It marks an agent account, in that
 * account's colour (agentAccounts.ts botColorOf), on the wallet card, as the account's avatar and on pots.
 *
 * A robot, not a ghost: square head with ear bolts, a dark visor with two eyes, a neck, a body with a small
 * "b", and a flat hover-base. Master art: src/mobile/brand/bbot/ (bbot.svg full, bbot-compact.svg for 16-32px).
 * Below 40px the compact drawing is used (bigger eyes, thicker strokes, no "b"). Idle motion (bob, blink,
 * antenna pulse) is CSS in mobile.css (.bw-bbot*), and stops under prefers-reduced-motion.
 */
import type { CSSProperties } from 'react';

/** The six bBot colours, each with the deeper shade used for its outline, antenna and base. */
const BBOT_DEEP: Record<string, string> = {
  '#F5B800': '#8A6400', // gold
  '#2FD58E': '#0E7A4C', // mint
  '#8B7CFF': '#4B3BC4', // iris
  '#3D8BFF': '#1D4FB8', // azure
  '#A8E03A': '#56800E', // lime
  '#AEB6C2': '#59626F', // steel
};

const deepOf = (color: string) => BBOT_DEEP[color.toUpperCase()] ?? `color-mix(in srgb, ${color} 55%, #000)`;

const VISOR = '#0F1013';

const Full = () => (
  <>
    <rect x="4.6" y="20.6" width="14.8" height="2.1" rx="1.05" fill="var(--bb-deep)" />
    <rect x="6.4" y="20.95" width="11.2" height=".5" rx=".25" fill="var(--bb)" fillOpacity=".55" />
    <g className="bw-bbot-bob">
      <rect x="11.35" y="1.9" width="1.3" height="2.8" rx=".65" fill="var(--bb-deep)" />
      <circle
        className="bw-bbot-tip"
        cx="12"
        cy="1.9"
        r="1.35"
        fill="var(--bb)"
        stroke="var(--bb-deep)"
        strokeWidth=".5"
      />
      <rect x="2.7" y="7.2" width="1.7" height="3.4" rx=".7" fill="var(--bb-deep)" />
      <rect x="19.6" y="7.2" width="1.7" height="3.4" rx=".7" fill="var(--bb-deep)" />
      <rect x="10.2" y="13.4" width="3.6" height="1.4" fill="var(--bb-deep)" />
      <rect x="4" y="4.4" width="16" height="9.4" rx="3" fill="var(--bb)" stroke="var(--bb-deep)" strokeWidth=".7" />
      <rect x="6.3" y="5.25" width="3.6" height=".6" rx=".3" fill="#fff" fillOpacity=".5" />
      <rect x="5.8" y="6.6" width="12.4" height="5.4" rx="2.7" fill={VISOR} />
      <rect x="6.9" y="7.2" width="10.2" height=".5" rx=".25" fill="#fff" fillOpacity=".14" />
      <g className="bw-bbot-eyes">
        <rect x="8" y="7.9" width="2.8" height="2.8" rx="1.1" fill="var(--bb)" />
        <rect x="13.2" y="7.9" width="2.8" height="2.8" rx="1.1" fill="var(--bb)" />
      </g>
      <rect
        x="6.6"
        y="14.5"
        width="10.8"
        height="5.6"
        rx="1.8"
        fill="var(--bb)"
        stroke="var(--bb-deep)"
        strokeWidth=".7"
      />
      <path
        d="M11.05 15.55V19.1M11.05 18.15a.95 .95 0 1 0 1.9 0a.95 .95 0 1 0-1.9 0"
        fill="none"
        stroke="var(--bb-deep)"
        strokeWidth=".6"
        strokeLinecap="round"
      />
    </g>
  </>
);

const Compact = () => (
  <>
    <rect x="4" y="20.5" width="16" height="2.7" rx="1.35" fill="var(--bb-deep)" />
    <g className="bw-bbot-bob">
      <rect x="11" y="1.8" width="2" height="2.8" rx="1" fill="var(--bb-deep)" />
      <circle
        className="bw-bbot-tip"
        cx="12"
        cy="2.1"
        r="1.8"
        fill="var(--bb)"
        stroke="var(--bb-deep)"
        strokeWidth=".7"
      />
      <rect x="9.4" y="14.4" width="5.2" height="1.6" fill="var(--bb-deep)" />
      <rect
        x="2.8"
        y="4.3"
        width="18.4"
        height="10.6"
        rx="3.2"
        fill="var(--bb)"
        stroke="var(--bb-deep)"
        strokeWidth=".9"
      />
      <rect x="4.8" y="6.4" width="14.4" height="6.3" rx="3.15" fill={VISOR} />
      <g className="bw-bbot-eyes">
        <rect x="7" y="7.85" width="3.6" height="3.4" rx="1.4" fill="var(--bb)" />
        <rect x="13.4" y="7.85" width="3.6" height="3.4" rx="1.4" fill="var(--bb)" />
      </g>
      <rect
        x="6.2"
        y="15.6"
        width="11.6"
        height="4.3"
        rx="1.6"
        fill="var(--bb)"
        stroke="var(--bb-deep)"
        strokeWidth=".9"
      />
    </g>
  </>
);

export const BBot = ({
  color,
  size = 28,
  title,
  variant,
}: {
  color: string;
  size?: number;
  title?: string;
  /** Defaults to 'compact' below 40px. */
  variant?: 'full' | 'compact';
}) => {
  const v = variant ?? (size < 40 ? 'compact' : 'full');
  return (
    <svg
      className="bw-bbot"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ '--bb': color, '--bb-deep': deepOf(color) } as CSSProperties}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {v === 'full' ? <Full /> : <Compact />}
    </svg>
  );
};
