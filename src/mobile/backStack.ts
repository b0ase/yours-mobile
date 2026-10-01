import { useEffect, useRef } from 'react';

/**
 * Android hardware Back for in-app sheets/drawers/modals. Each open sheet pushes a closer; main.ts's
 * backButton listener pops the most recently opened one. Empty stack → main.ts falls back to its default.
 */
type Entry = { close: () => void };
const stack: Entry[] = [];

/** Registers a closer; returns an unregister fn (idempotent). */
export const pushBackCloser = (close: () => void): (() => void) => {
  const entry: Entry = { close };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i !== -1) stack.splice(i, 1);
  };
};

/** Pops and runs the top closer. Returns false if nothing was open. */
export const handleBack = (): boolean => {
  const entry = stack.pop();
  if (!entry) return false;
  entry.close();
  return true;
};

export const backStackSize = () => stack.length;

/** While `open`, Back calls the latest `onClose`. */
export const useBackClose = (open: boolean, onClose: () => void) => {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!open) return;
    return pushBackCloser(() => ref.current());
  }, [open]);
};
