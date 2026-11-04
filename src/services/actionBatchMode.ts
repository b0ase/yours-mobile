/**
 * No payment may live only in memory (P0, 3 Nov 2026).
 *
 * The owner's $1 theme test on his phone (tx 5916dd14…, one coin of about $1.17): the Store signed its payment with
 * noSend and our server broadcast it. With the device's own store active, the wallet-toolbox (2.14.5) keeps the first
 * noSend action of a session ONLY IN MEMORY, as an "action batch": no transaction, output or request row is written
 * until a later createAction sendWith commits it (toolbox ActionBatchController.plan / process; @1sat/wallet builds
 * every Wallet with mode 'auto'). A reload dropped it:
 *  - the change, with its random BRC-29 derivation that exists nowhere else, was gone for good;
 *  - the spent input looked spendable again once the batch's 15-minute reservation lapsed, so the next send would
 *    double-spend the coin the server had already broadcast.
 * Every noSend flow carried the same risk: the Store, room messages, paid listening, pots, posts, NPG melt.
 *
 * In 'legacy' mode the controller never opens a batch (negotiate() returns nothing), so every noSend createAction goes
 * through storage and is written at signing as an ordinary 'nosend' row: inputs locked, change rows with their
 * derivations stored (and pushed to the backup by deviceSync), and unsentExpiry / settleWhenSeen can see it. Multi-step
 * noSend chains (stream inscriptions) keep working through noSendChange, as they did before batches existed.
 * The mode is read on every plan, so setting it on the built wallet is enough.
 */

type BatchController = { mode?: string; hasWorkspace?: boolean };

/** Put the wallet's action batches in 'legacy' mode. Returns false when the wallet has no batch controller to set. */
export function forceLegacyActionBatch(wallet: unknown): boolean {
  const ab = (wallet as { actionBatch?: BatchController } | null)?.actionBatch;
  if (!ab || typeof ab !== 'object' || !('mode' in ab)) return false;
  ab.mode = 'legacy';
  return ab.mode === 'legacy';
}

/** True when every noSend action this wallet signs is written to storage at once. */
export const actionBatchIsLegacy = (wallet: unknown): boolean =>
  (wallet as { actionBatch?: BatchController } | null)?.actionBatch?.mode === 'legacy';
