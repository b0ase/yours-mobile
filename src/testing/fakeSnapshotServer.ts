/**
 * Test support only: our storage server's spendable-first methods, in memory, built from its API doc
 * (bwalletx-storage docs/spendable-first-restore.md, "Server API (v1)"), over a StorageIdb standing in for its
 * database. Pages cross a JSON round trip, as on the wire without the binary codec (dates as ISO strings, bytes as
 * number arrays). No network, no real keys.
 */
import { Beef } from '@bsv/sdk';
import type { StorageIdb } from '@bsv/wallet-toolbox-client';
import { LEAN_STAMP } from '../services/spendableFirst';

type Row = Record<string, unknown>;
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const OUTPOINT = /^([0-9a-f]{64})\.(\d+)$/;

export type FakeServerOptions = {
  /** getCapabilities advertises spendableSnapshot v1 (default true). */
  enabled?: boolean;
  leanPageMax?: number;
  fullPageMax?: number;
  /** Change a page before it is sent (tests: forged or broken pages). */
  tamperPage?: (page: Row, lean: boolean) => void;
  /** Change a BEEF answer before it is sent. */
  tamperBeef?: (beef: Beef) => void;
};

export function fakeSnapshotServer(db: StorageIdb, o: FakeServerOptions = {}) {
  const calls: string[] = [];
  const sik = db.getSettings().storageIdentityKey;
  const user = async (identityKey: string) => (await db.findUsers({ partial: { identityKey } }))[0];

  const page = async (args: {
    lean: boolean;
    after?: number;
    limit?: number;
    identityKey: string;
    toStorageIdentityKey?: string;
  }) => {
    const lean = args.lean;
    const max = lean ? (o.leanPageMax ?? 5000) : (o.fullPageMax ?? 250);
    const limit = Math.min(args.limit ?? max, max);
    const after = args.after ?? 0;
    const chunk: Row = {
      fromStorageIdentityKey: sik,
      toStorageIdentityKey: args.toStorageIdentityKey ?? '',
      userIdentityKey: args.identityKey,
      provenTxs: [],
      provenTxReqs: [],
      outputBaskets: [],
      outputTags: [],
      txLabels: [],
      transactions: [],
      txLabelMaps: [],
      commissions: [],
      outputs: [],
      outputTagMaps: [],
      certificates: [],
      certificateFields: [],
    };
    const u = await user(args.identityKey);
    if (!u) return { version: 1, lean, chunk, next: null, counts: {}, deferred: [], bytes: 0 };
    const all = (await db.findOutputs({ partial: { userId: u.userId, spendable: true } }))
      .filter((x) => x.outputId > after)
      .sort((a, b) => a.outputId - b.outputId);
    const outs = all.slice(0, limit);
    const txIds = [...new Set(outs.map((x) => x.transactionId))];
    const txs: Row[] = [];
    const proven: Row[] = [];
    const reqs: Row[] = [];
    for (const id of txIds) {
      const t = (await db.findTransactions({ partial: { transactionId: id } }))[0] as unknown as Row;
      const row: Row = { ...t };
      if (lean) {
        delete row.rawTx;
        delete row.inputBEEF;
        delete row.provenTxId;
        row.updated_at = LEAN_STAMP;
      } else if (typeof t.provenTxId === 'number') {
        proven.push({ ...(await db.findProvenTxs({ partial: { provenTxId: t.provenTxId } }))[0] });
        delete row.rawTx;
      } else {
        const q = (await db.findProvenTxReqs({ partial: { txid: t.txid as string } }))[0];
        if (q) reqs.push({ ...q, history: '{}', notify: '{}' });
        delete row.rawTx;
      }
      txs.push(row);
    }
    const basketIds = new Set(outs.map((x) => x.basketId));
    chunk.outputBaskets = (await db.findOutputBaskets({ partial: { userId: u.userId } })).filter((b) =>
      basketIds.has(b.basketId),
    );
    chunk.transactions = txs;
    chunk.outputs = outs.map((x) => ({ ...x, spentBy: undefined }));
    chunk.provenTxs = proven;
    chunk.provenTxReqs = reqs;
    const next = all.length > limit ? outs[outs.length - 1].outputId : null;
    const p: Row = {
      version: 1,
      lean,
      chunk,
      next,
      counts: { outputs: outs.length, satoshis: outs.reduce((s, x) => s + x.satoshis, 0) },
      deferred: [],
      bytes: 0,
    };
    o.tamperPage?.(p, lean);
    return wire(p);
  };

  const beef = async (args: { outpoints: string[]; identityKey: string }) => {
    const u = await user(args.identityKey);
    const out = {
      version: 1,
      beef: null as number[] | null,
      included: [] as string[],
      notFound: [] as string[],
      spent: [] as string[],
      deferred: [],
      tooLarge: [],
      unavailable: [] as string[],
      bytes: 0,
    };
    if (!u) return { ...out, notFound: args.outpoints };
    const b = new Beef();
    for (const op of args.outpoints) {
      const m = OUTPOINT.exec(op);
      if (!m) throw new Error('WERR_INVALID_PARAMETER outpoints');
      const row = (await db.findOutputs({ partial: { userId: u.userId, txid: m[1], vout: Number(m[2]) } }))[0];
      if (!row) {
        out.notFound.push(op);
        continue;
      }
      if (!row.spendable) {
        out.spent.push(op);
        continue;
      }
      try {
        b.mergeBeef(await db.getBeefForTransaction(m[1], { ignoreServices: true }));
        out.included.push(op);
      } catch {
        out.unavailable.push(op);
      }
    }
    if (out.included.length) {
      o.tamperBeef?.(b);
      out.beef = Array.from(b.toBinary());
    }
    return wire(out);
  };

  const client = {
    calls,
    getSettings: () => ({ storageIdentityKey: sik }),
    async rpcCall(method: string, params: unknown[]) {
      calls.push(method);
      const a = (params[0] ?? {}) as Record<string, unknown>;
      if (method === 'getCapabilities')
        return o.enabled === false
          ? { actionBatch: { version: 1 } }
          : {
              actionBatch: { version: 1 },
              spendableSnapshot: {
                version: 1,
                methods: ['getSpendableSnapshot', 'getBeefForOutpoints'],
                limits: { leanPageMax: o.leanPageMax ?? 5000, fullPageMax: o.fullPageMax ?? 250, beefMaxOutpoints: 25 },
              },
            };
      if (o.enabled === false) throw new Error('Method not found');
      if (method === 'getSpendableSnapshot') return page(a as never);
      if (method === 'getBeefForOutpoints') return beef(a as never);
      throw new Error('Method not found');
    },
  };
  return client;
}
