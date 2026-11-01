import { useEffect, useId } from 'react';
import bebasUrl from '../bmint/assets/fonts/bebas-neue-400.woff2?url';
import type { ServiceStyle } from './serviceStyles';

/* How each of our services draws its logo and hero (owner, 1 Nov 2026); the data is in serviceStyles.ts. */

/** bMovies' display face, self-hosted (the woff2 bMint ships), loaded once when a bMoviesX lockup first shows. */
let bebas: Promise<void> | null = null;
const loadBebas = () =>
  (bebas ??= (async () => {
    try {
      if (typeof FontFace === 'undefined' || !document.fonts) return;
      document.fonts.add(await new FontFace('Bebas Neue', `url(${bebasUrl})`).load());
    } catch {
      // offline: the fallback faces
    }
  })());

const FONTS = {
  grotesk: "'Space Grotesk', Inter, system-ui, sans-serif",
  bebas: "'Bebas Neue', Oswald, Impact, sans-serif",
  heavy: 'Inter, system-ui, sans-serif',
};

/** The b mark, drawn as the family draws it (bmodelx.com's mark: a chamfered stem and a bowl with its counter). */
export const BMark = ({ kind, size, fit }: { kind: ServiceStyle['mark']; size: number; fit?: boolean }) => {
  const id = useId().replace(/:/g, '');
  const fill =
    kind === 'red'
      ? 'url(#r' + id + ')'
      : kind === 'multi'
        ? 'url(#m' + id + ')'
        : kind === 'white'
          ? '#ffffff'
          : 'url(#g' + id + ')';
  return (
    <svg
      viewBox="23 8 74 100"
      width={fit ? undefined : size * 0.74}
      height={fit ? '100%' : size}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flex: 'none' }}
    >
      <defs>
        <linearGradient id={'g' + id} gradientUnits="userSpaceOnUse" x1="0" y1="12" x2="0" y2="105">
          <stop offset="0" stopColor="#FFE58A" />
          <stop offset=".55" stopColor="#FFD24D" />
          <stop offset="1" stopColor="#C98F00" />
        </linearGradient>
        <linearGradient id={'r' + id} gradientUnits="userSpaceOnUse" x1="0" y1="12" x2="0" y2="105">
          <stop offset="0" stopColor="#ff3b3b" />
          <stop offset="1" stopColor="#b0060f" />
        </linearGradient>
        <linearGradient id={'m' + id} gradientUnits="userSpaceOnUse" x1="30" y1="14" x2="90" y2="104">
          <stop offset="0" stopColor="#e53935" />
          <stop offset=".34" stopColor="#1e6fe0" />
          <stop offset=".64" stopColor="#f5b800" />
          <stop offset="1" stopColor="#43a047" />
        </linearGradient>
        <mask id={'k' + id}>
          <rect x="0" y="0" width="140" height="140" fill="#fff" />
          <circle cx="60" cy="72" r="15" fill="#000" />
        </mask>
      </defs>
      <g fill={fill} mask={'url(#k' + id + ')'}>
        <polygon points="45,12 45,76 27,76 27,30" />
        <circle cx="60" cy="72" r="33" />
      </g>
    </svg>
  );
};

const ink = (c: string): React.CSSProperties =>
  c.startsWith('linear-gradient')
    ? { backgroundImage: c, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }
    : { color: c };

/** The service's wordmark only (no mark), at `size` px. */
export const Wordmark = ({ s, size }: { s: ServiceStyle; size: number }) => {
  useEffect(() => {
    if (s.font === 'bebas') void loadBebas();
  }, [s.font]);
  return (
    <span
      className="whitespace-nowrap"
      style={{
        fontFamily: FONTS[s.font],
        fontWeight: s.font === 'bebas' ? 400 : s.font === 'heavy' ? 800 : 700,
        fontSize: s.font === 'bebas' ? size * 1.2 : size,
        letterSpacing: s.font === 'bebas' ? '0.01em' : '-0.03em',
        lineHeight: 1,
      }}
    >
      <span style={ink(s.headInk)}>{s.head}</span>
      <span style={ink(s.tailInk)}>{s.tail}</span>
    </span>
  );
};

