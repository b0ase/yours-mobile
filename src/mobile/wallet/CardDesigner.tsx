import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImagePlus, X } from 'lucide-react';
import {
  HUE_MAX,
  HUE_MIN,
  MIN_BRIGHTNESS,
  PLACE_MAX,
  PLACE_MIN,
  SAT_MAX,
  SAT_MIN,
  artStyle,
  clampLook,
  prepareCardImage,
  type CardArtLook,
} from './cardFrontArt';

/**
 * Card designer (owner, 11 Oct 2026): opened from the sliders icon at the top right of the card BACK, so the front
 * stays uncluttered. Full screen: a large live preview of the card front (same art, shade, $handle and balance),
 * drag the preview to move the art, sliders for brightness and position. Saved per account on this device
 * (cardFrontArt.ts saveCardArtLook) as each change lands.
 * Colour and own picture (owner, 12 Oct 2026): hue, saturation and shade sliders, and "Use my picture" to put a
 * picture from this device on the front (resized here, kept on this device only); the same controls apply to it.
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
  customImage,
  onImage,
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
  /** True while the front shows the account's own picture rather than its bAvatar art. */
  customImage: boolean;
  /** A new picture (data URI), or null to go back to the bAvatar art. Returns false when it couldn't be saved. */
  onImage: (uri: string | null) => boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [imgErr, setImgErr] = useState('');
  const drag = useRef<{ x: number; y: number; lx: number; ly: number; w: number; h: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const row = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    set: (v: number) => void,
    track?: string,
  ) => (
    <label
      className={`bw-cdes-row${track ? ' has-track' : ''}`}
      style={track ? { ['--bw-track' as string]: track } : {}}
    >
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
        {row(
          'Hue',
          look.hue ?? 0,
          HUE_MIN,
          HUE_MAX,
          1,
          (hue) => onChange(clampLook({ ...look, hue })),
          'linear-gradient(90deg,#00c8ff,#4060ff,#c040ff,#ff3080,#ff6020,#ffc400,#ff6020,#ff3080,#c040ff,#4060ff,#00c8ff)',
        )}
        {row(
          'Saturation',
          look.saturation ?? 1,
          SAT_MIN,
          SAT_MAX,
          0.01,
          (saturation) => onChange(clampLook({ ...look, saturation })),
          'linear-gradient(90deg,#777,#c9a227,#ffc400)',
        )}
        {row(
          'Shade',
          look.brightness,
          MIN_BRIGHTNESS,
          1,
          0.01,
          (brightness) => onChange({ ...look, brightness }),
          'linear-gradient(90deg,#0b0b0c,#8a6d14,#ffd24d)',
        )}
        {row('Left / right', look.x, PLACE_MIN, PLACE_MAX, 1, (x) => onChange({ ...look, x }))}
        {row('Up / down', look.y, PLACE_MIN, PLACE_MAX, 1, (y) => onChange({ ...look, y }))}
      </div>
      <div className="bw-cdes-picture">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setImgErr('');
            try {
              if (!onImage(await prepareCardImage(f))) setImgErr('This device has no room left to keep that picture.');
            } catch (err) {
              setImgErr(err instanceof Error ? err.message : 'That picture couldn’t be used.');
            }
          }}
        />
        <button type="button" className="bw-cdes-pick" onClick={() => fileRef.current?.click()}>
          <ImagePlus size={16} aria-hidden="true" /> {customImage ? 'Choose another picture' : 'Use my picture'}
        </button>
        {customImage && (
          <button type="button" className="bw-cdes-artback" onClick={() => onImage(null)}>
            Back to bAvatar art
          </button>
        )}
        {imgErr && (
          <p className="bw-cdes-imgerr" role="alert">
            {imgErr}
          </p>
        )}
        <p className="bw-cdes-note">Your picture stays on this device. It isn’t uploaded anywhere.</p>
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
