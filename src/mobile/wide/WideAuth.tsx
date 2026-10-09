import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { WIDE_ON } from './flag';
import { APP_NAME } from '../storeBuild';
import mark from '../brand/bwalletx-glyph.svg';
import poster from '../brand/bg/wallet-card.jpg';

const FEATURES = [
  ['bMail', 'Mail that pays: postage in, spam out.'],
  ['Spaces & chat', 'Rooms, live audio and token-gated groups.'],
  ['bApps', 'Apps that open inside your wallet.'],
  ['Your keys', 'They stay in this browser. Nobody else holds them.'],
];

/**
 * Wide layout: welcome, create, restore, import, seed backup and unlock share one composition (mobile.css html.ww-onb):
 * a full-viewport background, the bWalletX story on the left, and the real phone flow on the right as the action
 * panel (~420px, vertically centred, no frame). A no-op outside the wide layout.
 */
export const WideAuth = ({ children }: { children: ReactNode }) => {
  useEffect(() => {
    if (!WIDE_ON) return;
    document.documentElement.classList.add('ww-onb');
    // The phone flow lays out in absolute layers inside a zero-height box, so the panel can't size itself in CSS:
    // measure the content and fit the panel to it (capped to the window; it scrolls beyond that).
    const root = document.getElementById('root');
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!root) return;
        const top = root.scrollTop;
        root.style.height = '1px';
        root.scrollTop = 0;
        const h = root.scrollHeight;
        const max = window.innerHeight - 48;
        root.style.height = `${Math.min(h, max)}px`;
        // Fits: show it from the top. Taller than the window: keep the reader's place.
        root.scrollTop = h <= max ? 0 : top;
      });
    };
    fit();
    const mo = new MutationObserver(fit);
    if (root) mo.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    addEventListener('resize', fit);
    return () => {
      mo.disconnect();
      removeEventListener('resize', fit);
      cancelAnimationFrame(frame);
      if (root) root.style.height = '';
      document.documentElement.classList.remove('ww-onb');
    };
  }, []);
  if (!WIDE_ON) return <>{children}</>;
  return (
    <>
      {createPortal(
        <div className="ww-auth" aria-hidden={false}>
          <img className="ww-auth-bg" src={poster} alt="" />
          <div className="ww-auth-hero">
            <img src={mark} alt="" width={88} height={88} />
            <h1>{APP_NAME}</h1>
            <p className="ww-auth-pitch">Money, mail, rooms and apps in one wallet you own.</p>
            <ul>
              {FEATURES.map(([t, d]) => (
                <li key={t}>
                  <b>{t}</b>
                  <span>{d}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>,
        document.body,
      )}
      {children}
    </>
  );
};
