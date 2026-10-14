import type { ChartSeries } from './chartSeries';

const GOLD = '#F5B800';
const GREEN = '#A1FF8B';
const RED = '#FF6B6B';
const MUTED = '#98A2B3';

const linePoints = (points: number[], W: number, H: number, pad: number) => {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;
  return points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = span ? H - pad - ((p - min) / span) * (H - 2 * pad) : H / 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
};

const lineColor = (s: ChartSeries) =>
  s.kind === 'trades' ? (s.points[s.points.length - 1] >= s.points[0] ? GREEN : RED) : GOLD;

/** Whole-token price chart. Never blank: no trades draws a flat line (or baseline) with a label. */
export const PriceChart = ({ series, priceLabel }: { series: ChartSeries; priceLabel?: (sats: number) => string }) => {
  const W = 600;
  const H = 160;
  const color = lineColor(series);
  const line = linePoints(series.points, W, H, 8);
  const flat = series.kind !== 'trades';
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-40"
        preserveAspectRatio="none"
        role="img"
        aria-label="Price chart"
      >
        {!flat && <polygon points={`0,${H} ${line} ${W},${H}`} fill={color} opacity={0.08} />}
        <polyline
          points={line}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeDasharray={flat ? '6 6' : undefined}
          opacity={series.kind === 'baseline' ? 0.4 : 1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {flat && (
        <div className="absolute inset-x-0 top-2 text-center text-xs" style={{ color: MUTED }}>
          {series.kind === 'flat'
            ? `No trades yet · ${series.source}${priceLabel ? ` ${priceLabel(series.price)}` : ''}`
            : 'No trades yet — be the first'}
        </div>
      )}
      <div className="flex justify-between text-[10px] mt-1" style={{ color: MUTED }}>
        <span>{flat ? 'Launch' : 'Oldest'}</span>
        <span>Now</span>
      </div>
    </div>
  );
};

/** Row-sized sparkline: trades in green/red, otherwise a dotted gold line. */
export const Sparkline = ({ series }: { series: ChartSeries }) => {
  const W = 64;
  const H = 24;
  const flat = series.kind !== 'trades';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} preserveAspectRatio="none" aria-hidden>
      <polyline
        points={linePoints(series.points, W, H, 2)}
        fill="none"
        stroke={lineColor(series)}
        strokeWidth={1.5}
        strokeDasharray={flat ? '2 3' : undefined}
        opacity={flat ? 0.6 : 1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};
