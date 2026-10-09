import { useLayoutEffect, type ReactNode } from 'react';
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
  useLayoutEffect(() => {
    if (!WIDE_ON) return;
    document.documentElement.classList.add('ww-onb');
    // One fixed panel size for every step (mobile.css html.ww-onb #root): no measuring, so no height jumps.
    return () => {
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
