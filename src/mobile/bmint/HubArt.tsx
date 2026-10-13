import type { ReactNode } from 'react';

/**
 * Gold-on-black art for the bMint hub tiles (owner, 13 Oct 2026: "the cards have no icons as they did
 * before"). Each type gets a drawn, deterministic artwork in a 400×240 frame: no pictures load.
 * The Notes rosette and the OpNS ring + b are the phase-1 landing art.
 */
const W = 400;
const H = 240;
const CX = 200;
const CY = 120;
const G = '#c9a84c';
const f = (n: number) => n.toFixed(1);

/** A closed curve r(t) around (cx, cy), as SVG points. */
const ring = (r: (t: number) => number, cx = CX, cy = CY, steps = 180) => {
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    pts.push(`${f(cx + r(t) * Math.cos(t))},${f(cy + r(t) * Math.sin(t))}`);
  }
  return pts.join(' ');
};

/** The phase-1 guilloche rosette: n wavy rings. */
const Rosette = ({ cx = CX, cy = CY, r0 = 60, n = 14, step = 7, lobes = 12, amp = 10 }) => (
  <>
    {Array.from({ length: n }, (_, k) => (
      <polyline
        key={k}
        points={ring((t) => r0 + k * step + amp * Math.sin(lobes * t + k * 0.4), cx, cy, 240)}
        strokeOpacity={0.55}
      />
    ))}
  </>
);

const Circles = ({ cx = CX, cy = CY, from = 20, to = 100, step = 6 }) => (
  <>
    {Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, k) => (
      <circle key={k} cx={cx} cy={cy} r={from + k * step} strokeOpacity={0.25 + (k % 3) * 0.15} />
    ))}
  </>
);

/** Horizontal sine lattice across the frame (a banknote ground). */
const Lattice = ({ y0 = 0, y1 = H, x0 = 0, x1 = W, n = 10, amp = 8, op = 0.3 }) => (
  <>
    {Array.from({ length: n }, (_, k) => {
      const y = y0 + ((k + 0.5) * (y1 - y0)) / n;
      const pts: string[] = [];
      for (let x = x0; x <= x1; x += 4) pts.push(`${x},${f(y + amp * Math.sin(x / 14 + k))}`);
      return <polyline key={k} points={pts.join(' ')} strokeOpacity={op} />;
    })}
  </>
);

const BMark = ({ cx = CX, cy = CY, size = 64 }) => (
  <text
    x={cx}
    y={cy}
    textAnchor="middle"
    dominantBaseline="central"
    fill="#ffd24d"
    stroke="none"
    fontSize={size}
    fontFamily="'Space Grotesk', system-ui, sans-serif"
    fontWeight={600}
  >
    b
  </text>
);

