/**
 * A connected site's multi-step action, in flight.
 *
 * vexvoid.com, 11 Oct 2026 (5.2.1): a 6.4 MB video mint failed after the owner approved it, with "The reference
 * parameter must be an inprocess, outgoing action that has not been signed and shared to the network." @1sat/actions
 * streams a large inscription as a chain of createActions (signAndProcess: false, noSend, each spending the previous
 * chunk and passing its noSendChange), signs each through signAction, and broadcasts them together with sendWith.
 * That error is wallet-toolbox findAbortableTransaction: @1sat/actions' completeSignedAction calls abortAction after
 * a local check fails, and the abort itself is refused. Before every one of those createActions the wallet was
 * running its funding preparation (services/fundingPrep.ts), which re-ran the receive guard: internalize, deposit
 * sweeps and a rescue spend, all between the steps of the site's chain.
 *
 * While a site's chain is active, the wallet's own background work (receive guard, rescue, sweeps) waits.
 */
import type { CreateActionArgs } from '@bsv/sdk';

/** A chain is active this long after its last step; a stalled one stops blocking background work after this. */
export const CHAIN_IDLE_MS = 5 * 60 * 1000;

let lastStep = 0;

/** Record a step of a site's multi-step action (createAction without broadcast, or signAction). */
export function markChainStep(now = Date.now()) {
  lastStep = now;
}
export function endChain() {
  lastStep = 0;
}
export const chainActive = (now = Date.now()) => lastStep > 0 && now - lastStep < CHAIN_IDLE_MS;

/**
 * True when a createAction continues a chain already in progress: it spends or carries earlier noSend work. Funding
 * preparation must never run between such steps.
 */
export function continuesChain(args: Pick<CreateActionArgs, 'inputs' | 'options'>): boolean {
  const o = args.options ?? {};
  return !!(o.noSendChange?.length || o.sendWith?.length || o.knownTxids?.length || (o.noSend && args.inputs?.length));
}

/** True when a createAction starts or continues work the site will finish later (not broadcast now). */
export function startsChain(args: Pick<CreateActionArgs, 'options'>): boolean {
  const o = args.options ?? {};
  return o.signAndProcess === false || !!o.noSend;
}

/** wallet-toolbox's refusal when abortAction targets an action that is already signed or shared. */
export const isAlreadyProcessedAbort = (err: unknown) =>
  /inprocess, outgoing action that has not been signed and shared/i.test(
    err instanceof Error ? err.message : String(err),
  );
