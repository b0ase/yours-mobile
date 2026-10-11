import { MIN_BRIGHTNESS, PLACE_MAX, PLACE_MIN, type CardArtLook } from './cardFrontArt';

/**
 * Adjust the card art (owner, 11 Oct 2026): a small panel at the bottom of the screen, so the card stays in view
 * and changes show live. Brightness, and where the art sits (sliders, or drag the card itself while this is open).
 * Saved per account on this device (cardFrontArt.ts saveCardArtLook).
 */
export function CardArtAdjust({
  look,
  isDefault,
  onChange,
  onReset,
  onClose,
}: {
  look: CardArtLook;
  isDefault: boolean;
  onChange: (look: CardArtLook) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const row = (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void) => (
    <label className="bw-artadj-row">
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
  return (
    <div className="bw-artadj" role="dialog" aria-label="Adjust card art">
      <div className="bw-artadj-head">
        <b>Adjust card</b>
        <span>Or drag the card to move the art</span>
      </div>
      {row('Brightness', look.brightness, MIN_BRIGHTNESS, 1, 0.01, (brightness) => onChange({ ...look, brightness }))}
      {row('Left / right', look.x, PLACE_MIN, PLACE_MAX, 1, (x) => onChange({ ...look, x }))}
      {row('Up / down', look.y, PLACE_MIN, PLACE_MAX, 1, (y) => onChange({ ...look, y }))}
      <div className="bw-artadj-actions">
        <button type="button" className="bw-artadj-reset" onClick={onReset} disabled={isDefault}>
          Reset
        </button>
        <button type="button" className="bw-artadj-done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
