import { useEffect, useState } from 'react';
import desert from './just-b-desert.mp4';
import mark from '../brand/bwalletx-glyph.svg';

const SEEN = 'bwx-just-b-intro';
const SHOW_MS = 4200;
const FADE_MS = 900;

/**
 * Desktop opens with the Just b advert (owner, 11 Oct 2026): the black-and-gold desert, "Just" and the gold b, then
 * it fades into the wallet. Once per browser session; a click or any key skips it; reduced motion skips it.
 */
export const JustBIntro = () => {
  const [phase, setPhase] = useState<'show' | 'fade' | 'gone'>(() => {
    try {
      if (sessionStorage.getItem(SEEN)) return 'gone';
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 'gone';
    } catch {
      /* storage blocked: show it */
    }
    return 'show';
  });
  useEffect(() => {
    if (phase === 'gone') return;
    try {
      sessionStorage.setItem(SEEN, '1');
    } catch {
      /* ignore */
    }
    if (phase === 'fade') {
      const t = setTimeout(() => setPhase('gone'), FADE_MS);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setPhase('fade'), SHOW_MS);
    const skip = () => setPhase('fade');
    addEventListener('keydown', skip);
    return () => {
      clearTimeout(t);
      removeEventListener('keydown', skip);
    };
  }, [phase]);
  if (phase === 'gone') return null;
  return (
    <div
      role="presentation"
      onClick={() => setPhase('fade')}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: '#000',
        opacity: phase === 'fade' ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease`,
        cursor: 'pointer',
      }}
    >
      <video
        src={desert}
        autoPlay
        muted
        loop
        playsInline
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />
      <h1
        aria-label="Just b"
        style={{
          position: 'absolute',
          inset: 0,
          margin: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.18em',
          color: '#fff',
          fontSize: 'clamp(56px, 9vw, 140px)',
          fontWeight: 800,
          letterSpacing: '-0.02em',
          textShadow: '0 4px 40px rgba(0,0,0,.5)',
        }}
      >
        Just
        <img src={mark} alt="" style={{ height: '0.86em', width: 'auto', maxWidth: 'none' }} />
      </h1>
    </div>
  );
};