const ART: Record<string, () => ReactNode> = {
  art: () => (
    <>
      <rect x={110} y={30} width={180} height={180} rx={4} strokeOpacity={0.8} strokeWidth={2} />
      <rect x={122} y={42} width={156} height={156} rx={2} strokeOpacity={0.4} />
      <Rosette r0={14} n={10} step={6} lobes={8} amp={6} />
    </>
  ),
  music: () => (
    <>
      <Circles from={14} to={104} step={5} />
      <circle cx={CX} cy={CY} r={6} fill={G} />
      <line x1={300} y1={20} x2={250} y2={110} strokeWidth={3} strokeOpacity={0.8} />
    </>
  ),
  video: () => (
    <>
      <Lattice y0={60} y1={180} n={8} amp={10} />
      {[44, 196].map((y) => (
        <g key={y}>
          <rect x={-2} y={y - 14} width={W + 4} height={28} strokeOpacity={0.7} />
          {Array.from({ length: 20 }, (_, i) => (
            <rect key={i} x={8 + i * 20} y={y - 6} width={10} height={12} rx={2} strokeOpacity={0.6} />
          ))}
        </g>
      ))}
    </>
  ),
  '3d': () => {
    // An icosahedron-like wireframe: two offset pentagons plus poles.
    const p = (k: number, r: number, a: number, y: number) => [
      CX + r * Math.cos(a + (k * 2 * Math.PI) / 5),
      y + r * 0.35 * Math.sin(a + (k * 2 * Math.PI) / 5),
    ];
    const top = Array.from({ length: 5 }, (_, k) => p(k, 80, 0, 95));
    const bot = Array.from({ length: 5 }, (_, k) => p(k, 80, Math.PI / 5, 150));
    const lines: number[][] = [];
    for (let k = 0; k < 5; k++) {
      const n = (k + 1) % 5;
      lines.push([...top[k], ...top[n]], [...bot[k], ...bot[n]], [...top[k], ...bot[k]], [...top[n], ...bot[k]]);
      lines.push([CX, 30, ...top[k]], [CX, 215, ...bot[k]]);
    }
    return lines.map(([a, b, c, d], i) => <line key={i} x1={f(a)} y1={f(b)} x2={f(c)} y2={f(d)} strokeOpacity={0.6} />);
  },
  books: () => (
    <>
      {Array.from({ length: 13 }, (_, k) => {
        const a = Math.PI + (k / 12) * Math.PI;
        const x = CX + 150 * Math.cos(a);
        const y = 200 + 120 * Math.sin(a) * 0.9;
        return <path key={k} d={`M${CX},200 Q${f((CX + x) / 2)},${f(y - 20)} ${f(x)},${f(y)}`} strokeOpacity={0.55} />;
      })}
      <line x1={CX} y1={70} x2={CX} y2={205} strokeWidth={2} strokeOpacity={0.8} />
    </>
  ),
  website: () => (
    <>
      <rect x={70} y={30} width={260} height={180} rx={10} strokeWidth={2} strokeOpacity={0.8} />
      <line x1={70} y1={56} x2={330} y2={56} strokeOpacity={0.6} />
      {[86, 100, 114].map((x) => (
        <circle key={x} cx={x} cy={43} r={4} strokeOpacity={0.8} />
      ))}
      <Lattice x0={80} x1={320} y0={64} y1={204} n={9} amp={6} op={0.4} />
    </>
  ),
  tickets: () => (
    <>
      <path
        d="M60,60 H340 V100 A20,20 0 0 0 340,140 V180 H60 V140 A20,20 0 0 0 60,100 Z"
        strokeWidth={2}
        strokeOpacity={0.8}
      />
      <line x1={270} y1={64} x2={270} y2={176} strokeDasharray="4 6" strokeOpacity={0.7} />
      <Rosette cx={165} r0={10} n={8} step={5} lobes={10} amp={4} />
    </>
  ),
  coin: () => (
    <>
      <circle cx={CX} cy={CY} r={100} strokeWidth={3} strokeOpacity={0.8} />
      {Array.from({ length: 90 }, (_, k) => {
        const a = (k / 90) * Math.PI * 2;
        return (
          <line
            key={k}
            x1={f(CX + 92 * Math.cos(a))}
            y1={f(CY + 92 * Math.sin(a))}
            x2={f(CX + 100 * Math.cos(a))}
            y2={f(CY + 100 * Math.sin(a))}
            strokeOpacity={0.6}
          />
        );
      })}
      <Rosette r0={16} n={10} step={6} lobes={12} amp={5} />
    </>
  ),
  bpics: () => (
    <>
      <Circles from={96} to={108} step={6} />
      {Array.from({ length: 8 }, (_, k) => {
        const a = (k / 8) * Math.PI * 2;
        const b = a + 1.1;
        return (
          <path
            key={k}
            d={`M${f(CX + 96 * Math.cos(a))},${f(CY + 96 * Math.sin(a))} L${f(CX + 34 * Math.cos(b))},${f(CY + 34 * Math.sin(b))}`}
            strokeWidth={1.5}
            strokeOpacity={0.7}
          />
        );
      })}
      <polygon
        points={Array.from({ length: 8 }, (_, k) => {
          const a = (k / 8) * Math.PI * 2 + 1.1;
          return `${f(CX + 34 * Math.cos(a))},${f(CY + 34 * Math.sin(a))}`;
        }).join(' ')}
        strokeOpacity={0.9}
      />
    </>
  ),
  release: () => (
    <>
      <rect x={60} y={20} width={200} height={200} rx={4} strokeOpacity={0.7} strokeWidth={2} />
      <Circles cx={250} from={20} to={98} step={6} />
      <circle cx={250} cy={CY} r={10} fill={G} />
    </>
  ),
  notes: () => <Rosette />,
  opns: () => (
    <>
      <circle cx={CX} cy={CY} r={84} strokeWidth={9} strokeOpacity={0.85} />
      <circle cx={CX} cy={CY} r={64} strokeWidth={2} strokeOpacity={0.55} />
      <BMark size={64} />
    </>
  ),
  bavatar: () => (
    <>
      <Rosette r0={74} n={6} step={6} lobes={20} amp={4} />
      <ellipse cx={CX} cy={CY} rx={62} ry={70} strokeWidth={2} strokeOpacity={0.8} />
      <circle cx={CX} cy={102} r={20} strokeOpacity={0.8} />
      <path d={`M158,170 Q${CX},120 242,170`} strokeOpacity={0.8} />
    </>
  ),
  handle: () => (
    <>
      <Rosette r0={74} n={6} step={6} lobes={16} amp={4} />
      <circle cx={CX} cy={CY} r={66} strokeWidth={2} strokeOpacity={0.8} />
      <text
        x={CX}
        y={CY}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#ffd24d"
        stroke="none"
        fontSize={72}
        fontFamily="'Space Grotesk', system-ui, sans-serif"
      >
        @
      </text>
    </>
  ),
};

/** Ground behind the "with b" tiles: the gold b mark in a guilloche ring. */
const withB = () => (
  <>
    <Lattice n={12} amp={6} op={0.18} />
    <circle cx={CX} cy={CY} r={56} strokeWidth={2} strokeOpacity={0.8} />
    <BMark size={60} />
  </>
);

const CHIP: Record<string, string> = {
  art: 'Art',
  music: 'Music',
  video: 'Video',
  '3d': '3D',
  books: 'Books',
  website: 'Web',
  tickets: 'Tickets',
  coin: 'Coin',
  bpics: 'Photos',
  release: 'Release',
  notes: 'Notes',
  opns: 'Names',
  bavatar: 'Avatar',
  handle: 'Handle',
};

/** The tile's art panel: drawn artwork with its category chip over it. */
export const HubArt = ({ id, agent }: { id: string; agent?: boolean }) => (
  <span className="bm-type-media">
    <svg
      className="bm-type-art"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      fill="none"
      stroke={G}
      strokeWidth={1}
    >
      {(agent ? withB : (ART[id] ?? withB))()}
    </svg>
    <span className="bm-chip">{agent ? 'With b' : (CHIP[id] ?? 'Mint')}</span>
  </span>
);
