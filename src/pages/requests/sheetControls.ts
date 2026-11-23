/**
 * Which approval-sheet controls may be pressed (b-Aware 26 Oct 2026, N3-4).
 *
 * Allow waits while the sheet arms (a short delay against tap-jacking), while it is held (a finger came down on it), while
 * a careful card still has unread lines, and while an answer is being sent. Refusing is always safe, so Not now, Block
 * and the close button wait only for an answer already being sent: a user can always say no.
 */
export function sheetControls(s: { busy: boolean; armed: boolean; hold: boolean; mustRead: boolean }) {
  return { allowDisabled: s.busy || !s.armed || s.hold || s.mustRead, denyDisabled: s.busy };
}

/** Escape on the sheet means "Not now", unless an answer is already on its way. */
export const escapeDenies = (e: { key: string; defaultPrevented?: boolean }, busy: boolean) =>
  e.key === 'Escape' && !e.defaultPrevented && !busy;

/**
 * A sheet that can pay or is red holds Allow for a moment when it appears (review of #558, L7): a payment queued behind
 * a Connect sheet now opens as its own PAY sheet right after it, so a double tap on Connect could land on Pay.
 */
export const APPEAR_HOLD_MS = 700;
export const holdsOnAppear = (kind: string): boolean =>
  kind === 'pay' || kind === 'careful' || kind === 'post' || kind === 'signonce';
