import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { ExternalLink } from 'lucide-react';
import { loadPrefs } from '../../mobile/settings/prefs';
import { playChime, primeChime } from './chime';
import { formatRecipients, formatSentAmount, getSent, onSent, setSent, txUrl, type SentInfo } from './sent';

const GOLD = '#FFD24D';
const GOLD_DEEP = '#E0A800';
const AUTO_DISMISS_MS = 4500;

/** The Sent! moment itself (presentational; SentHost mounts it app-wide). */
export const SentScreen = ({
  info,
  onDone,
  reducedMotion,
}: {
  info: SentInfo;
  onDone: () => void;
  reducedMotion?: boolean;
}) => {
  const prefersReduced = useReducedMotion();
  const still = reducedMotion ?? !!prefersReduced;
  const { primary, secondary } = formatSentAmount(info.amount, info.rate ?? 0);
  const to = formatRecipients(info.recipients);

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sent-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: still ? 0 : 0.2 }}
      className="fixed inset-0 flex flex-col items-center justify-center px-6"
      style={{
        zIndex: 2147483000,
        background: 'radial-gradient(120% 80% at 50% 30%, #1d1606 0%, #0b0b0b 55%, #000 100%)',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        color: '#fff',
      }}
    >
      <motion.div
        initial={still ? false : { scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={still ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 16 }}
        className="relative flex items-center justify-center rounded-full"
        style={{
          width: 120,
          height: 120,
          background: `linear-gradient(145deg, ${GOLD} 0%, ${GOLD_DEEP} 100%)`,
          boxShadow: `0 0 0 10px rgba(255,210,77,0.12), 0 0 60px rgba(255,210,77,0.35)`,
        }}
      >
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <motion.path
            d="M5 12.5l4.5 4.5L19 7.5"
            stroke="#111"
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={still ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={still ? { duration: 0 } : { delay: 0.18, duration: 0.35, ease: 'easeOut' }}
          />
        </svg>
      </motion.div>

      <motion.div
        initial={still ? false : { y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={still ? { duration: 0 } : { delay: 0.15, duration: 0.3 }}
        className="flex flex-col items-center text-center w-full"
        style={{ maxWidth: 360 }}
      >
        <h1 id="sent-title" className="mt-7 text-3xl font-bold" style={{ color: GOLD }}>
          {info.title ?? 'Sent!'}
        </h1>
        <div className="mt-4 text-4xl font-semibold tracking-tight break-all">{primary}</div>
        {secondary && (
          <div className="mt-1 text-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>
            {secondary}
          </div>
        )}
        {to && (
          <div className="mt-5 text-sm" style={{ color: 'rgba(255,255,255,0.75)' }}>
            to <span className="font-semibold text-white break-all">{to}</span>
          </div>
        )}
        <a
          href={txUrl(info.txid)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium"
          style={{ color: GOLD }}
        >
          View transaction <ExternalLink size={14} />
        </a>
        <button
          type="button"
          autoFocus
          onClick={onDone}
          className="mt-8 w-full rounded-2xl py-3.5 text-base font-semibold"
          style={{ background: `linear-gradient(90deg, ${GOLD} 0%, ${GOLD_DEEP} 100%)`, color: '#111' }}
        >
          Done
        </button>
      </motion.div>
    </motion.div>
  );
};

/**
 * App-wide host: shows the Sent! screen whenever a send path calls celebrateSend, plays the chime
 * (Settings › Preferences › Sounds) and auto-dismisses after a few seconds unless touched.
 */
export const SentHost = () => {
  const [info, setInfo] = useState<SentInfo | null>(getSent);
  const touched = useRef(false);

  useEffect(() => onSent(setInfo), []);

  // Unlock Web Audio on the first tap of the session (WebViews refuse sound outside a gesture).
  useEffect(() => {
    const prime = () => {
      if (loadPrefs().sounds) primeChime();
    };
    window.addEventListener('pointerdown', prime, { capture: true, once: true });
    return () => window.removeEventListener('pointerdown', prime, { capture: true });
  }, []);

  useEffect(() => {
    if (!info) return;
    touched.current = false;
    if (loadPrefs().sounds) {
      try {
        playChime();
      } catch {
        // sound is a nicety
      }
    }
    const t = setTimeout(() => {
      if (!touched.current) setSent(null);
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [info]);

  if (!info || typeof document === 'undefined') return null;
  return createPortal(
    <div onPointerDown={() => (touched.current = true)}>
      <SentScreen key={info.txid} info={info} onDone={() => setSent(null)} />
    </div>,
    document.body,
  );
};
