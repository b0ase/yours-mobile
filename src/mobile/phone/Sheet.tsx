import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useBackClose } from '../backStack';
import { useKeyboardInset } from '../ui/keyboardInset';

/** A bottom sheet over everything (Back closes it). Rides above the iOS keyboard when one is open. */
export const Sheet = ({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) => {
  useBackClose(true, onClose);
  const keyboard = useKeyboardInset();
  return createPortal(
    <div
      className="fixed inset-0 z-[150] flex items-end"
      style={{ background: 'rgba(0,0,0,0.6)', paddingBottom: keyboard }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="w-full rounded-t-3xl bg-[#17191E] px-5 pt-5 flex flex-col gap-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)', borderTop: '1px solid #2b2f36' }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
};
