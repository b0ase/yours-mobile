import { useState, type ReactNode } from 'react';
import { BANNER_VIDEO } from '../../web/betaBanner';
import { BETA_RESTORE_TEXT } from './betaTest';
import './betaGate.css';

/**
 * Before restoring or importing an existing wallet: one notice, one tap to continue (beta, 15 Oct 2026). Shown in
 * both editions; it is safety, not trading. Dressed like the web beta banner (owner, 19 Oct 2026): hazard tape (or
 * the optional /media/beta-hazard.mp4 clip), a bold headline, Continue. No Swap / Buy here: there is no wallet yet.
 */
export const BetaGate = ({ children }: { children: ReactNode }) => {
  const [ok, setOk] = useState(false);
  const [video, setVideo] = useState(true);
  if (ok) return <>{children}</>;
  return (
    <div className="bw-betagate" data-testid="beta-gate">
      <div className="bw-betagate-tape" aria-hidden="true">
        {video && <video src={`/${BANNER_VIDEO}`} autoPlay loop muted playsInline onError={() => setVideo(false)} />}
      </div>
      <div className="bw-betagate-body">
        <span className="bw-betagate-tag">Beta</span>
        <h1 className="bw-betagate-title">Start small</h1>
        <p className="bw-betagate-text">{BETA_RESTORE_TEXT}</p>
        <button type="button" className="bw-betagate-go" onClick={() => setOk(true)}>
          Continue
        </button>
      </div>
      <div className="bw-betagate-tape bw-betagate-tape-low" aria-hidden="true" />
    </div>
  );
};
