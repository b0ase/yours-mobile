/**
 * The kept session on the Try again / Seal again screen (review of #560 L2, CTO decision). The nonce stays kept while
 * the screen is up, so a pay-only retry works and another window is held off (nativeSeal SealClaim, M3), but it is
 * given back to bit-sign (cancel) when the page unmounts OR after RETRY_HOLD_MS on the screen, whichever is first: a
 * co-signer is never held up by a screen left open. Giving it back keeps the drawing; only the session goes, so the
 * next Try again prepares a new one from the same drawing (no redraw).
 *
 * Pure apart from the injected timer and cancel: sealRetryHold.test.ts drives it with a fake clock.
 */
import type { SealDrawing, SealDrawingStore } from './nativeSeal';

export const RETRY_HOLD_MS = 2 * 60_000;

export interface RetryHold {
  /** The retry screen shows this drawing. With a kept session, its 2-minute timer starts (a previous one is given back). */
  hold(d: SealDrawing): void;
  /** Try again pressed: the seal now owns the session. The timer stops; nothing is cancelled. */
  take(): void;
  /** Unmount, the timer, Draw again or an account switch: cancel the kept session and drop it from the stored drawing. */
  giveBack(): void;
  /** The drawing held now, if any (tests). */
  held(): SealDrawing | null;
}

export function createRetryHold(deps: {
  cancel: (nonce: string) => void;
  /**
   * Another context is paying this seal now (a live claim or a record of it in the shared store; review of #560 L4):
   * then its session is NOT cancelled from here, only dropped from this screen.
   */
  busyElsewhere?: (key: string) => boolean;
  drawings: () => SealDrawingStore | undefined;
  /** Called with the drawing as it is after the give-back (no resume): the screen keeps showing it. */
  onGiveBack?: (d: SealDrawing) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  holdMs?: number;
}): RetryHold {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let live: SealDrawing | null = null;
  let timer: unknown = null;
  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const giveBack = () => {
    stop();
    const d = live;
    live = null;
    if (!d?.resume) return;
    let busy = false;
    try {
      busy = !!deps.busyElsewhere?.(d.key);
    } catch {
      busy = true; // can't tell: never cancel a session another window may be paying on
    }
    if (!busy)
      try {
        deps.cancel(d.resume.prepared.nonce);
      } catch {
        /* best effort: the session times out on its own */
      }
    const { resume: _gone, ...bare } = d;
    void _gone;
    try {
      const ds = deps.drawings();
      const cur = ds?.get(d.key);
      if (cur?.resume?.prepared.nonce === d.resume.prepared.nonce) ds?.save({ ...cur, resume: undefined });
    } catch {
      /* storage blocked */
    }
    deps.onGiveBack?.(bare);
  };
  return {
    hold: (d) => {
      // Another kept session than the one held now: that one goes back first.
      if (live?.resume && live.resume.prepared.nonce !== d.resume?.prepared.nonce) giveBack();
      stop();
      live = d;
      if (d.resume) timer = setTimer(giveBack, deps.holdMs ?? RETRY_HOLD_MS);
    },
    take: () => {
      stop();
      live = null;
    },
    giveBack,
    held: () => live,
  };
}
