import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useBackClose } from '../backStack';
import { SIG_VIEWBOX, padSize, screenToPad, signatureFromStrokes, strokesToPath, type SigStroke } from './signature';

/** Portrait phone: the pad is drawn rotated 90° so it runs along the long side (no need to turn the phone). */
const PORTRAIT_PHONE = '(orientation: portrait) and (pointer: coarse) and (max-width: 640px)';
const usePortraitPhone = () => {
  const mq = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PORTRAIT_PHONE) : null);
  const [on, setOn] = useState(() => !!mq()?.matches);
  useEffect(() => {
    const m = mq();
    if (!m) return;
    const f = () => setOn(m.matches);
    f();
    m.addEventListener?.('change', f);
    return () => m.removeEventListener?.('change', f);
  }, []);
  return on;
};

type Props = { onCancel: () => void; onSave: (svgPath: string) => void };

/**
 * Full-screen signing sheet. The pad has the strip's 4:1 shape, so the drawing maps 1:1 onto the
 * 1000 × 250 box. On a portrait phone the whole sheet is drawn rotated 90° along the long side, and
 * pointer positions are mapped back into the pad's own (unrotated) space, so the saved signature is
 * the same as one drawn in landscape. Pointer events cover finger, stylus (with pressure) and mouse (extension side panel).
 */
export const SignaturePad = ({ onCancel, onSave }: Props) => {
  useBackClose(true, onCancel);
  const pad = useRef<HTMLDivElement>(null);
  const [strokes, setStrokes] = useState<SigStroke[]>([]);
  const [error, setError] = useState('');
  const live = useRef<SigStroke | null>(null);
  const [, redraw] = useState(0);
  const rotated = usePortraitPhone();

  const rect = () => {
    const r = pad.current?.getBoundingClientRect();
    return { left: r?.left ?? 0, top: r?.top ?? 0, width: r?.width ?? 0, height: r?.height ?? 0 };
  };
  const size = () => padSize(rect(), rotated);
  const at = (cx: number, cy: number, pressure: number): [number, number, number] => {
    const [x, y] = screenToPad(cx, cy, rect(), rotated);
    return [x, y, pressure];
  };
  const pt = (e: RPointerEvent): [number, number, number] =>
    at(e.clientX, e.clientY, e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5);
  const down = (e: RPointerEvent) => {
    if (e.button > 0) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    live.current = { pen: e.pointerType === 'pen', points: [pt(e)] };
    setError('');
    redraw((n) => n + 1);
  };
  const move = (e: RPointerEvent) => {
    if (!live.current) return;
    const events = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
    if (events.length) {
      for (const c of events)
        live.current.points.push(at(c.clientX, c.clientY, live.current.pen ? c.pressure || 0.5 : 0.5));
    } else live.current.points.push(pt(e));
    redraw((n) => n + 1);
  };
  const up = () => {
    const s = live.current;
    live.current = null;
    if (s) setStrokes((all) => [...all, s]);
  };

  // Preview in the same 1000 × 250 space as the saved path.
  const { w, h } = size();
  const shown = [...strokes, ...(live.current ? [live.current] : [])].map((s) => ({
    pen: s.pen,
    points: s.points.map(([x, y, p]) => [(x * 1000) / (w || 1), (y * 250) / (h || 1), p] as [number, number, number]),
  }));
  const preview = w ? strokesToPath(shown, 0) : '';

  // Strokes are kept in pad pixels; a rotation change mid-drawing would rescale them, so start over.
  useEffect(() => setStrokes([]), [rotated]);

  const save = () => {
    const path = signatureFromStrokes(strokes, w, h);
    if (!path) {
      setError(strokes.length ? 'Too detailed to store. Clear and sign again.' : 'Sign in the box first.');
      return;
    }
    onSave(path);
  };

  return createPortal(
    <div
      className={`bw-sigpad${rotated ? ' is-rotated' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Draw your signature"
    >
      <div className="bw-sigpad-sheet">
        <div className="bw-sigpad-title">{rotated ? 'Sign along the phone' : 'Sign with your finger'}</div>
        <div
          ref={pad}
          className="bw-sigpad-box"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onContextMenu={(e) => e.preventDefault()}
        >
          <svg viewBox={SIG_VIEWBOX} preserveAspectRatio="none" aria-hidden="true">
            <path d={preview} fill="#1b2a5a" />
          </svg>
          <span className="bw-sigpad-x" aria-hidden="true">
            ×
          </span>
        </div>
        <p className="bw-sigpad-note">{error || 'Stays on this device. Nothing is sent or put on-chain.'}</p>
        <div className="bw-sigpad-btns">
          <button type="button" onClick={() => setStrokes([])} disabled={!strokes.length}>
            Clear
          </button>
          <button type="button" onClick={() => setStrokes((s) => s.slice(0, -1))} disabled={!strokes.length}>
            Undo
          </button>
          <span />
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="is-primary" onClick={save} disabled={!strokes.length}>
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

/** Redraw / Remove choice once a signature exists. */
export const ChangeSheet = ({
  onRedraw,
  onRemove,
  onClose,
}: {
  onRedraw: () => void;
  onRemove: () => void;
  onClose: () => void;
}) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="bw-sigpad" role="dialog" aria-modal="true" aria-label="Your signature" onClick={onClose}>
      <div className="bw-sigpad-menu" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onRedraw}>
          Redraw signature
        </button>
        <button type="button" className="is-danger" onClick={onRemove}>
          Remove signature
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
};
