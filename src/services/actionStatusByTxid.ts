/**
 * The wallet's status for one txid, read by txid from this device's store (Store payments, review of f5c38ec1:
 * reading only the 300 most recent actions mistook an older 'nosend' payment for one already released).
 *
 * Returns the transaction's status ('nosend', 'failed', 'unproven'…) or null when the store holds no transaction with
 * that txid for this user. Throws when this device's store is not the active one (a remote store has no
 * StorageProvider to read): the caller then says "can't tell", never "gone".
 */
export type TxidStatusStorage = {
  isActiveStorageProvider(): boolean;
  getAuth(mustBeActive?: boolean): Promise<{ userId?: number }>;
  runAsStorageProvider<T>(
    f: (sp: {
      findTransactions(a: {
        partial: { userId?: number; txid?: string };
        noRawTx?: boolean;
      }): Promise<{ status?: string }[]>;
    }) => Promise<T>,
  ): Promise<T>;
};

const TXID = /^[0-9a-f]{64}$/i;

export async function actionStatusByTxid(storage: TxidStatusStorage, txid: string): Promise<string | null> {
  if (!TXID.test(txid)) throw new Error('not a txid');
  if (!storage.isActiveStorageProvider()) throw new Error("this device's store is not the active one");
  const { userId } = await storage.getAuth(true);
  if (userId === undefined) throw new Error('no user in the active store');
  return storage.runAsStorageProvider(async (sp) => {
    const rows = await sp.findTransactions({ partial: { userId, txid: txid.toLowerCase() }, noRawTx: true });
    return rows[0]?.status ?? null;
  });
}
