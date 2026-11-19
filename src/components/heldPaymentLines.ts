import type { QueuedSend } from '../services/stuckSends';
import type { SendLineItem } from './SendConfirmation';

/** Restored from a backup, as the list says it: not queued on this device (services/releaseMarks.ts). */
export const RESTORED_LABEL = 'Restored from backup';
/** Another device's payment the network has no copy of (it may have dropped, or never been sent): round 6, d. */
export const ELSEWHERE_LABEL = 'From another device, not on the network';
/** Shown for one this device never saw on the network: it can be cancelled here, not sent. */
export const NEVER_SEEN_NOTE = 'Never seen on the network: Cancel releases it here.';

/**
 * The confirmation sheet's lines for a held payment: each recipient its own bytes pay (never a backup's description
 * or amount: review round 3, d). Empty when its bytes couldn't be read, so it can't be sent from the list.
 */
export function heldLineItems(p: Pick<QueuedSend, 'recipients'>, fmt: (sats: number) => string): SendLineItem[] {
  return (p.recipients ?? []).map((r) => ({ address: r.to, amount: fmt(r.sats), sats: r.sats }));
}
