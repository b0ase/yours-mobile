import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { FriendsSection } from './FriendsSection';
import { closesAddressBook, opensAddressBook } from './addressBookGesture';
import './addressBook.css';

/**
 * The address book (owner, 15 Oct 2026): Friends as a little black spiral-bound notebook. Opened by pulling the
 * balance carousel right past the first card, or the notebook button under the cards; /m/friends shows it too.
 * The contacts, search, Add a friend, Pay and Message are FriendsSection's. Swipe left, × or Escape closes it.
 */
export const AddressBook = ({ onClose }: { onClose: () => void }) => {
  const start = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return createPortal(
    <div
      className="bw-abook"
      role="dialog"
      aria-modal="true"
      aria-label="Address book"
      onTouchStart={(e) => (start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchEnd={(e) => {
        const s = start.current;
        start.current = null;
        if (!s) return;
        const t = e.changedTouches[0];
        if (closesAddressBook({ dx: t.clientX - s.x, dy: t.clientY - s.y })) onClose();
      }}
    >
      <div className="bw-abook-cover">
        <div className="bw-abook-spiral" aria-hidden="true" />
        <div className="bw-abook-page">
          <div className="bw-abook-head">
            <h2>Address book</h2>
            <button type="button" className="bw-abook-close" aria-label="Close address book" onClick={onClose}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <div className="bw-abook-lines">
            <FriendsSection />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

/** /m/friends (/wallet/friends): the same notebook as a page; closing goes back to the Wallet. */
export const AddressBookPage = () => {
  const navigate = useNavigate();
  return <AddressBook onClose={() => navigate('/bsv-wallet')} />;
};

/**
 * The single wallet card (store edition, no carousel): the same right pull and notebook button open the address
 * book, so Friends stay reachable in every edition.
 */
export const AddressBookPull = ({ children }: { children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  const p0 = useRef<{ x: number; y: number } | null>(null);
  return (
    <>
      <div
        onTouchStart={(e) => (p0.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
        onTouchEnd={(e) => {
          const p = p0.current;
          p0.current = null;
          if (!p) return;
          const t = e.changedTouches[0];
          if (opensAddressBook(0, { dx: t.clientX - p.x, dy: t.clientY - p.y })) setOpen(true);
        }}
      >
        {children}
      </div>
      {open && <AddressBook onClose={() => setOpen(false)} />}
    </>
  );
};
