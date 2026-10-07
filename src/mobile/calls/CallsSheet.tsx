import { createPortal } from 'react-dom';
import { TermsGate } from '../ugc/UgcSheets';
import { useBackClose } from '../backStack';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { CallsList } from './CallsList';

/**
 * The top bar's phone button: CallsList in a bottom sheet. Portalled to <body> at z-180 so it sits above
 * the tab bar (z-100) and Chat's full-screen layer (z-60), and below an incoming CallScreen (z-200).
 */
export const CallsSheet = ({
  open,
  onClose,
  fullScreen,
}: {
  open: boolean;
  onClose: () => void;
  /** Phone layout (owner, round 6): a full-screen page, not a card. */
  fullScreen?: boolean;
}) => {
  useBackClose(open, onClose);
  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-[180] bg-black/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className={
              fullScreen
                ? 'fixed inset-0 z-[181] bg-[#0d0e11] overflow-y-auto'
                : 'fixed left-0 right-0 bottom-0 z-[181] rounded-t-2xl bg-[#0d0e11] border-t border-[#2b2f36] pt-3 overflow-y-auto'
            }
            style={
              fullScreen
                ? {
                    paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)',
                    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)',
                  }
                : { maxHeight: '85vh', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)' }
            }
            initial={fullScreen ? { x: '100%' } : { y: '100%' }}
            animate={fullScreen ? { x: 0 } : { y: 0 }}
            exit={fullScreen ? { x: '100%' } : { y: '100%' }}
            transition={{ type: 'tween', duration: 0.22 }}
            role="dialog"
            aria-label="Calls"
          >
            <div className="flex items-center justify-between px-4 pb-3">
              <span className="text-lg font-semibold text-white">Calls</span>
              <button aria-label="Close" onClick={onClose} className="p-2">
                <X size={18} color="#98A2B3" />
              </button>
            </div>
            <TermsGate compact>
              <CallsList onLeave={onClose} />
            </TermsGate>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
};
