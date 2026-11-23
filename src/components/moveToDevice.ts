import { sendMessageAsync } from '../utils/chromeHelpers';
import { stillMovingText } from '../services/localFirst';

/** Plain words for when the next automatic move to this device is due (MoveToDeviceNotice, review 4 Nov 2026 F4). */
export const nextTryText = (nextRetryAt: number, now = Date.now()): string => {
  const mins = Math.ceil((nextRetryAt - now) / 60_000);
  return mins <= 0
    ? 'It tries again on its own next time the wallet opens.'
    : `It tries again on its own in about ${mins} min.`;
};

/**
 * The default `send` of MoveToDeviceNotice and DeviceDataNote, defined once. An inline default (`send = (m) => …`) is a
 * new function on every render, so the notice's `load` and polling effect re-ran on every render, and each answer's new
 * status object rendered again: about 20,000 STORAGE_MOVE_STATUS messages a second while the wallet home was open
 * (release click-through, 4 Nov 2026).
 */
export function moveStatusSend<T>(m: object): Promise<T> {
  return sendMessageAsync<T>(m);
}

/** How often the move notice asks while the move is unknown or not done: then it clears soon after the move ends. */
export const NOTICE_FAST_POLL_MS = 5_000;

/**
 * The move notice's next ask (release click-through, 4 Nov 2026): every 5 s while the background hasn't answered yet
 * (the wallet is still opening) or the account isn't on this device, else the steady interval. A plain number, so the
 * polling effect depends on primitives only (no re-run per render).
 */
export const noticePollMs = (status: { onDevice: boolean } | null, steadyMs: number): number =>
  !status || !status.onDevice ? NOTICE_FAST_POLL_MS : steadyMs;

/**
 * Does the move notice show? Not once the account is on this device, and never while an instant restore runs
 * (services/spendableFirst.ts): "Retry moving this account to this device" would only confuse a wallet that is loading
 * its own snapshot (owner's restore, 20 Nov 2026).
 */
export const moveNoticeShows = (status: { onDevice: boolean; snapshotLoading?: boolean } | null): boolean =>
  !!status && !status.onDevice && !status.snapshotLoading;

export const RETRY_STILL_MOVING =
  'Still moving. Keep the wallet open until this finishes; if it stops, it carries on the next time the wallet opens.';

/** The background's answer to Retry (STORAGE_MOVE_TO_DEVICE), as far as the note under the button needs it. */
type RetryAnswer = { success?: boolean; error?: string; data?: { moving?: boolean } } | undefined;

/**
 * The note under the button after Retry (5.2.62). The background answers in about 2 s: done, still moving (it carries on
 * in the background and the button shows "Still moving: N of M" until it ends), or not moved, with the reason.
 */
export const retryNote = (r: RetryAnswer): string => {
  if (r?.success) return 'Done: this account is on this device now.';
  if (r?.data?.moving) return RETRY_STILL_MOVING;
  return `Not moved yet${r?.error ? ` (${r.error})` : ''}.`;
};

/** The Retry button's words: "Still moving: N of M…" while a move runs (the button is disabled then). */
export const retryButtonText = (
  busy: boolean,
  status: { moving: boolean; progress?: { done: number; total: number } | null },
): string =>
  busy
    ? 'Moving…'
    : status.moving
      ? `${stillMovingText(status.progress)}…`
      : 'Retry moving this account to this device';

/** The note as shown: the "still moving" note goes once the move has ended (the status line then says how it ended). */
export const shownRetryNote = (note: string, moving: boolean): string =>
  note === RETRY_STILL_MOVING && !moving ? '' : note;
