/**
 * Swipe-row actions for Exchange token lists (Markets, My orders): reuses the app's SwipeRow
 * (swipe/SwipeRow.tsx: one row open at a time, axis lock so vertical scroll is never taken,
 * long-press / right-click / "…" / Shift+F10 menu for the same actions without swiping).
 * State lives in useTokenRowActions.tsx; logic (holding check by token ID, routes) in rowActions.ts.
 */
import type { ReactNode } from 'react';
import { SwipeRow, type SwipeAction } from '../swipe/SwipeRow';

export const TokenSwipeRow = ({
  actions,
  title,
  rowId,
  children,
}: {
  actions: SwipeAction[];
  title: string;
  rowId: string;
  children: ReactNode;
}) => (
  <SwipeRow label={title} rowId={rowId} leftActions={actions}>
    {children}
  </SwipeRow>
);

export const HoldHint = ({
  title,
  checking,
  onBuy,
  onClose,
}: {
  title: string;
  checking: boolean;
  onBuy: () => void;
  onClose: () => void;
}) => (
  <div className="fixed inset-0 z-[280] flex items-end justify-center" role="presentation" onClick={onClose}>
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${title} room`}
      onClick={(e) => e.stopPropagation()}
      className="w-full max-w-[480px] m-3 rounded-2xl p-4 flex flex-col gap-3 shadow-xl"
      style={{ background: 'var(--bw-surface)', border: '1px solid var(--bw-line)', color: 'var(--bw-text)' }}
    >
      <div className="text-sm font-bold">{checking ? 'Checking your wallet…' : 'Hold some to enter'}</div>
      <p className="text-xs m-0" style={{ color: 'var(--bw-muted)' }}>
        The {title} room is open to holders of this token.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBuy}
          className="flex-1 py-2.5 rounded-xl border-0 font-bold cursor-pointer"
          style={{ background: 'var(--bw-accent)', color: 'var(--bw-on-accent)' }}
        >
          Buy {title}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2.5 rounded-xl font-semibold cursor-pointer bg-transparent"
          style={{ border: '1px solid var(--bw-line)', color: 'var(--bw-text)' }}
        >
          Not now
        </button>
      </div>
    </div>
  </div>
);
