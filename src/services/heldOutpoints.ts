/**
 * What wallet storage already holds for an outpoint on chain at one of our receive addresses.
 *
 * Owner, 5 Nov 2026: the extension showed $3.42 for $2.42. The receive guard asked "does storage hold this payment?"
 * through listOutputs, which lists only SPENDABLE outputs. Once sweepDeposit had spent the payment into fresh change,
 * the payment dropped out of that list while the indexer still listed it unspent (the sweep was not indexed yet), so the
 * guard counted it as "arriving" on top of the sweep's change. Storage is asked directly here, spent or not.
 *
 *  - 'accounted': storage counts this outpoint's value somewhere: it is spendable in a transaction the balance reads,
 *    or it was spent by one of this wallet's own transactions that is out or going out (its outputs carry the value).
 *  - 'stored': storage has a row for it that the balance does not count (a coin from the backup waiting on admission, a
 *    quarantined row, an output spent by a failed or unsigned action). Never taken in again: an internalize would
 *    rewrite that row. Not 'accounted' either, so money on chain the wallet cannot count yet still shows as arriving.
 *  - 'absent': no row at all.
 * Reads only, straight from the device store: nothing here writes or locks.
 */

export type OutpointState = 'accounted' | 'stored' | 'absent';

type OutputRow = { transactionId?: number; spendable?: boolean; spentBy?: number | null; basketId?: number | null };
type TxRow = { transactionId?: number; status?: string };

/** The StorageIdb reads used here (the device store; `userId` from storage.getAuth()). */
export type HeldStore = {
  findOutputs(args: {
    partial: { userId?: number; txid?: string; transactionId?: number; vout?: number };
    noScript?: boolean;
  }): Promise<OutputRow[]>;
  findTransactions(args: {
    partial: { userId: number; txid?: string; transactionId?: number };
    noRawTx?: boolean;
  }): Promise<TxRow[]>;
};

/** Transaction states whose outputs the balance reads (listOutputs, inFlightChangeSats). */
const COUNTED = new Set(['completed', 'unproven', 'sending', 'nosend', 'unprocessed']);

const split = (outpoint: string) => {
  const o = outpoint.replace('_', '.');
  const dot = o.lastIndexOf('.');
  return { key: o, txid: o.slice(0, dot), vout: Number(o.slice(dot + 1)) };
};

/** The state of each outpoint ("txid.vout" or "txid_vout"; keys come back as "txid.vout"). */
export async function outpointStates(
  store: HeldStore,
  userId: number,
  outpoints: Iterable<string>,
): Promise<Map<string, OutpointState>> {
  const out = new Map<string, OutpointState>();
  const statusById = new Map<number, string | undefined>();
  const status = async (id: number | null | undefined) => {
    if (typeof id !== 'number') return undefined;
    if (!statusById.has(id))
      statusById.set(
        id,
        (await store.findTransactions({ partial: { userId, transactionId: id }, noRawTx: true }))[0]?.status,
      );
    return statusById.get(id);
  };
  /**
   * A spender carries the value here only once its outputs here count: none still waits for admission (not spendable,
   * not spent, in a basket). Review 20, M5: a sweep pulled from the other device, its change not admitted yet, hid the
   * payment for minutes. A payment out with no change here carries it (it left). By transaction id, no user scan.
   */
  const carriesById = new Map<number, boolean>();
  const carries = async (spender: number) => {
    if (!carriesById.has(spender))
      carriesById.set(
        spender,
        !(await store.findOutputs({ partial: { transactionId: spender }, noScript: true })).some(
          (o) => o.spendable !== true && o.spentBy == null && o.basketId != null,
        ),
      );
    return carriesById.get(spender)!;
  };
  for (const op of outpoints) {
    const { key, txid, vout } = split(op);
    if (out.has(key) || !txid || !Number.isInteger(vout)) continue;
    // By its transaction first (a row may lack its txid), else by outpoint.
    const [t] = await store.findTransactions({ partial: { userId, txid }, noRawTx: true });
    const rows =
      typeof t?.transactionId === 'number'
        ? await store.findOutputs({ partial: { userId, transactionId: t.transactionId, vout }, noScript: true })
        : await store.findOutputs({ partial: { userId, txid, vout }, noScript: true });
    if (!rows.length) {
      out.set(key, 'absent');
      continue;
    }
    let state: OutpointState = 'stored';
    for (const r of rows) {
      if (!COUNTED.has((await status(r.transactionId)) ?? '')) continue;
      if (r.spendable === true || (COUNTED.has((await status(r.spentBy)) ?? '') && (await carries(r.spentBy!))))
        state = 'accounted';
    }
    out.set(key, state);
  }
  return out;
}

/** Of these txids, the ones storage holds a transaction for (any status). */
export async function knownTxids(store: HeldStore, userId: number, txids: Iterable<string>): Promise<Set<string>> {
  const known = new Set<string>();
  for (const txid of new Set(txids)) {
    if ((await store.findTransactions({ partial: { userId, txid }, noRawTx: true })).length) known.add(txid);
  }
  return known;
}

/** The device store and its user, or undefined when this device's store is not the active one. */
export type DeviceReads = () => Promise<{ store: HeldStore; userId: number } | undefined>;

/**
 * accountedFor for the receive guard and the balance: the outpoints the device store counts. With the remote store
 * active it names none, so arriving money counts as it always did there.
 */
export const accountedVia =
  (read: DeviceReads) =>
  async (outpoints: string[]): Promise<string[]> => {
    const r = outpoints.length ? await read() : undefined;
    if (!r) return [];
    const states = await outpointStates(r.store, r.userId, outpoints);
    return [...states].filter(([, s]) => s === 'accounted').map(([k]) => k);
  };
