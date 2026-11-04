/** Plain words for when the next automatic move to this device is due (MoveToDeviceNotice, review 4 Nov 2026 F4). */
export const nextTryText = (nextRetryAt: number, now = Date.now()): string => {
  const mins = Math.ceil((nextRetryAt - now) / 60_000);
  return mins <= 0
    ? 'It tries again on its own next time the wallet opens.'
    : `It tries again on its own in about ${mins} min.`;
};
