import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { GuestCtx } from '../../media/artists/guestCtx';
import { toPublic } from '../../url/publicUrl';
import { resumeAt } from '../../url/resume';
import NameStorePage from './NameStorePage';

/** Keeps the address bar on /names and remembers it (a Buy or Claim sets its own resume target). */
const Sync = () => {
  const { pathname, search } = useLocation();
  useEffect(() => {
    resumeAt(pathname + search);
    const next = toPublic(pathname, search);
    if (next !== window.location.pathname + window.location.search) window.history.replaceState(null, '', next);
  }, [pathname, search]);
  return null;
};

/**
 * The Name Store for a visitor without an unlocked wallet (web/Desktop; guest-first like the bMusic pages).
 * Search and browse work; Buy / Claim call `onWallet`, which opens create/unlock and comes back to the name.
 */
const GuestNames = ({ route, onWallet }: { route: string; onWallet: () => void }) =>
  createPortal(
    <div className="fixed inset-0 z-[500]" style={{ background: '#07080a' }}>
      <GuestCtx.Provider value={onWallet}>
        <MemoryRouter initialEntries={[route]}>
          <Sync />
          <Routes>
            <Route path="*" element={<NameStorePage />} />
          </Routes>
        </MemoryRouter>
      </GuestCtx.Provider>
    </div>,
    document.body,
  );

export default GuestNames;
