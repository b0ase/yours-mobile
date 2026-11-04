/**
 * What the Store's pay sheet shows (release click-through, 4 Nov 2026).
 *
 * F-D: when a payment waits because this account is still moving to this device (services/localFirst.ts
 * LOCAL_STORE_NEEDED_MESSAGE), the sheet shows the move notice with its "Retry moving this account to this device"
 * button FIRST, without the big price hero and with one short line, so the button sits on the first screen of a phone
 * (at 390×844 it was below the fold, while the long message sent people to the wallet's home).
 */
export const MOVING_SHORT = 'Nothing was sent: this account is still moving to this device.';

export const isMovingError = (message: string | undefined): boolean =>
  !!message && /moving to this device/i.test(message);

export function errorLayout(message: string | undefined): { hero: boolean; notice: boolean; error?: string } {
  if (isMovingError(message)) return { hero: false, notice: true, error: MOVING_SHORT };
  return { hero: true, notice: false, error: message };
}
