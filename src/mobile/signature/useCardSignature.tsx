import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { ChangeSheet, SignaturePad } from './SignaturePad';
import { SIG_VIEWBOX, getSignature, onSignatureChange, setSignature } from './signature';

const LONG_PRESS_MS = 450;
const MOVE_SLOP = 10;

/**
 * Signature strip on the card back: a long press (or the pen button) opens the pad, or, once signed,
 * a Redraw / Remove choice. A plain tap still reaches the card and flips it.
 */
export const useCardSignature = (accountId?: string) => {
  const [svgPath, setPath] = useState(() => getSignature(accountId)?.svgPath ?? '');
  useEffect(() => {
    const read = () => setPath(getSignature(accountId)?.svgPath ?? '');
    read();
    return onSignatureChange(read);
  }, [accountId]);
  const [mode, setMode] = useState<'none' | 'pad' | 'menu'>('none');
  const open = () => setMode(svgPath ? 'menu' : 'pad');

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<[number, number] | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  useEffect(() => cancel, []);

  const pressHandlers = {
    onPointerDown: (e: PointerEvent) => {
      if (e.button > 0) return;
      fired.current = false;
      start.current = [e.clientX, e.clientY];
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        fired.current = true;
        timer.current = null;
        navigator.vibrate?.(10);
        open();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s[0], e.clientY - s[1]) > MOVE_SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    // The click that ends a long press must not also flip the card.
    onClick: (e: MouseEvent) => {
      if (fired.current) {
        e.stopPropagation();
        fired.current = false;
      }
    },
    onContextMenu: (e: MouseEvent) => e.preventDefault(),
  };

  const close = () => setMode('none');
  const ui =
    !accountId || mode === 'none' ? null : mode === 'pad' ? (
      <SignaturePad
        onCancel={close}
        onSave={(p) => {
          setSignature(accountId, p);
          close();
        }}
      />
    ) : (
      <ChangeSheet
        onClose={close}
        onRedraw={() => setMode('pad')}
        onRemove={() => {
          setSignature(accountId, '');
          close();
        }}
      />
    );

  return { svgPath, viewBox: SIG_VIEWBOX, open, pressHandlers, ui };
};
