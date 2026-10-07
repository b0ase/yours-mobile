import { createPortal } from 'react-dom';
import { Maximize2, X } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import bGlyph from '../brand/bwallet-glyph.svg';
import { useBackClose } from '../backStack';
import { AgentConversation } from '../agent/AgentConversation';

/**
 * Press and hold the b: the b agent over the current screen (Variant B, docs/PHONE-LAYOUT-PLAN.md §2, §14).
 * Text for now, reusing the agent page's conversation; voice comes later (§15 V2, the hidden mic in
 * AgentConversation). Expand opens the full /m/agent page.
 */
export const AgentOverlay = ({ onClose, onExpand }: { onClose: () => void; onExpand: () => void }) => {
  useBackClose(true, onClose);
  const reduce = useReducedMotion();
  return createPortal(
    <div className="fixed inset-0 z-[140] flex items-end" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Ask b"
        initial={reduce ? { opacity: 0 } : { y: 60, opacity: 0 }}
        animate={reduce ? { opacity: 1 } : { y: 0, opacity: 1 }}
        transition={reduce ? { duration: 0.15 } : { type: 'spring', stiffness: 420, damping: 38 }}
        className="w-full flex flex-col rounded-t-3xl overflow-hidden"
        style={{
          height: '72dvh',
          background: '#010101',
          borderTop: '1px solid #FFD24D55',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex items-center gap-2 px-3 pt-3 pb-2 shrink-0">
          <span className="absolute left-1/2 -translate-x-1/2 top-1.5 h-1 w-10 rounded-full bg-[#2b2f36]" />
          <img src={bGlyph} alt="" width={22} height={22} />
          <h2 className="text-base font-bold text-white flex-1">Ask b</h2>
          <button
            type="button"
            aria-label="Open full screen"
            onClick={onExpand}
            className="p-2 bg-transparent border-0"
          >
            <Maximize2 size={17} color="#98A2B3" />
          </button>
          <button type="button" aria-label="Close" onClick={onClose} className="p-2 bg-transparent border-0">
            <X size={19} color="#98A2B3" />
          </button>
        </div>
        <AgentConversation compact autoFocus />
      </motion.div>
    </div>,
    document.body,
  );
};