/** Mark + wordmark, the way each site sets its logo. bVideoX sets its wordmark alone. */
export const Lockup = ({ s, size }: { s: ServiceStyle; size: number }) => (
  <span className="inline-flex min-w-0 items-center" style={{ gap: size * 0.28 }}>
    {s.mark !== 'white' && <BMark kind={s.mark} size={size * 1.05} />}
    <Wordmark s={s} size={size} />
  </span>
);

/**
 * The service's own hero when there is no share art (a store build, and bModelX, whose site has none): its tint and
 * visuals (bMusicX's waveform and disc, bMoviesX's film edges, bVideoX's strip, the gold family's glow) with its
 * lockup large in the middle. No pitch, no prices.
 */
export const BrandPanel = ({ s, children }: { s: ServiceStyle; children?: React.ReactNode }) => (
  <div
    className="relative grid h-full w-full place-items-center overflow-hidden"
    style={{
      background:
        s.panel === 'music'
          ? 'radial-gradient(circle at 30% 40%, #0c2a5c 0%, #050f22 55%, #010101 100%)'
          : s.panel === 'movies'
            ? 'radial-gradient(circle at 25% 45%, #5a0008 0%, #1a0003 55%, #000 100%)'
            : `radial-gradient(circle at 30% 40%, ${s.tint} 0%, #0b0c0e 70%, #000 100%)`,
    }}
  >
    {s.panel === 'music' && (
      <>
        <svg
          className="absolute inset-x-0 bottom-0"
          width="100%"
          height="38%"
          preserveAspectRatio="none"
          viewBox="0 0 120 40"
        >
          {Array.from({ length: 60 }, (_, i) => {
            const h = 8 + Math.abs(Math.sin(i * 0.9) * 18 + Math.sin(i * 0.37) * 12);
            return <rect key={i} x={i * 2} y={40 - h} width="1.1" height={h} fill="#2f6bff" opacity="0.55" />;
          })}
        </svg>
        <span
          className="absolute right-[4%] top-1/2 aspect-square h-[62%] -translate-y-1/2 rounded-full"
          style={{
            background: 'repeating-radial-gradient(circle, #0d0d0f 0 2px, #17181c 2px 4px)',
            boxShadow: '0 0 0 1px rgba(79,134,255,0.35), 0 0 40px rgba(47,107,255,0.25)',
          }}
        >
          <span
            className="absolute left-1/2 top-1/2 grid aspect-square h-[30%] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full"
            style={{ background: '#2f6bff' }}
          >
            <BMark kind="white" size={18} />
          </span>
        </span>
      </>
    )}
    {s.panel === 'movies' && (
      <>
        {[0, 1].map((i) => (
          <span
            key={i}
            className={`absolute inset-x-0 h-3 ${i ? 'bottom-2' : 'top-2'}`}
            style={{
              background: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.18) 0 10px, transparent 10px 22px)',
            }}
          />
        ))}
      </>
    )}
    {s.panel === 'video' && (
      <span
        className="absolute inset-x-0 bottom-0 h-[34%]"
        style={{
          background:
            'repeating-linear-gradient(90deg, rgba(255,210,77,0.16) 0 64px, transparent 64px 70px), linear-gradient(0deg, rgba(0,0,0,0.6), transparent)',
        }}
      />
    )}
    {(s.panel === 'gold' || s.panel === 'market') && (
      <span className="absolute right-[5%] top-[8%] h-[84%] opacity-[0.13]">
        <BMark kind={s.mark === 'multi' ? 'multi' : 'gold'} size={180} fit />
      </span>
    )}
    <div className={`relative flex flex-col gap-2 ${s.panel === 'movies' ? 'items-center' : 'mr-auto pl-[7%]'}`}>
      <span className="sm:hidden">
        <Lockup s={s} size={30} />
      </span>
      <span className="hidden sm:block">
        <Lockup s={s} size={50} />
      </span>
      {s.tagline && (
        <p className="m-0 max-w-[68%] text-[14px] leading-snug" style={{ color: '#a9a69c' }}>
          {s.tagline}
        </p>
      )}
      {children}
    </div>
  </div>
);
