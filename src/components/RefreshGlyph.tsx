import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, RefreshCw } from 'lucide-react';

/** How long the quiet "up to date" tick stays before the refresh icon comes back. */
export const UP_TO_DATE_MS = 1800;

/**
 * Quiet confirmation for a manual refresh that found nothing new (owner, 19 Oct 2026: the old
 * "Balances are up to date…" toast looked bad). Returns [shown, show]: call show() and the refresh
 * icon turns into a tick for UP_TO_DATE_MS. No toast.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const useUpToDate = () => {
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (!at) return;
    const t = window.setTimeout(() => setAt(0), UP_TO_DATE_MS);
    return () => window.clearTimeout(t);
  }, [at]);
  return [at > 0, () => setAt(Date.now())] as const;
};

/** Refresh icon that spins while refreshing and briefly becomes a tick when everything was already up to date. */
export const RefreshGlyph = ({
  refreshing,
  done,
  size = 16,
  tickColor,
}: {
  refreshing: boolean;
  done: boolean;
  size?: number;
  /** Tick colour; defaults to the surrounding text colour (right on gold, yellow and white cards alike). */
  tickColor?: string;
}) => {
  const reduce = useReducedMotion();
  return (
    <span style={{ position: 'relative', display: 'inline-flex', lineHeight: 0 }}>
      <AnimatePresence initial={false} mode="wait">
        {done ? (
          <motion.span
            key="tick"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 26 }}
            style={{ display: 'inline-flex', color: tickColor }}
          >
            <Check size={size} strokeWidth={2.75} aria-hidden="true" />
          </motion.span>
        ) : (
          <motion.span
            key="refresh"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.15 }}
            style={{ display: 'inline-flex' }}
          >
            <RefreshCw size={size} className={refreshing && !reduce ? 'animate-spin' : ''} aria-hidden="true" />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
};

/** Screen-reader announcement for the tick (the visible tick has no words). */
export const UpToDateAnnouncer = ({ done, label = 'Balances are up to date' }: { done: boolean; label?: string }) => (
  <span
    role="status"
    aria-live="polite"
    style={{
      position: 'absolute',
      width: 1,
      height: 1,
      overflow: 'hidden',
      clip: 'rect(0 0 0 0)',
      whiteSpace: 'nowrap',
    }}
  >
    {done ? label : ''}
  </span>
);
