import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useBackClose } from '../backStack';
import { RotateCw } from 'lucide-react';
import {
  SIG_H,
  SIG_VIEWBOX,
  SIG_W,
  padMode,
  padSize,
  screenToPad,
  signatureFromStrokes,
  strokesToPath,
  toBoxPoint,
  type SigStroke,
} from './signature';

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

type Props = {
  onCancel: () => void;
  /** The saved path, and the strokes it came from (in the 1000 × 250 box) for a caller that keeps them. */
  onSave: (svgPath: string, strokes: SigStroke[]) => void;
  /** Shown above the pad (e.g. the document being signed, for bit-sign phone signing). */
  details?: ReactNode;
  /** Replaces the default "Stays on this device" note. */
  note?: string;
  saveLabel?: string;
  /**
   * Document signing (owner, 7 Nov 2026): lengthwise on a landscape phone with the buttons in a column on the right;
   * a portrait phone shows only "Turn your phone sideways to sign", never a rotated pad.
   */
  sideways?: boolean;
  /** A "Review" button: hands back the drawing so far (the caller shows the document, then reopens the pad). */
  onReview?: (strokes: SigStroke[]) => void;
  /** Start from a kept drawing (after a Review), in the 1000 × 250 box. */
  initialStrokes?: SigStroke[];
};

/** The page under the sheet must not scroll, bounce or zoom while the pad is up. */
const useFixedWhileOpen = (sheet: RefObject<HTMLDivElement | null>) => {
  useEffect(() => {
    const el = sheet.current;
    const stop = (e: Event) => e.preventDefault();
    el?.addEventListener('touchmove', stop, { passive: false });
    el?.addEventListener('gesturestart', stop);
    const body = document.body.style;
    const was = { overflow: body.overflow, overscroll: body.overscrollBehavior };
    body.overflow = 'hidden';
    body.overscrollBehavior = 'none';
    return () => {
      el?.removeEventListener('touchmove', stop);
      el?.removeEventListener('gesturestart', stop);
      body.overflow = was.overflow;
      body.overscrollBehavior = was.overscroll;
    };
  }, [sheet]);
};

/**
 * Full-screen signing sheet. The pad has the strip's 4:1 shape, so the drawing maps 1:1 onto the
 * 1000 × 250 box. On a portrait phone the card-back sheet is drawn rotated 90° along the long side, and
 * pointer positions are mapped back into the pad's own (unrotated) space, so the saved signature is
 * the same as one drawn in landscape; a `sideways` (document) sheet asks for landscape instead. Strokes are kept in
 * the box, so a turn of the phone or a Review keeps them. Pointer events cover finger, stylus (with pressure) and
 * mouse (extension side panel).
 */
export const SignaturePad = ({
  onCancel,
  onSave,
  details,
  note,
  saveLabel = 'Save',
  sideways = false,
  onReview,
  initialStrokes,
}: Props) => {
  useBackClose(true, onCancel);
  const pad = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [strokes, setStrokes] = useState<SigStroke[]>(() => initialStrokes ?? []);
  const [error, setError] = useState('');
  const live = useRef<SigStroke | null>(null);
  const [, redraw] = useState(0);
  const mode = padMode({ sideways, portraitPhone: usePortraitPhone() });
  const rotated = mode === 'rotated';
  useFixedWhileOpen(root);

  const rect = () => {
    const r = pad.current?.getBoundingClientRect();
    return { left: r?.left ?? 0, top: r?.top ?? 0, width: r?.width ?? 0, height: r?.height ?? 0 };
  };
  const at = (cx: number, cy: number, pressure: number): [number, number, number] => {
    const r = rect();
    const { w, h } = padSize(r, rotated);
    const [x, y] = screenToPad(cx, cy, r, rotated);
    return toBoxPoint(x, y, pressure, w, h);
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

  // Preview in the 1000 × 250 box the strokes are kept in (the saved path's space).
  const preview = strokesToPath([...strokes, ...(live.current ? [live.current] : [])], 0);

  const save = () => {
    const path = signatureFromStrokes(strokes, SIG_W, SIG_H);
    if (!path) {
      setError(strokes.length ? 'Too detailed to store. Clear and sign again.' : 'Sign in the box first.');
      return;
    }
    onSave(path, strokes);
  };

  const box = (
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
  );
  const shownNote = (
    <p className="bw-sigpad-note">{error || note || 'Stays on this device. Nothing is sent or put on-chain.'}</p>
  );

  return createPortal(
    <div
      ref={root}
      className={`bw-sigpad${rotated ? ' is-rotated' : ''}${sideways ? ' is-sideways' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Draw your signature"
    >
      {mode === 'turn' ? (
        <div className="bw-sigpad-sheet bw-sigpad-turn" data-testid="sigpad-turn">
          <RotateCw size={36} aria-hidden="true" />
          <div className="bw-sigpad-title">Turn your phone sideways to sign</div>
          {details}
          {/* Rotation lock on: not a trap. Review (the document) and Cancel, as in the landscape column. */}
          <div className="bw-sigpad-btns">
            {onReview && (
              <button type="button" onClick={() => onReview(strokes)}>
                Review
              </button>
            )}
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : sideways ? (
        <div className="bw-sigpad-sheet">
          <div className="bw-sigpad-main">
            <div className="bw-sigpad-title">Sign with your finger</div>
            {details}
            {box}
            {shownNote}
          </div>
          <div className="bw-sigpad-side">
            {onReview && (
              <button type="button" onClick={() => onReview(strokes)}>
                Review
              </button>
            )}
            <button type="button" className="is-primary" onClick={save} disabled={!strokes.length}>
              {saveLabel}
            </button>
            <div className="bw-sigpad-side-row">
              <button type="button" onClick={() => setStrokes([])} disabled={!strokes.length}>
                Clear
              </button>
              <button type="button" onClick={() => setStrokes((s) => s.slice(0, -1))} disabled={!strokes.length}>
                Undo
              </button>
            </div>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="bw-sigpad-sheet">
          <div className="bw-sigpad-title">{rotated ? 'Sign along the phone' : 'Sign with your finger'}</div>
          {details}
          {box}
          {shownNote}
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
              {saveLabel}
            </button>
          </div>
        </div>
      )}
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
