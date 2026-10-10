/**
 * "Archived · Undo" toast. Any list calls showUndo(text, undo); one host (<UndoToastHost/>) renders it for ~5s.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const UNDO_MS = 5000;
type Toast = { id: number; text: string; undo: () => void };
let current: Toast | null = null;
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

// eslint-disable-next-line react-refresh/only-export-components
export const showUndo = (text: string, undo: () => void) => {
  current = { id: ++seq, text, undo };
  emit();
};
// eslint-disable-next-line react-refresh/only-export-components
export const dismissUndo = () => {
  current = null;
  emit();
};

export const UndoToastHost = () => {
  const [t, setT] = useState<Toast | null>(current);
  useEffect(() => {
    const f = () => setT(current);
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  }, []);
  useEffect(() => {
    if (!t) return;
    const id = t.id;
    const h = setTimeout(() => {
      if (current?.id === id) dismissUndo();
    }, UNDO_MS);
    return () => clearTimeout(h);
  }, [t]);
  if (!t) return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 z-[300] flex -translate-x-1/2 items-center gap-3 rounded-xl px-4 py-2.5 text-sm text-white shadow-xl"
      style={{
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)',
        background: '#1d2025',
        border: '1px solid #2b2f36',
      }}
    >
      <span>{t.text}</span>
      <button
        type="button"
        className="min-h-[36px] px-2 font-bold"
        style={{ color: '#FFC700' }}
        onClick={() => {
          t.undo();
          dismissUndo();
        }}
      >
        Undo
      </button>
    </div>,
    document.body,
  );
};
