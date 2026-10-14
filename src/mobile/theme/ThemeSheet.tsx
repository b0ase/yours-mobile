import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Sparkles, X } from 'lucide-react';
import { ACCENTS, DEFAULT_ACCENT, type AccentId } from './accents';
import { loadAccent, saveAccent } from './accent';

type ThemeTab = 'colours' | 'card';

/**
 * Theme (owner, 14 Oct 2026): the page behind the sliders icon on the card back, which was "Design your card".
 * Two tabs: App colours (the accent, below) and Design your card (the existing CardDesigner, unchanged apart from
 * its title and these tabs). Where the card has no designer (bWallet's yellow card), only App colours shows.
 */
export function ThemeSheet({
  account,
  onClose,
  card,
  initialTab = 'card',
}: {
  /** The account's identity key: the accent is kept per account on this device. */
  account: string;
  onClose: () => void;
  /** Renders the card designer with the shared tab bar; absent where the card can't be designed. */
  card?: (tabs: ReactNode) => ReactNode;
  initialTab?: ThemeTab;
}) {
  const [tab, setTab] = useState<ThemeTab>(card ? initialTab : 'colours');
  const tabs = card ? (
    <div className="bw-cdes-seg bw-theme-tabs" role="tablist" aria-label="Theme">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'colours'}
        className={tab === 'colours' ? 'on' : ''}
        onClick={() => setTab('colours')}
      >
        App colours
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'card'}
        className={tab === 'card' ? 'on' : ''}
        onClick={() => setTab('card')}
      >
        Design your card
      </button>
    </div>
  ) : null;
  if (card && tab === 'card') return <>{card(tabs)}</>;
  return <AppColours account={account} tabs={tabs} onClose={onClose} />;
}

function AppColours({ account, tabs, onClose }: { account: string; tabs: ReactNode; onClose: () => void }) {
  const [current, setCurrent] = useState<AccentId>(() => loadAccent(account));
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const pick = (id: AccentId) => {
    saveAccent(account, id);
    setCurrent(id);
  };

  return createPortal(
    <div className="bw-cdes bw-theme" role="dialog" aria-modal="true" aria-label="Theme">
      <div className="bw-cdes-top">
        <b>Theme</b>
        <button ref={closeRef} type="button" className="bw-cdes-x" aria-label="Close theme" onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      {tabs}
      <div className="bw-theme-preview" aria-label="Preview">
        <div className="bw-theme-pv-row">
          <span className="bw-theme-pv-icon">
            <Sparkles size={18} aria-hidden="true" />
          </span>
          <span className="bw-theme-pv-text">
            <b>Your accent</b>
            <small>Buttons, tabs, icons and highlights</small>
          </span>
          <span className="bw-theme-pv-chip">New</span>
        </div>
        <div className="bw-theme-pv-tabs" aria-hidden="true">
          <span className="on">Wallet</span>
          <span>Market</span>
          <span>Chat</span>
        </div>
        <div className="bw-theme-pv-actions" aria-hidden="true">
          <span className="bw-theme-pv-btn">Send</span>
          <span className="bw-theme-pv-ghost">Receive</span>
          <span className="bw-theme-pv-toggle">
            <i />
          </span>
        </div>
      </div>
      <div className="bw-theme-swatches" role="radiogroup" aria-label="App colour">
        {ACCENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={current === a.id}
            className={`bw-theme-swatch${current === a.id ? ' is-on' : ''}`}
            onClick={() => pick(a.id)}
          >
            <span
              className="bw-theme-dot"
              style={{ background: `linear-gradient(135deg, ${a.hi}, ${a.accent} 55%, ${a.lo})`, color: a.on }}
            >
              {current === a.id && <Check size={16} aria-hidden="true" />}
            </span>
            <span className="bw-theme-name">{a.label}</span>
          </button>
        ))}
      </div>
      <p className="bw-cdes-note">
        Changes the accent only. The black background stays, and so does the gold b. Kept for this account on this
        device.
      </p>
      <div className="bw-cdes-actions">
        <button
          type="button"
          className="bw-cdes-reset"
          onClick={() => pick(DEFAULT_ACCENT)}
          disabled={current === DEFAULT_ACCENT}
        >
          Reset to Gold
        </button>
        <button type="button" className="bw-cdes-done bw-theme-done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
