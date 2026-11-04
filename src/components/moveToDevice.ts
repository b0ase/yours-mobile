import { sendMessageAsync } from '../utils/chromeHelpers';

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
