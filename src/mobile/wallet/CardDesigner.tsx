import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { MIN_BRIGHTNESS, PLACE_MAX, PLACE_MIN, artStyle, clampLook, type CardArtLook } from './cardFrontArt';

/**
 * Card designer (owner, 11 Oct 2026): opened from the sliders icon at the top right of the card BACK, so the front
 * stays uncluttered. Full screen: a large live preview of the card front (same art, shade, $handle and balance),
 * drag the preview to move the art, sliders for brightness and position. Saved per account on this device
 * (cardFrontArt.ts saveCardArtLook) as each change lands.
 */
export function CardDesigner({
  art,
  look,
  isDefault,
  handle,
  balance,
  sub,
  onChange,
  onReset,
  onClose,
}: {
  art: string;
  look: CardArtLook;
  isDefault: boolean;
  handle: string;
  balance: string;
  sub: string;
  onChange: (look: CardArtLook) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const drag = useRef<{ x: number; y: number; lx: number; ly: number; w: number; h: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const row = (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void) => (
    <label className="bw-cdes-row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
        aria-label={label}
      />
    </label>
  );

  return createPortal(
    <div className="bw-cdes" role="dialog" aria-modal="true" aria-label="Card designer">
      <div className="bw-cdes-top">
        <b>Design your card</b>
        <button ref={closeRef} type="button" className="bw-cdes-x" aria-label="Close card designer" onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <div
        className="bw-cdes-card"
        role="img"
        aria-label="Card preview. Drag to move the art."
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          drag.current = { x: e.clientX, y: e.clientY, lx: look.x, ly: look.y, w: r.width, h: r.height };
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          onChange(
            clampLook({
              ...look,
              x: d.lx + ((e.clientX - d.x) / d.w) * 100,
              y: d.ly + ((e.clientY - d.y) / d.h) * 100,
            }),
          );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <img className="bw-wcard-art" src={art} alt="" draggable={false} style={artStyle(look)} />
        <span className="bw-wcard-art-shade" aria-hidden="true" />
        <span className="bw-cdes-handle">{handle}</span>
        <span className="bw-cdes-bal">
          <b>{balance}</b>
          <small>{sub}</small>
        </span>
      </div>
      <p className="bw-cdes-hint">Drag the card to move the art</p>
      <div className="bw-cdes-controls">
        {row('Brightness', look.brightness, MIN_BRIGHTNESS, 1, 0.01, (brightness) => onChange({ ...look, brightness }))}
        {row('Left / right', look.x, PLACE_MIN, PLACE_MAX, 1, (x) => onChange({ ...look, x }))}
        {row('Up / down', look.y, PLACE_MIN, PLACE_MAX, 1, (y) => onChange({ ...look, y }))}
      </div>
      <div className="bw-cdes-actions">
        <button type="button" className="bw-cdes-reset" onClick={onReset} disabled={isDefault}>
          Reset
        </button>
        <button type="button" className="bw-cdes-done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
