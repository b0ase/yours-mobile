/**
 * Why a validated BSV-21 send came up short.
 *
 * sendBsv21 (@1sat/actions) only spends outputs the overlay reports 'valid',
 * and reports 'insufficient-valid-tokens' for any shortfall not covered by
 * 'queued' outputs. That lumps in outputs the overlay reports 'unknown': ones
 * it has not seen yet, e.g. a transfer broadcast a moment ago. Those are not
 * invalid, so telling the user "not validated" is wrong. This splits them out.
 *
 * It also lumps in outputs the overlay reports 'spent': the wallet's local
 * list is out of date (the spend happened on another device or was never
 * recorded here). Those are 'stale', fixed by Repair Sync, not by the overlay.
 */
export type Bsv21Shortfall = 'queued' | 'unseen' | 'stale' | 'not-valid';

export type Bsv21OutputState = { amount: bigint; state?: string };

export const classifyBsv21Shortfall = (outputs: Bsv21OutputState[], total: bigint): Bsv21Shortfall => {
  let valid = 0n;
  let queued = 0n;
  let unseen = 0n;
  let spent = 0n;
  for (const o of outputs) {
    if (o.state === 'valid') valid += o.amount;
    else if (o.state === 'queued') queued += o.amount;
    else if (o.state === undefined || o.state === 'unknown') unseen += o.amount;
    else if (o.state === 'spent') spent += o.amount;
  }
  if (valid + queued >= total) return 'queued';
  if (unseen > 0n && valid + queued + unseen >= total) return 'unseen';
  if (spent > 0n) return 'stale';
  return 'not-valid';
};
