/**
 * Keep the real error when a permissions-manager action fails.
 *
 * vexvoid.com mints and NFT sends, 11–12 Oct 2026: wallet-toolbox WalletPermissionsManager.signAction (and its
 * create-and-sign path) catch ANY failure of the underlying sign/broadcast, call blockAndAbortAction(reference) and
 * then rethrow. When the action was already handed to the network (status sending/failed/unproven), the abort is
 * refused with "The reference parameter must be an inprocess, outgoing action that has not been signed and shared to
 * the network." — and that refusal is thrown INSTEAD of the original error. Sites saw a mystery error, retried, and
 * the Monitor later broadcast every "failed" attempt (duplicate mints); NFT sends showed "unknown error".
 *
 * The abort is best effort: if it is refused, leave the action to the toolbox (it is already sent or failed) and let
 * the original error through.
 */
type AbortCapable = { blockAndAbortAction?: (reference: string) => Promise<void> };

export const ALREADY_SHARED = /inprocess, outgoing action that has not been signed and shared/i;

export function preserveOriginalErrors<T extends object>(manager: T, log: (msg: string) => void = console.warn): T {
  const m = manager as T & AbortCapable;
  const original = m.blockAndAbortAction;
  if (typeof original !== 'function') return manager;
  m.blockAndAbortAction = async (reference: string) => {
    try {
      await original.call(manager, reference);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(
        `[permissions] abort of ${reference} after a failed action was refused (${ALREADY_SHARED.test(msg) ? 'already sent or failed' : msg}); keeping the original error`,
      );
    }
  };
  return manager;
}
