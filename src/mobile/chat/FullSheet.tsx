import { createPortal } from 'react-dom';
import { CARD } from '../../components/approval/cardTheme';

/** A full-screen approval sheet over everything (the same frame as the business order sheet). */
export const FullSheet = ({ children }: { children: React.ReactNode }) =>
  createPortal(
    <div
      className="fixed inset-0 z-[420] flex flex-col overflow-y-auto"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {children}
    </div>,
    document.body,
  );
