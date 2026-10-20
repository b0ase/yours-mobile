import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import type { FeedMedia } from './media';
import { saveImage } from './imageSave';

/**
 * Full-screen image viewer for the Feed (owner, 19 Oct 2026: "click an image, it enlarges, offer a download").
 * Black backdrop, image fitted edge to edge (no decorative frame: the phone is the frame). Swipe or arrow keys
 * between a post's images, pinch or double-tap to zoom, drag down (or Esc, or ✕) to close. A visible gold Save
 * button saves through the share sheet in the app and on phones, or downloads on desktop.
 */
const GOLD = '#e8b931';
const MAX_ZOOM = 4;

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

type Pt = { x: number; y: number };

export const ImageViewer = ({
  images,
  start,
  onClose,
}: {
  images: FeedMedia[];
  start: number;
  onClose: () => void;
}) => {
  const [at, setAt] = useState(Math.min(Math.max(0, start), images.length - 1));
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pt>({ x: 0, y: 0 });
  const [drag, setDrag] = useState<Pt>({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<{ start: Pt; pan: Pt; dist: number; zoom: number; moved: boolean } | null>(null);
  const lastTap = useRef(0);
  const reduce = reducedMotion();
  const m = images[at];
  const many = images.length > 1;

  const go = useCallback(
    (d: number) => {
      setAt((i) => Math.min(images.length - 1, Math.max(0, i + d)));
      setZoom(1);
      setPan({ x: 0, y: 0 });
    },
    [images.length],
  );

  // Focus in, Esc / arrows, focus trap, background scroll lock; focus goes back to the feed image on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'Tab' && root.current) {
        const f = [...root.current.querySelectorAll<HTMLElement>('button:not([disabled])')];
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    // Capture on window: the root's stopPropagation (below) would otherwise hide keys from a document listener.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [go, onClose]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      const r = await saveImage(m, Capacitor.isNativePlatform());
      setNote(r === 'saved' ? 'Saved' : r === 'opened' ? 'Opened in a new tab: long-press or right-click to save' : '');
    } catch {
      setNote('Could not save this image');
    } finally {
      setBusy(false);
    }
  };

  const dist = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onDown = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current = { start: { x: e.clientX, y: e.clientY }, pan, dist: dist(), zoom, moved: false };
  };

  const onMove = (e: RPointerEvent) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const dx = e.clientX - g.start.x;
    const dy = e.clientY - g.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
    if (pointers.current.size >= 2) {
      if (!g.dist) g.dist = dist();
      else setZoom(Math.min(MAX_ZOOM, Math.max(1, (g.zoom * dist()) / g.dist)));
    } else if (zoom > 1) setPan({ x: g.pan.x + dx, y: g.pan.y + dy });
    else setDrag(Math.abs(dy) > Math.abs(dx) ? { x: 0, y: Math.max(0, dy) } : { x: dx, y: 0 });
  };

  const onUp = (e: RPointerEvent) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) return;
    gesture.current = null;
    if (!g) return;
    if (zoom <= 1.02) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
    setDrag({ x: 0, y: 0 });
    const dx = e.clientX - g.start.x;
    const dy = e.clientY - g.start.y;
    if (g.zoom <= 1 && zoom <= 1) {
      if (dy > 110 && Math.abs(dy) > Math.abs(dx)) return onClose();
      if (many && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) return go(dx < 0 ? 1 : -1);
    }
    if (g.moved) return;
    // Double tap: zoom in to 2.5x around the tap, or back out.
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      if (zoom > 1) {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      } else {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setZoom(2.5);
        setPan({ x: (r.width / 2 - (e.clientX - r.left)) * 1.5, y: (r.height / 2 - (e.clientY - r.top)) * 1.5 });
      }
    } else lastTap.current = now;
  };

  const fade = Math.max(0.35, 1 - drag.y / 500);
  const moving = !!gesture.current || reduce;

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={many ? `Image ${at + 1} of ${images.length}` : 'Image'}
      className="fixed inset-0 z-[1000] flex flex-col select-none"
      style={{ background: `rgba(0,0,0,${fade})`, color: '#fff' }}
      // React events bubble through portals: keep taps here from reaching the gallery / post underneath.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="relative flex-1 overflow-hidden"
        style={{ touchAction: 'none' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onWheel={(e) => {
          const z = Math.min(MAX_ZOOM, Math.max(1, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
          setZoom(z);
          if (z === 1) setPan({ x: 0, y: 0 });
        }}
      >
        <img
          key={m.src}
          src={m.src}
          alt={many ? `Image ${at + 1} of ${images.length}` : 'Image from post'}
          draggable={false}
          className="absolute inset-0 m-auto max-w-full max-h-full w-auto h-auto object-contain"
          style={{
            transform: `translate(${pan.x + drag.x}px, ${pan.y + drag.y}px) scale(${zoom})`,
            transition: moving ? 'none' : 'transform 180ms ease-out',
            cursor: zoom > 1 ? 'grab' : 'zoom-in',
          }}
        />
        {many && (
          <>
            <NavBtn side="left" label="Previous image" disabled={at === 0} onClick={() => go(-1)} />
            <NavBtn side="right" label="Next image" disabled={at === images.length - 1} onClick={() => go(1)} />
          </>
        )}
      </div>

      <div
        className="absolute top-0 inset-x-0 flex items-center justify-between px-3"
        style={{
          paddingTop: 'max(10px, env(safe-area-inset-top))',
          background: 'linear-gradient(rgba(0,0,0,0.55), transparent)',
        }}
      >
        <button
          ref={closeBtn}
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-full"
          style={{ background: 'rgba(0,0,0,0.5)' }}
        >
          <X size={22} color="#fff" />
        </button>
        {many && (
          <span className="text-[13px] font-bold" aria-live="polite">
            {at + 1}/{images.length}
          </span>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="flex h-11 items-center gap-2 rounded-full px-4 text-[14px] font-bold"
          style={{ background: GOLD, color: '#000', opacity: busy ? 0.6 : 1 }}
        >
          <Download size={18} />
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      {note && (
        <div
          role="status"
          className="absolute inset-x-0 flex justify-center px-4"
          style={{ bottom: 'max(20px, env(safe-area-inset-bottom))' }}
        >
          <span className="rounded-full px-4 py-2 text-[13px]" style={{ background: 'rgba(0,0,0,0.75)' }}>
            {note}
          </span>
        </div>
      )}
    </div>,
    document.body,
  );
};

const NavBtn = ({
  side,
  label,
  disabled,
  onClick,
}: {
  side: 'left' | 'right';
  label: string;
  disabled: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
    className={`absolute top-1/2 -translate-y-1/2 ${side === 'left' ? 'left-2' : 'right-2'} hidden sm:flex h-11 w-11 items-center justify-center rounded-full disabled:opacity-0`}
    style={{ background: 'rgba(0,0,0,0.5)' }}
  >
    {side === 'left' ? <ChevronLeft size={24} color="#fff" /> : <ChevronRight size={24} color="#fff" />}
  </button>
);
