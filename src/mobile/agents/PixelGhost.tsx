/**
 * The agent-account ghost (owner, 6 Oct 2026): a little pixel arcade ghost marks an agent account, in that
 * account's colour (agentAccounts.ts ghostColorOf), on the wallet card and as the account's avatar.
 *
 * 14×14 pixels drawn as SVG rects, so it stays crisp at any size. Two frames: the skirt ripples and the
 * eyes glance left and right (CSS in mobile.css, .bw-ghost*). Still under prefers-reduced-motion.
 */
const BODY = [
  '.....####.....',
  '...########...',
  '..##########..',
  '.############.',
  '.############.',
  '.############.',
  '##############',
  '##############',
  '##############',
  '##############',
  '##############',
  '##############',
];
const SKIRT_A = ['##.###..###.##', '#...##..##...#'];
const SKIRT_B = ['####.####.####', '.##...##...##.'];
// Eye whites (white) and pupils (blue), per glance direction.
const WHITES = [
  [3, 3, 2, 1], [2, 4, 4, 2], [3, 6, 2, 1],
  [9, 3, 2, 1], [8, 4, 4, 2], [9, 6, 2, 1],
];

const rects = (rows: string[], y0: number) =>
  rows.flatMap((row, y) => [...row].flatMap((c, x) => (c === '#' ? [<rect key={`${x},${y0 + y}`} x={x} y={y0 + y} width={1.02} height={1.02} />] : [])));

export const PixelGhost = ({ color, size = 28, title }: { color: string; size?: number; title?: string }) => (
  <svg
    className="bw-ghost"
    width={size}
    height={size}
    viewBox="0 0 14 14"
    shapeRendering="crispEdges"
    role={title ? 'img' : undefined}
    aria-label={title}
    aria-hidden={title ? undefined : true}
  >
    <g fill={color}>
      {rects(BODY, 0)}
      <g className="bw-ghost-a">{rects(SKIRT_A, 12)}</g>
      <g className="bw-ghost-b">{rects(SKIRT_B, 12)}</g>
    </g>
    <g fill="#FFFFFF">
      {WHITES.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} />
      ))}
    </g>
    <g fill="#2121DE">
      <g className="bw-ghost-look-l">
        <rect x={2} y={5} width={2} height={2} />
        <rect x={8} y={5} width={2} height={2} />
      </g>
      <g className="bw-ghost-look-r">
        <rect x={4} y={5} width={2} height={2} />
        <rect x={10} y={5} width={2} height={2} />
      </g>
    </g>
  </svg>
);
