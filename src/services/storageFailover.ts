/**
 * Online storage failover for createAction (owner's extension, 30 Oct 2026, v5.2.45).
 *
 * Every payment failed with WERR_INTERNAL ("An internal error has occurred.") thrown by @bsv/wallet-toolbox
 * StorageClient.rpcCall → createAction: the account's active storage was the remote (wallet.1sat.app) and that server
 * answered its generic internal error for this account, while the rest of the server was up.
 *
 * Every account also has this device's own store (StorageIdb, registered by @1sat/wallet createWalletCore as a backup
 * and refreshed by the BackupSync task every 5 minutes). Here, when the remote is active and createAction fails with
 * WERR_INTERNAL or a network / 5xx error:
 *   1. the same call is tried once more on the remote (a passing hiccup);
 *   2. if it fails the same way again, the wallet makes This device active (`switchToLocal`, the same path as
 *      Settings › Storage › This device: wallet-toolbox `setActive` copies the remote's records into the local store
 *      BEFORE the flip, so the local copy is current, and the remote stays a backup the BackupSync keeps updated);
 *   3. the call is run ONCE on the local store.
 * If the switch fails (no local store, or the remote cannot even be read for the merge), the error says so in words
 * and points to Settings › Storage (StorageFailoverError, REMOTE_FAILING_MESSAGE).
 *
 * Double-spend safety: a retry or a switch happens only when the failure came BEFORE the signed payment reached the
 * storage's processAction (fourth review 17d, P1). createAction is two calls to the remote: createAction (builds the
 * unsigned payment; nothing signed, nothing broadcast) and, after signing here, processAction, which stores the signed
 * payment and broadcasts it from the server. A 504 or a lost answer from processAction may come after the server
 * broadcast: retrying then built a SECOND payment from other coins (reproduced on the real wallet-toolbox with a fake
 * remote, incident/doublePay.test.ts). So `processStarts` (processActionStarts below) counts processAction calls, and
 * a storage failure once it moved is never retried or failed over: it is StorageMaybeSentError, "can't confirm".
 * An unsigned action the remote may have half-written in its createAction only reserves coins on the remote; it never
 * spends them. Calls whose meaning depends on remote-held state (sendWith, noSendChange, a site's multi-step chain)
 * are not eligible and fail as before. Insufficient funds and every other error are never retried here.
 *
 * Pure apart from the injected deps. Tested in storageFailover.test.ts.
 */

export const REMOTE_FAILING_MESSAGE =
  "bWalletX's online storage (wallet.1sat.app) is failing for your account. Switch to This device in Settings › Storage.";

export const STORAGE_FAILOVER_CODE = 'WERR_STORAGE_REMOTE_FAILING';

/** The online storage failed after the signed payment reached it: it may have gone out (17d P1). */
export const REMOTE_MAYBE_SENT_MESSAGE =
  "We can't confirm whether this went out: the online storage stopped answering after the signed payment reached it. Check History before sending again.";
export const STORAGE_MAYBE_SENT_CODE = 'WERR_STORAGE_MAYBE_SENT';

export class StorageMaybeSentError extends Error {
  readonly code = STORAGE_MAYBE_SENT_CODE;
  constructor(readonly cause?: unknown) {
    super(REMOTE_MAYBE_SENT_MESSAGE);
    this.name = STORAGE_MAYBE_SENT_CODE;
  }
}

const STARTS = Symbol.for('bwx.processActionStarts');
type Counted = { processAction?: (...a: unknown[]) => Promise<unknown>; [STARTS]?: { n: number } };

/**
 * How many times this storage manager's processAction has started (the step that stores the signed payment and, on
 * an online storage, broadcasts it). Wraps the instance's method once (idempotent); 0 forever when there is none.
 */
export function processActionStarts(storage: unknown): () => number {
  const s = storage as Counted | null | undefined;
  if (!s || typeof s.processAction !== 'function') return () => 0;
  if (!s[STARTS]) {
    const counter = { n: 0 };
    const original = s.processAction;
    s.processAction = function (this: unknown, ...a: unknown[]) {
      counter.n++;
      return original.apply(this, a);
    };
    s[STARTS] = counter;
  }
  const c = s[STARTS]!;
  return () => c.n;
}

/**
 * Pure: a storage failure from an online store once processAction started reads "can't confirm", never "nothing was
 * sent" (17d P1). Other errors pass unchanged.
 */
