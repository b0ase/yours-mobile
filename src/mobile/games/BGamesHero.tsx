import { useEffect, useState } from 'react';
import heroVideo from './bgames-hero.mp4';
import heroPoster from './bgames-hero.jpg';

/**
 * bGames hero (owner, 11 Oct 2026: "the splash page … is SO COOL, use that and just change the title to bGames"):
 * a full-bleed gameplay loop with a dark scrim on the text side, a product code line, a mega Audiowide title,
 * stickers and a hazard band. Reduced motion or Save-Data show the poster only.
 */
const FONTS_ID = 'bgames-hero-fonts';
const FONTS =
  'https://fonts.googleapis.com/css2?family=Audiowide&family=Barlow+Condensed:ital,wght@1,800&family=Space+Mono:wght@700&display=swap';
const RED = '#ff3b30';
const RED_FILL = '#e8261d';
const AMBER = '#ffb800';
const PANEL = '#010101';

const motionOk = () => {
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    return !(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  } catch {
    return true;
  }
};

/** `top`: the hero opens the page (pulls up over the page padding); otherwise it sits inside a scrolling list. */
export const BGamesHero = ({ top = true }: { top?: boolean }) => {
  const [motion] = useState(motionOk);
  useEffect(() => {
    if (document.getElementById(FONTS_ID)) return;
    const link = document.createElement('link');
    link.id = FONTS_ID;
    link.rel = 'stylesheet';
    link.href = FONTS;
    document.head.appendChild(link);
  }, []);
  const code = { fontFamily: '"Space Mono", ui-monospace, monospace', fontSize: 10, letterSpacing: '0.14em' } as const;
  return (
    <header
      className={`relative -mx-4 overflow-hidden${top ? ' -mt-4' : ' rounded-xl'}`}
      style={{ minHeight: 'clamp(300px, 52vh, 560px)', background: PANEL }}
      aria-label="bGames"
    >
      {motion ? (
        <video
          src={heroVideo}
          poster={heroPoster}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          className="absolute inset-0 h-full w-full object-cover"
          aria-hidden
        />
      ) : (
        <img src={heroPoster} alt="" className="absolute inset-0 h-full w-full object-cover" aria-hidden />
      )}
      {/* Directional scrim: dark on the text side, clear on the art side. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `linear-gradient(to top, ${PANEL} 8%, rgba(1,1,1,0.75) 45%, rgba(1,1,1,0.15) 85%), linear-gradient(90deg, rgba(1,1,1,0.85) 0%, rgba(1,1,1,0.35) 55%, transparent 80%)`,
        }}
        aria-hidden
      />
      <div className="relative flex h-full flex-col justify-end px-5 pb-8 pt-24" style={{ minHeight: 'inherit' }}>
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 uppercase" style={code}>
          <span style={{ color: RED }}>BG-001 / Live on mainnet</span>
          <span style={{ color: '#98A2B3' }}>bGames</span>
        </div>
        <h1
          className="m-0 text-white"
          style={{
            fontFamily: 'Audiowide, "Barlow Condensed", Impact, sans-serif',
            fontSize: 'clamp(44px, 9vw, 120px)',
            lineHeight: 0.95,
            textShadow: `0 2px 0 ${PANEL}, 0 0 18px ${PANEL}`,
          }}
        >
          bGames<span style={{ color: RED }}>.</span>
        </h1>
        <p
          className="m-0 mt-2 uppercase text-white"
          style={{
            fontFamily: '"Barlow Condensed", Impact, sans-serif',
            fontStyle: 'italic',
            fontWeight: 800,
            fontSize: 'clamp(18px, 2.6vw, 30px)',
            lineHeight: 1,
          }}
        >
          The arcade on Bitcoin<span style={{ color: RED }}>.</span>
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span
            className="px-2 py-1 uppercase"
            style={{
              ...code,
              fontSize: 12,
              fontWeight: 700,
              background: AMBER,
              color: '#0a0a0c',
              transform: 'rotate(-1.5deg)',
            }}
          >
            Your wallet is your controller
          </span>
          <span
            className="px-2 py-1 uppercase"
            style={{ ...code, fontWeight: 700, background: RED_FILL, color: '#fff', transform: 'rotate(1deg)' }}
          >
            Open source
          </span>
        </div>
      </div>
      <div
        className="absolute inset-x-0 bottom-0 h-2"
        style={{ background: `repeating-linear-gradient(-45deg, ${AMBER} 0 12px, #0a0a0c 12px 24px)` }}
        aria-hidden
      />
    </header>
  );
};
