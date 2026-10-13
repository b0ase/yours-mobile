import { buyOrdinal, cancelOpnsListing, sellOpns, type OneSatContext } from '@1sat/actions';
import { assertOrdLockV2 } from '../market/ordlockVersion';
import { MODULE_FINISHES, purchaseContext, walletOutpoint } from '../market/walletOutpoint';

/**
 * Wallet calls for OpNS trading, shared by Get your name, bMint › OpNS names and the Exchange's Names tab.
 * buyOpns is buyOrdinal with OpNS defaults but drops usePermissionModule, which the module-wrapped wallet
 * needs (MODULE_FINISHES); so buy through buyOrdinal with the OpNS basket/content type instead.
 */
export const buyOpnsListing = async (ctx: OneSatContext, rawOutpoint: string, name: string): Promise<string> => {
  const outpoint = walletOutpoint(rawOutpoint);
  await assertOrdLockV2(outpoint);
  const res = await buyOrdinal.execute(purchaseContext(ctx, outpoint), {
    outpoint,
    name: name.slice(0, 64),
    contentType: 'application/op-ns',
    basket: 'opns',
    tags: ['opns'],
    ...MODULE_FINISHES,
  });
  if (res.error || !res.txid) throw new Error(String(res.error ?? 'Purchase failed'));
  return res.txid;
};

/** List one owned name (a plain P1SAT spend, like registerOpns / cancel: no module flag) (OPNS basket id) for `sats` with an OrdLock v2 listing. */
export const listOpnsName = async (ctx: OneSatContext, id: string, sats: number): Promise<string> => {
  const res = await sellOpns.execute(ctx, { id, price: sats });
  if (res.error || !res.txid) throw new Error(String(res.error ?? 'Listing failed'));
  return res.txid;
};

/** Take a listed name off sale, back into the wallet. */
export const unlistOpnsName = async (ctx: OneSatContext, id: string): Promise<string> => {
  const res = await cancelOpnsListing.execute(ctx, { id });
  if (res.error || !res.txid) throw new Error(String(res.error ?? 'Cancel failed'));
  return res.txid;
};
