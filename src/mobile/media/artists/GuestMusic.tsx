import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import ArtistsPage from './ArtistsPage';
import { GuestCtx } from './guestCtx';
import { toPublic } from '../../url/publicUrl';
import { resumeAt } from '../../url/resume';

/** Keeps the address bar on the page the guest is reading, and remembers it for after create/unlock. */
const Sync = () => {
  const { pathname } = useLocation();
  useEffect(() => {
    resumeAt(pathname);
    const next = toPublic(pathname, '');
    if (next !== window.location.pathname) window.history.replaceState(null, '', next);
  }, [pathname]);
  return null;
};

/**
 * bMusic artist and album pages for a visitor without an unlocked wallet (web/Desktop; guest-first, like Space
 * pages). Only these read-only routes render here; `onWallet` leaves for create/unlock, and UrlSync brings the
 * visitor back to the same page afterwards.
 */
const GuestMusic = ({ route, onWallet }: { route: string; onWallet: () => void }) =>
  createPortal(
    <div className="fixed inset-0 z-[500]" style={{ background: '#010101' }}>
      <GuestCtx.Provider value={onWallet}>
        <MemoryRouter initialEntries={[route]}>
          <Sync />
          <Routes>
            <Route path="/m/media/artists" element={<ArtistsPage />} />
            <Route path="/m/media/artists/:slug" element={<ArtistsPage />} />
            <Route path="/m/media/album/:albumId" element={<ArtistsPage album />} />
            <Route path="*" element={<ArtistsPage />} />
          </Routes>
        </MemoryRouter>
      </GuestCtx.Provider>
    </div>,
    document.body,
  );

export default GuestMusic;
