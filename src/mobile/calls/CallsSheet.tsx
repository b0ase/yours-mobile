import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { CallsList } from './CallsList';

/** The top bar's phone button: CallsList in a bottom sheet. */
export const CallsSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => (
  <AnimatePresence>
    {open && (
      <>
        <motion.div
          className="fixed inset-0 z-[60] bg-black/60"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        />
        <motion.div
          className="fixed left-0 right-0 bottom-0 z-[61] rounded-t-2xl bg-[#0d0e11] border-t border-[#2b2f36] pt-3 overflow-y-auto"
          style={{ maxHeight: '85vh', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)' }}
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
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
          <CallsList />
        </motion.div>
      </>
    )}
  </AnimatePresence>
);
