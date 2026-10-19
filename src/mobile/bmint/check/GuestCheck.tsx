import { createPortal } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import mintMark from '../assets/logos/mint-stamp.svg';
import { CheckPage } from './CheckPage';
import '../bmint.css';

/**
 * Check this mint for a visitor without an unlocked wallet (web/Desktop): a check link someone sent works signed
 * out. Nothing here touches the wallet; "Open bWalletX" hands over to create/unlock.
 */
const GuestCheck = ({ route, onWallet }: { route: string; onWallet: () => void }) =>
  createPortal(
    <div className="fixed inset-0 z-[500] overflow-y-auto" style={{ background: '#07080a' }}>
      <div className="bmint">
        <header className="bm-head">
          <span className="bm-brand">
            <img src={mintMark} alt="" />
            <span>
              b<b>Mint</b>
            </span>
          </span>
          <nav className="bm-tabs" aria-label="bMint">
            <button type="button" className="bm-tab" onClick={onWallet}>
              Open bWalletX
            </button>
          </nav>
        </header>
        <MemoryRouter initialEntries={[route]}>
          <CheckPage />
        </MemoryRouter>
      </div>
    </div>,
    document.body,
  );

export default GuestCheck;
