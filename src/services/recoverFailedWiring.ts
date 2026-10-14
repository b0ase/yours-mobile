/**
 * The toolbox side of recoverFailed.ts: what initWallet passes to recoverMinedFailedActions. A module of its own so
 * the incident tests (src/incident/sweepHidden.test.ts) run exactly the production wiring.
 */
import type { Wallet, WalletStorageManager, sdk } from '@bsv/wallet-toolbox-client';
import type { FailedAction, RecoverDeps, RecoverReport } from './recoverFailed';

export type RecoverWiring = {
  storage: Pick<WalletStorageManager, 'getAuth' | 'runAsStorageProvider' | 'isActiveStorageProvider'>;
  wallet: Pick<Wallet, 'listFailedActions'>;
  services: {
    getMerklePath: (txid: string) => Promise<{ merklePath?: unknown } | undefined>;
    /** The toolbox UTXO check (utxoStatus.ts once initWallet has fixed it). Without it, hidden change isn't looked for. */
    getUtxoStatus?: (
      hash: string,
      format: undefined,
      outpoint: string,
    ) => Promise<{ status?: string; isUtxo?: boolean }>;
  };
  monitor?: { runTask: (name: string) => Promise<string> } | null;
};

const STUCK: sdk.TransactionStatus[] = ['unprocessed', 'unsigned', 'sending'];
/** Statuses listActions (History) shows and the balance counts, when the outputs are spendable. */
const SETTLED: sdk.TransactionStatus[] = ['completed', 'unproven', 'nosend'];

/**
 * dkg, 14 Oct 2026 (sweep 9f66943b, second look): an action History shows ('completed' / 'unproven') whose own
 * change output is NOT spendable, while the chain says that output is unspent. An UnFail run before the utxoStatus
 * fix (5.2.20) did exactly this: it moved the sweep from 'failed' to 'unproven' but left its change unspendable
 * because every UTXO answer was "unknown". From then on the sweep was neither failed nor stuck, so
 * "Find mined payments" never looked at it again: "Nothing to restore", balance 0, History +586 BSV.
 *
 * Candidates: wallet change outputs (basket 'default', change) with spendable false and no spending action of
 * ours, whose outpoint the chain conclusively calls unspent. A released output that was really spent, or an
 * inconclusive answer, is never a candidate, so settled actions are not churned on every run.
 */
async function hiddenChange(
  sp: Parameters<Parameters<RecoverWiring['storage']['runAsStorageProvider']>[0]>[0],
  userId: number | undefined,
  isUnspent: (outpoint: string) => Promise<boolean>,
): Promise<FailedAction[]> {
  if (userId === undefined) return [];
  const [basket] = await sp.findOutputBaskets({ partial: { userId, name: 'default' } });
  if (!basket) return [];
  const outs = (
    await sp.findOutputs({ partial: { userId, basketId: basket.basketId, spendable: false, change: true } })
  ).filter((o) => o.spentBy == null && o.txid);
  const byTx = new Map<number, typeof outs>();
  for (const o of outs) byTx.set(o.transactionId, [...(byTx.get(o.transactionId) ?? []), o]);
  const found: FailedAction[] = [];
  for (const [transactionId, list] of byTx) {
    const [t] = await sp.findTransactions({ partial: { userId, transactionId }, noRawTx: true });
    if (!t?.txid || !SETTLED.includes(t.status)) continue;
    let unspent = false;
    for (const o of list) if (!unspent) unspent = await isUnspent(`${o.txid}.${o.vout}`).catch(() => false);
    if (!unspent) continue;
    found.push({
      txid: t.txid,
      status: t.status,
      description: t.description,
      satoshis: list.reduce((n, o) => n + o.satoshis, 0),
      createdAt: ms(t.created_at),
    });
  }
  return found;
}
const ms = (d: Date | string) => new Date(d).getTime();

export function makeRecoverDeps(w: RecoverWiring): RecoverDeps {
  const { storage } = w;
  const userIdOf = async () => (await storage.getAuth(true)).userId;
  return {
    // Failed actions, plus mined actions a killed app left 'unprocessed' / 'unsigned' / 'sending' (dkg sweep), plus
    // settled actions whose unspent change storage holds as unspendable (hiddenChange).
    listFailed: async () => {
      const userId = await userIdOf();
      const failed = (
        (await w.wallet.listFailedActions({ labels: [], includeOutputs: true, limit: 200 }, false))
          .actions as unknown as FailedAction[]
      ).map((a) => ({ ...a, status: 'failed' }));
      return storage.runAsStorageProvider(async (sp) => {
        const out: FailedAction[] = [];
        for (const a of failed) {
          const [t] = await sp.findTransactions({ partial: { userId, txid: a.txid }, noRawTx: true });
          out.push({ ...a, description: a.description ?? t?.description, createdAt: t ? ms(t.created_at) : undefined });
        }
        for (const t of await sp.findTransactions({ partial: { userId }, status: STUCK, noRawTx: true }))
          if (t.txid)
            out.push({
              txid: t.txid,
              status: t.status,
              description: t.description,
              satoshis: t.satoshis,
              createdAt: ms(t.created_at),
            });
        const check = w.services.getUtxoStatus;
        if (check)
          out.push(
            ...(await hiddenChange(sp, userId, async (outpoint) => {
              const r = await check('', undefined, outpoint);
              return r?.status === 'success' && r.isUtxo === true;
            })),
          );
        return out;
      });
    },
    queueUnfail: (txids) =>
      storage.runAsStorageProvider(async (sp) => {
        let n = 0;
        for (const txid of txids)
          for (const req of await sp.findProvenTxReqs({ partial: { txid } })) {
            await sp.updateProvenTxReq(req.provenTxReqId, { status: 'unfail' });
            n++;
          }
        return n;
      }),
    // A merkle proof, nothing less: mempool or "unknown" leaves the action as it is.
    isMined: async (txid) => !!(await w.services.getMerklePath(txid))?.merklePath,
    runUnFail: async () => (w.monitor ? await w.monitor.runTask('UnFail') : ''),
    spendableOf: async (txid) => {
      const userId = await userIdOf();
      return storage.runAsStorageProvider(async (sp) => {
        const [t] = await sp.findTransactions({ partial: { userId, txid }, noRawTx: true });
        const outs = t ? await sp.findOutputs({ partial: { userId, transactionId: t.transactionId } }) : [];
        const ok = outs.filter((o) => o.spendable);
        return {
          status: t?.status,
          outputs: outs.length,
          spendable: ok.length,
          spendableSats: ok.reduce((n, o) => n + o.satoshis, 0),
        };
      });
    },
    available: () => storage.isActiveStorageProvider(),
  };
}

/** One repair at a time (startup and Settings › Troubleshooting can overlap); a second caller shares the run. */
let running: Promise<RecoverReport> | null = null;
export function runRecoverOnce(run: () => Promise<RecoverReport>): Promise<RecoverReport> {
  running ??= run().finally(() => {
    running = null;
  });
  return running;
}
