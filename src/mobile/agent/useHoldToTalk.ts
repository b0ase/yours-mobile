import { useEffect, useRef, useState } from 'react';
import type { BHoldPhase } from '../phone/gesture';
import { createHoldToTalk, type HoldToTalk, type HoldToTalkOptions, type TalkSheet } from './holdToTalk';
import { hapticTick, primeVoice, startVoice, unprimeVoice, voiceSupported } from './voice';

type Callbacks = Pick<HoldToTalkOptions, 'onTap' | 'onListen' | 'onResult' | 'onUnsupportedRelease' | 'onCancel'>;

/**
 * React side of createHoldToTalk: phase + sheet state and the touch/pointer/key handlers for a b button.
 * Touch events drive touch (WKWebView may cancel pointer events mid-hold); pointer events drive mouse and pen.
 */
const stopNative = (e: Event) => {
  if (e.cancelable) e.preventDefault();
};

export function useHoldToTalk(cb: Callbacks & { disabled?: boolean }) {
  const latest = useRef(cb);
  latest.current = cb;
  const [phase, setPhase] = useState<BHoldPhase>('idle');
  const [sheet, setSheet] = useState<TalkSheet | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const known = useRef<boolean | null>(null);
  const lastTouch = useRef(0);
  const ctl = useRef<HoldToTalk | null>(null);
  if (!ctl.current)
    ctl.current = createHoldToTalk({
      onTap: () => latest.current.onTap(),
      onListen: (s) => latest.current.onListen?.(s),
      onResult: (r) => latest.current.onResult(r),
      onUnsupportedRelease: () => latest.current.onUnsupportedRelease(),
      onCancel: () => latest.current.onCancel?.(),
      onChange: (p, s) => {
        setPhase(p);
        setSheet(s);
      },
      start: startVoice,
      supported: () => known.current,
      haptic: hapticTick,
      prime: () => void primeVoice(),
      unprime: unprimeVoice,
    });
  const c = ctl.current;

  useEffect(() => {
    void voiceSupported().then((v) => {
      known.current = v;
      setSupported(v);
    });
    const onHide = () => document.hidden && c.abort();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && c.phase() !== 'idle' && c.abort();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('keydown', onKey);
      c.dispose();
    };
  }, [c]);

  // iOS Safari / home-screen apps: a long press opens the callout (the card with the three dots) and can
  // cancel the hold. React's touchstart is passive, so preventDefault has to go on a native listener.
  const node = useRef<HTMLElement | null>(null);
  const ref = (el: HTMLElement | null) => {
    if (node.current === el) return;
    node.current?.removeEventListener('touchstart', stopNative);
    node.current?.removeEventListener('contextmenu', stopNative);
    node.current?.removeEventListener('selectstart', stopNative);
    node.current = el;
    el?.addEventListener('touchstart', stopNative, { passive: false });
    el?.addEventListener('contextmenu', stopNative);
    el?.addEventListener('selectstart', stopNative);
  };

  const begin = (x: number, y: number) => {
    if (latest.current.disabled) return;
    c.down(x, y);
  };
  const handlers = {
    ref,
    onTouchStart: (e: React.TouchEvent) => {
      lastTouch.current = Date.now();
      const t = e.touches[0];
      if (e.touches.length === 1 && t) begin(t.clientX, t.clientY);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (t) c.move(t.clientX, t.clientY);
    },
    onTouchEnd: (e: React.TouchEvent) => {
      e.preventDefault(); // no synthetic mouse/click after a touch
      lastTouch.current = Date.now();
      c.up();
    },
    onTouchCancel: () => c.abort(),
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'touch' || Date.now() - lastTouch.current <= 800) return;
      e.currentTarget.setPointerCapture?.(e.pointerId); // sliding away still reports moves
      begin(e.clientX, e.clientY);
    },
    onPointerMove: (e: React.PointerEvent) => e.pointerType !== 'touch' && c.move(e.clientX, e.clientY),
    onPointerUp: (e: React.PointerEvent) => e.pointerType !== 'touch' && Date.now() - lastTouch.current > 800 && c.up(),
    onPointerCancel: (e: React.PointerEvent) => e.pointerType !== 'touch' && c.abort(),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onClick: (e: React.MouseEvent) => {
      // Keyboard activation only (Enter/Space have detail 0); touch and mouse are handled above.
      if (e.detail === 0) latest.current.onTap();
    },
  };
  return { phase, sheet, supported, handlers, listening: phase === 'listening' || phase === 'cancelling' };
}