export const maybeSentAfterProcess = (e: unknown, o: { remoteActive: boolean; processStarted: boolean }): unknown =>
  o.remoteActive && o.processStarted && isRemoteStorageFailure(e) ? new StorageMaybeSentError(e) : e;

export class StorageFailoverError extends Error {
  readonly code = STORAGE_FAILOVER_CODE;
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = STORAGE_FAILOVER_CODE;
  }
}

const textOf = (e: unknown): string => {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return `${e.name} ${e.message}`;
  if (e && typeof e === 'object') {
    const o = e as { name?: unknown; code?: unknown; message?: unknown };
    return `${String(o.name ?? '')} ${String(o.code ?? '')} ${String(o.message ?? '')}`;
  }
  return String(e);
};

/** Pure: an error that means "the online storage failed", not "this payment is wrong". */
export const isRemoteStorageFailure = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  const t = `${typeof code === 'string' ? code : ''} ${textOf(e)}`;
  if (/WERR_INSUFFICIENT_FUNDS|insufficient funds|WERR_INVALID_PARAMETER|WERR_REVIEW_ACTIONS|denied/i.test(t))
    return false;
  if (/WERR_INTERNAL|An internal error has occurred/i.test(t)) return true;
  if (/Failed to fetch|NetworkError|network error|ECONNRESET|ETIMEDOUT|timed? ?out|Remote storage connection/i.test(t))
    return true;
  return /\b(HTTP|status)\s*5\d\d\b|\b50[0234]\b|Bad Gateway|Service Unavailable|Gateway Timeout/i.test(t);
};

/** Pure: may this createAction run on another store? Not when it leans on records only the remote holds. */
export const failoverEligible = (p: {
  continuing: boolean;
  args: { options?: { sendWith?: unknown[]; noSendChange?: unknown[] } };
}): boolean => !p.continuing && !p.args.options?.sendWith?.length && !p.args.options?.noSendChange?.length;

export interface FailoverDeps<T> {
  create: () => Promise<T>;
  /** True when an online store (StorageClient) is the active one right now. */
  remoteActive: () => boolean;
  eligible: boolean;
  /** Make This device active (merge from the remote first) and persist it. Throws when it can't. */
  switchToLocal: () => Promise<void>;
  /** processActionStarts(storage): a failure after this moved may have gone out, so it is never retried (17d P1). */
  processStarts?: () => number;
  log?: (m: string, d?: unknown) => void;
}

export interface FailoverOutcome<T> {
  result: T;
  /** 'remote-retry': the second remote try worked. 'local': sent from This device after the switch. */
  via: 'first' | 'remote-retry' | 'local';
}

export async function createWithStorageFailover<T>(d: FailoverDeps<T>): Promise<FailoverOutcome<T>> {
  const log = d.log ?? (() => undefined);
  const starts = d.processStarts ?? (() => 0);
  /** The failure of one attempt, as the caller should see it: "can't confirm" once processAction started. */
  const settle = (e: unknown, before: number): unknown => {
    const out = maybeSentAfterProcess(e, { remoteActive: d.remoteActive(), processStarted: starts() > before });
    if (out !== e)
      log('[storageFailover] online storage failed after the signed payment reached it; not retried', textOf(e));
    return out;
  };
  let first: unknown;
  let before = starts();
  try {
    return { result: await d.create(), via: 'first' };
  } catch (e) {
    first = settle(e, before);
  }
  if (first instanceof StorageMaybeSentError) throw first;
  if (!d.eligible || !d.remoteActive() || !isRemoteStorageFailure(first)) throw first;
  log('[storageFailover] online storage failed; trying it once more', textOf(first));
  let second: unknown;
  before = starts();
  try {
    return { result: await d.create(), via: 'remote-retry' };
  } catch (e) {
    second = settle(e, before);
  }
  if (second instanceof StorageMaybeSentError) throw second;
  if (!isRemoteStorageFailure(second)) throw second;
  log('[storageFailover] online storage failed twice; switching to This device', textOf(second));
  try {
    await d.switchToLocal();
  } catch (e) {
    log('[storageFailover] could not switch to This device', textOf(e));
    throw new StorageFailoverError(REMOTE_FAILING_MESSAGE, second);
  }
  if (d.remoteActive()) throw new StorageFailoverError(REMOTE_FAILING_MESSAGE, second);
  const result = await d.create();
  log('[storageFailover] sent from This device');
  return { result, via: 'local' };
}
