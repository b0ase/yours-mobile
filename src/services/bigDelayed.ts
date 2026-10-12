/**
 * Big transactions go out through the wallet's background sender, not inline (owner, 12 Oct 2026).
 *
 * A video inscription (vexvoid.com) can be several MB. Broadcasting it inline makes the site wait on the upload and
 * the network's verdict, and a slow line times out. For a transaction over BIG_TX_BYTES the wallet sets
 * acceptDelayedBroadcast: true, so createAction / signAction return at once with the txid and the send queued
 * ({txid, pending: true, sendWithResults: [{txid, status: 'sending'}]}, the shape sites already read for a queued
 * send). The toolbox Monitor's SendWaiting task then uploads it with the size-scaled timeout (bigBroadcast.ts), and
 * a send that never lands is still released after 24 h / 6 attempts (stuckSends.ts). Small transactions are never
 * changed.
 */

import { QUEUED_MESSAGE } from './repeatGuard';

/** Over this many bytes (serialized tx plus its BEEF), the send goes to the background sender. */
export const BIG_TX_BYTES = 1_000_000;

type ScriptOutput = { lockingScript?: string };
type ScriptInput = { unlockingScript?: string; unlockingScriptLength?: number };
type CreateLike = {
  inputBEEF?: ArrayLike<number>;
  inputs?: ScriptInput[];
  outputs?: ScriptOutput[];
  options?: { acceptDelayedBroadcast?: boolean; noSend?: boolean; signAndProcess?: boolean };
};
type SignLike = {
  spends?: Record<string | number, { unlockingScript?: string }>;
  options?: { acceptDelayedBroadcast?: boolean; noSend?: boolean };
};

const hexBytes = (h: unknown) => (typeof h === 'string' ? Math.floor(h.length / 2) : 0);

/** Approximate bytes a createAction will post: its outputs' and inputs' scripts plus the input BEEF. */
export function createActionBytes(args: CreateLike): number {
  let n = args.inputBEEF?.length ?? 0;
  for (const o of args.outputs ?? []) n += hexBytes(o?.lockingScript) + 9;
  for (const i of args.inputs ?? [])
    n += (i?.unlockingScript ? hexBytes(i.unlockingScript) : (i?.unlockingScriptLength ?? 0)) + 41;
  return n;
}

/** Bytes the unlocking scripts add at signAction. */
export function signActionBytes(args: SignLike): number {
  let n = 0;
  for (const s of Object.values(args.spends ?? {})) n += hexBytes(s?.unlockingScript);
  return n;
}

/** Should this step's broadcast go to the background sender? Only when it broadcasts at all and it is big. */
export function shouldDelay(bytes: number, options: CreateLike['options'] | undefined): boolean {
  if (!(bytes > BIG_TX_BYTES)) return false;
  if (options?.acceptDelayedBroadcast === true) return false; // already delayed
  if (options?.noSend === true) return false; // a chain step: nothing goes out now
  if (options?.signAndProcess === false) return false; // signed later, decided at signAction
  return true;
}

/** The args with acceptDelayedBroadcast: true (a copy; the site's object is untouched). */
export function withDelayedBroadcast<T extends { options?: object }>(args: T): T {
  return { ...args, options: { ...(args.options ?? {}), acceptDelayedBroadcast: true } };
}

type SendResult = { txid: string; status: string };
type ResultLike = { txid?: string; sendWithResults?: SendResult[] };

/**
 * A delayed result marked pending, the same shape as a queued send (repeatGuard.queuedResult): txid, pending: true,
 * sendWithResults with status 'sending'. A result without a txid is returned unchanged.
 */
export function pendingShape<R extends ResultLike>(result: R): R {
  const txid = result?.txid ?? result?.sendWithResults?.find((r) => r?.txid)?.txid;
  if (!txid) return result;
  const sendWithResults = result.sendWithResults?.length ? result.sendWithResults : [{ txid, status: 'sending' }];
  return { ...result, txid, pending: true, message: QUEUED_MESSAGE, sendWithResults } as R;
}

/**
 * Run the Monitor's SendWaiting soon after a send was queued, instead of waiting for the next wake. SendWaiting only
 * picks up a request 7 s after its last update (toolbox agedMsecs), so the first kick is after that; later kicks
 * cover a first upload that timed out. Each run is cheap when nothing waits.
 */
export const KICK_DELAYS_MS = [8_000, 45_000, 3 * 60_000, 10 * 60_000];

export function kickSendWaiting(
  run: () => Promise<unknown>,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  log: (m: string) => void = console.log,
): void {
  for (const ms of KICK_DELAYS_MS)
    schedule(() => {
      void run()
        .then((r) => {
          if (typeof r === 'string' && r.trim()) log(`[bigSend] SendWaiting: ${r.trim()}`);
        })
        .catch((e: unknown) => log(`[bigSend] SendWaiting failed: ${e instanceof Error ? e.message : String(e)}`));
    }, ms);
}
