import { DOWN, GOLD, MUTED, UP } from './chartFormat';

/** The chart pieces shared by PriceChart.tsx (BSV) and TokenPriceChart.tsx (token market chart, bWalletX only). */
/** Gold line with a glow, a fading fill and a pulsing dot at the latest point (owner, 5 Oct 2026: "flashier"). */
export const Spark = ({ ys, id }: { ys: number[]; id: string }) => {
  const W = 300;
  const H = 110;
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const xy = ys.map((y, i) => [(i / (ys.length - 1)) * W, H - 8 - ((y - min) / (max - min || 1)) * (H - 20)] as const);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy[xy.length - 1];
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-28 block overflow-visible">
        <defs>
          <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GOLD} stopOpacity="0.35" />
            <stop offset="100%" stopColor={GOLD} stopOpacity="0" />
          </linearGradient>
          <filter id={`glow-${id}`} x="-10%" y="-30%" width="120%" height="160%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <polygon points={`0,${H} ${line} ${W},${H}`} fill={`url(#fill-${id})`} />
        <polyline
          points={line}
          fill="none"
          stroke={GOLD}
          strokeWidth="2.2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          filter={`url(#glow-${id})`}
        />
      </svg>
      {/* Dot as HTML so it stays round under preserveAspectRatio="none". */}
      <span
        className="absolute w-2.5 h-2.5 rounded-full animate-pulse"
        style={{
          left: `calc(${(lx / W) * 100}% - 5px)`,
          top: `calc(${(ly / H) * 100}% - 5px)`,
          background: GOLD,
          boxShadow: `0 0 10px ${GOLD}`,
        }}
      />
    </div>
  );
};

export const Ranges = <T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: T[];
  onChange: (v: T) => void;
}) => (
  <div className="flex gap-1 mt-2">
    {options.map((o) => (
      <button
        key={o}
        type="button"
        onClick={() => onChange(o)}
        className="flex-1 py-1 rounded-lg text-[11px] font-bold border-0 cursor-pointer"
        style={{
          background: o === value ? `color-mix(in srgb, ${GOLD} 13%, transparent)` : 'transparent',
          color: o === value ? GOLD : MUTED,
        }}
      >
        {o}
      </button>
    ))}
  </div>
);

export const Header = ({
  price,
  unit,
  change,
  note,
}: {
  price: string;
  unit: string;
  change: number;
  note: string;
}) => (
  <div className="mb-2">
    <div className="flex items-baseline gap-1.5">
      <span className="text-2xl font-extrabold text-white tracking-tight">{price}</span>
      <span className="text-xs" style={{ color: MUTED }}>
        {unit}
      </span>
    </div>
    <span className="text-xs font-bold" style={{ color: change >= 0 ? UP : DOWN }}>
      {change >= 0 ? '▲ +' : '▼ '}
      {change.toFixed(1)}%<span style={{ color: MUTED, fontWeight: 400 }}> · {note}</span>
    </span>
  </div>
);
