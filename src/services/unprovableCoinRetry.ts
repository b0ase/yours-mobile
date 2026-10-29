/**
 * A coin whose history can't be proven must not fail the whole payment (TERRORNODE audit, 29 Oct 2026).
 *
 * An external site's plain createAction (one P2PKH output) failed in under a second, before any approval sheet,
 * because building the input BEEF for one selected change coin could not load a parent transaction (storage held no
 * raw tx / proof for it and the chain lookup failed). The toolbox throws WERR_INVALID_PARAMETER naming that txid
 * ("txid … valid transaction on chain main", or "… is not known") and gives up on the whole action, even when the
 * wallet holds other coins that would fund it.
 *
 * Here: when createAction fails that way, the outputs of the named transaction are set aside (spendable=false) for
 * ONE retry, which funds from other coins, and are then put back exactly as they were, whatever the retry did. The
 * failure is thrown while the transaction is being built, before anything is signed or broadcast, so the retry can
 * never pay twice. Any other error is passed through untouched.
 */

const TXID = /\b([0-9a-f]{64})\b/i;

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : String((e as { message?: unknown })?.message ?? '');

const codeOf = (e: unknown): string => {
  const o = e as { code?: unknown; name?: unknown } | null;
  return String((typeof o?.code === 'string' && o.code) || (typeof o?.name === 'string' && o.name) || '');
};

/**
 * Pure: the txid of a coin's parent that the build could not load, or undefined. Only the toolbox's build-time
 * "unknown parent" errors count; anything carrying broadcast results (sendWithResults / reviewActionResults) never
 * does, since that transaction may already have gone out.
 */
export function unprovableParentTxid(error: unknown): string | undefined {
  const o = error as { sendWithResults?: unknown; reviewActionResults?: unknown; txid?: unknown } | null;
  if (o && (o.sendWithResults || o.reviewActionResults || o.txid)) return undefined;
  const code = codeOf(error);
  if (code && code !== 'WERR_INVALID_PARAMETER') return undefined;
  const msg = messageOf(error);
  if (!/valid transaction on chain|known to storage|is not known/i.test(msg)) return undefined;
  return TXID.exec(msg)?.[1]?.toLowerCase();
}

export interface UnprovableRetryDeps<R> {
  create: () => Promise<R>;
  /**
   * Set aside this transaction's spendable outputs in the funding basket. Returns a function that puts back exactly
   * those it changed (0 changed: nothing to retry).
   */
  setAside: (txid: string) => Promise<{ count: number; restore: () => Promise<void> }>;
  log?: (msg: string, data?: unknown) => void;
}

/** Run create; after an unprovable-parent build failure, retry ONCE without that coin. Throws the final error. */
export async function createExcludingUnprovable<R>(d: UnprovableRetryDeps<R>): Promise<R> {
  try {
    return await d.create();
  } catch (first) {
    const txid = unprovableParentTxid(first);
    if (!txid) throw first;
    let aside: { count: number; restore: () => Promise<void> } | undefined;
    try {
      aside = await d.setAside(txid);
    } catch (e) {
      d.log?.('[unprovableCoin] could not set the coin aside', e);
      throw first;
    }
    try {
      if (aside.count <= 0) throw first;
      d.log?.('[unprovableCoin] retrying once without a coin whose history could not be loaded', {
        txid,
        outputs: aside.count,
      });
      return await d.create();
    } finally {
      await aside.restore().catch((e) => d.log?.('[unprovableCoin] restore failed', e));
    }
  }
}
