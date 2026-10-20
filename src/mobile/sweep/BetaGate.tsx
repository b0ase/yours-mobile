import { useState, type ReactNode } from 'react';
import { BANNER_VIDEO } from '../../web/betaBanner';
import { BETA_GATE_TEXT } from './betaTest';
import './betaGate.css';

/**
 * Before restoring or importing an existing wallet: one notice, one tap to continue (beta, 15 Oct 2026). Shown in
 * both editions; it is safety, not trading. Dressed like the web beta banner (owner, 19 Oct 2026): hazard tape (or
 * the optional /media/beta-hazard.mp4 clip), a bold headline, Continue. No Swap / Buy here: there is no wallet yet.
 */
export const BetaGate = ({ children, onBack }: { children: ReactNode; onBack?: () => void }) => {
  const [ok, setOk] = useState(false);
  const [video, setVideo] = useState(true);
  if (ok) return <>{children}</>;
  return (
    // The whole screen is the button: tap anywhere (owner, 20 Oct 2026).
    <div
      className="bw-betagate"
      data-testid="beta-gate"
      role="button"
      tabIndex={0}
      onClick={() => setOk(true)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOk(true)}
    >
      <div className="bw-betagate-tape" aria-hidden="true">
        {video && <video src={`/${BANNER_VIDEO}`} autoPlay loop muted playsInline onError={() => setVideo(false)} />}
      </div>
      <div className="bw-betagate-body">
        <span className="bw-betagate-tag">Beta</span>
        <h1 className="bw-betagate-title">Dream big. Start small.</h1>
        <p className="bw-betagate-text">{BETA_GATE_TEXT}</p>
        <span className="bw-betagate-go">Tap anywhere to continue</span>
        {onBack && (
          // A way out (owner, 20 Oct 2026: stuck on Restore with no way back to sign up or unlock).
          <button
            type="button"
            className="bw-betagate-back"
            data-testid="beta-gate-back"
            onClick={(e) => {
              e.stopPropagation();
              onBack();
            }}
          >
            Not now
          </button>
        )}
      </div>
      <div className="bw-betagate-tape bw-betagate-tape-low" aria-hidden="true" />
    </div>
  );
};
