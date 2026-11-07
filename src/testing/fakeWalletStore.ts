/**
 * A wallet store for money tests that answers as the toolbox does: listOutputs lists spendable outputs of transactions
 * in completed/unproven/nosend/sending only; balance() counts managed change in 'default' only; listActions feeds
 * inFlightChangeSats ('unprocessed'); findOutputs/findTransactions are the device-store reads heldOutpoints.ts makes;
 * internalizeAction records an AtomicBEEF's chosen outputs as a new 'unproven' transaction (a merge changes nothing).
 * Test support only.
 */
import { Beef } from '@bsv/sdk';
import type { HeldStore } from '../services/heldOutpoints';

export type Row = {
  outputId: number;
  transactionId: number;
  txid: string;
  vout: number;
  satoshis: number;
  /** '' = in no basket (a quarantined row). */
  basket: string;
  spendable: boolean;
  spentBy?: number;
  change: boolean;
};
export type Tx = { transactionId: number; txid: string; status: string };

const LISTED = ['completed', 'unproven', 'nosend', 'sending'];

export class FakeStore {
  rows: Row[] = [];
  txs: Tx[] = [];
  internalized: string[] = [];

  tx(txid: string, status: string): Tx {
    const had = this.txs.find((t) => t.txid === txid);
    if (had) return had;
    const t = { transactionId: this.txs.length + 1, txid, status };
    this.txs.push(t);
    return t;
  }
  out(t: Tx, vout: number, satoshis: number, basket: string, change: boolean, spendable = true): Row {
    const r: Row = {
      outputId: this.rows.length + 1,
      transactionId: t.transactionId,
      txid: t.txid,
      vout,
      satoshis,
      basket,
      spendable,
      change,
    };
    this.rows.push(r);
    return r;
  }
  statusOf = (id: number | undefined) => this.txs.find((t) => t.transactionId === id)?.status;
  row = (txid: string, vout = 0) => this.rows.find((r) => r.txid === txid && r.vout === vout);
  /** sweepDeposit on this device: spends the coin into fresh change. */
  sweep(from: Row, txid: string, fee: number, status = 'unproven'): Row {
    const t = this.tx(txid, status);
    from.spendable = false;
    from.spentBy = t.transactionId;
    return this.out(t, 0, from.satoshis - fee, 'default', true);
  }

  /** The device-store reads initWallet hands heldOutpoints.ts (StorageIdb's shape). */
  held(): HeldStore {
    return {
      findOutputs: async ({ partial }) =>
        this.rows
          .filter(
            (r) =>
              (partial.vout === undefined || r.vout === partial.vout) &&
              (partial.transactionId !== undefined
                ? r.transactionId === partial.transactionId
                : r.txid === partial.txid),
          )
          .map((r) => ({ ...r, basketId: r.basket ? 1 : null, spentBy: r.spentBy ?? null })),
      findTransactions: async ({ partial }) =>
        this.txs.filter((t) =>
          partial.transactionId !== undefined ? t.transactionId === partial.transactionId : t.txid === partial.txid,
        ),
    };
  }

  /** The wallet surface balanceSplit and the coin intake use. */
  wallet() {
    return {
      balance: async () =>
        this.rows
          .filter(
            (r) =>
              r.basket === 'default' &&
              r.change &&
              r.spendable &&
              r.spentBy === undefined &&
              LISTED.includes(this.statusOf(r.transactionId) ?? ''),
          )
          .reduce((t, r) => t + r.satoshis, 0),
      listOutputs: async ({ basket }: { basket: string }) => {
        const outputs = this.rows
          .filter((r) => r.basket === basket && r.spendable && LISTED.includes(this.statusOf(r.transactionId) ?? ''))
          .map((r) => ({ outpoint: `${r.txid}.${r.vout}`, satoshis: r.satoshis, spendable: true }));
        return { totalOutputs: outputs.length, outputs };
      },
      listActions: async (a: { includeOutputs?: boolean; limit?: number; offset?: number }) => ({
        totalActions: this.txs.length,
        actions: this.txs.slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 50)).map((t) => ({
          status: t.status,
          outputs: this.rows
            .filter((r) => r.transactionId === t.transactionId)
            .map((r) => ({ satoshis: r.satoshis, spendable: r.spendable, basket: r.basket })),
        })),
      }),
      internalizeAction: async (a: {
        tx: number[];
        outputs: { outputIndex: number; insertionRemittance?: { basket: string } }[];
      }) => {
        const beef = Beef.fromBinary(a.tx);
        const txid = beef.atomicTxid!;
        const tx = beef.findTxid(txid)!.tx!;
        const t = this.tx(txid, 'unproven');
        for (const o of a.outputs)
          if (!this.row(txid, o.outputIndex))
            this.out(
              t,
              o.outputIndex,
              tx.outputs[o.outputIndex].satoshis ?? 0,
              o.insertionRemittance?.basket ?? '',
              false,
            );
        this.internalized.push(txid);
        return { accepted: true };
      },
    };
  }
}
