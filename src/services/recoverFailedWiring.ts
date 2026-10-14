/**
 * The toolbox side of recoverFailed.ts: what initWallet passes to recoverMinedFailedActions. A module of its own so
 * the incident tests (src/incident/sweepHidden.test.ts) run exactly the production wiring.
 */
import type { Wallet, WalletStorageManager, sdk } from '@bsv/wallet-toolbox-client';
import type { FailedAction, RecoverDeps, RecoverReport } from './recoverFailed';

export type RecoverWiring = {
  storage: Pick<WalletStorageManager, 'getAuth' | 'runAsStorageProvider' | 'isActiveStorageProvider'>;
  wallet: Pick<Wallet, 'listFailedActions'>;
  services: { getMerklePath: (txid: string) => Promise<{ merklePath?: unknown } | undefined> };
  monitor?: { runTask: (name: string) => Promise<string> } | null;
};

const STUCK: sdk.TransactionStatus[] = ['unprocessed', 'unsigned', 'sending'];
const ms = (d: Date | string) => new Date(d).getTime();

export function makeRecoverDeps(w: RecoverWiring): RecoverDeps {
  const { storage } = w;
  const userIdOf = async () => (await storage.getAuth(true)).userId;
  return {
    // Failed actions, plus mined actions a killed app left 'unprocessed' / 'unsigned' / 'sending' (dkg sweep).
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
