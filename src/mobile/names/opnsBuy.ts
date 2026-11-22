import { opnsNameOf } from './opnsName';
import { buyOrdinal, cancelOpnsListing, listOpns, sellOpns, sendOpns, type OneSatContext } from '@1sat/actions';
import { assertOrdLockV2 } from '../market/ordlockVersion';
import { assertOpnsPayout } from './opnsBuyPrice';
import { MODULE_FINISHES, purchaseContext, walletOutpoint } from '../market/walletOutpoint';
import { STORE_BUILD, STORE_NAME_NOTE } from '../storeBuild';

export const listingNotTheName = (name: string) =>
  `This listing isn't the name "${name}" you approved: the coin for sale is a different inscription. Not buying it.`;
const CANT_CHECK_NAME = "Couldn't check which name this listing is. Try again in a moment.";

const sameOutpoint = (a: string, b: string) => a.replace('_', '.').toLowerCase() === b.replace('_', '.').toLowerCase();

/**
 * b-Aware row 349: the sheet's name comes from the listing's own metadata, and buyOrdinal trusted it as given. Before
 * paying, read which inscription the listed coin carries (ORDFS) and check it is THE OpNS name approved: an
 * application/op-ns inscription whose origin is the name's registered origin (1sat name index) and whose content is
 * that name. A counterfeit op-ns blob reading the same text has a different origin. Anything unreadable refuses.
 * Returns the checked origin.
 */
export const assertListedName = async (ctx: OneSatContext, outpoint: string, name: string): Promise<string> => {
  const want = name.trim().toLowerCase();
  const svc = ctx.services;
  if (!svc) throw new Error(CANT_CHECK_NAME);
  let held: { origin?: string; contentType?: string };
  let registered: string | undefined;
  try {
    const [meta, reg] = await Promise.all([svc.ordfs.getMetadata(outpoint, -2), svc.opns.getOrigin(want)]);
    held = meta;
    registered = reg?.outpoint;
  } catch {
    throw new Error(CANT_CHECK_NAME);
  }
  const origin = held?.origin;
  if (!origin || !registered) throw new Error(CANT_CHECK_NAME);
  if ((held.contentType ?? '').split(';')[0].trim() !== 'application/op-ns' || !sameOutpoint(origin, registered))
    throw new Error(listingNotTheName(name));
  let text: string;
  try {
    const c = await svc.ordfs.getContent(origin);
    text = new TextDecoder().decode(c.data).trim().toLowerCase();
  } catch {
    throw new Error(CANT_CHECK_NAME);
  }
  if (text !== want) throw new Error(listingNotTheName(name));
  return origin;
};

/**
 * Wallet calls for OpNS trading, shared by Get your name, bMint › OpNS names and the Exchange's Names tab.
 * buyOpns is buyOrdinal with OpNS defaults but drops usePermissionModule, which the module-wrapped wallet
 * needs (MODULE_FINISHES); so buy through buyOrdinal with the OpNS basket/content type instead.
 *
 * `approvedSats` is the price the user saw and allowed on the sheet. The sheet price comes from the listing's
 * MAP metadata, but the covenant pays its own payout output, so the listing's locking script is read here and the
 * buy is refused unless that payout equals `approvedSats` (opnsBuyPrice.ts). The checked BEEF is the one handed to
 * buyOrdinal, so it cannot fetch a different listing. No marketplace fee is added, so the total is the payout.
 */
export const buyOpnsListing = async (
  ctx: OneSatContext,
  rawOutpoint: string,
  name: string,
  approvedSats: number,
  store: boolean = STORE_BUILD,
): Promise<string> => {
  // Buying a listed name is a marketplace purchase: never in a store build (storeBuild.ts MARKET_ENABLED). It
  // refuses before anything is read from the network or asked of the wallet.
  if (store) throw new Error(STORE_NAME_NOTE);
  const outpoint = walletOutpoint(rawOutpoint);
  await assertOrdLockV2(outpoint);
  const [txid, vout] = outpoint.split('.');
  if (!ctx.services) throw new Error("Couldn't check this listing's contract. Try again in a moment.");
  const beef = await ctx.services.getBeefForTxid(txid);
  const out = beef.findTxid(txid)?.tx?.outputs[Number(vout)];
  if (!out) throw new Error("Couldn't check this listing's contract. Try again in a moment.");
  assertOpnsPayout(out.lockingScript, approvedSats, { marketFeeSats: 0, approvedTotalSats: approvedSats });
  const origin = await assertListedName(ctx, outpoint, name);
  const res = await buyOrdinal.execute(purchaseContext(ctx, outpoint), {
    outpoint,
    inputBEEF: beef.toBinary(),
    origin,
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
export const listOpnsName = async (
  ctx: OneSatContext,
  id: string,
  sats: number,
  store: boolean = STORE_BUILD,
): Promise<string> => {
  // Listing a name for sale is marketplace selling: never in a store build (as buyOpnsListing). It refuses before
  // anything is asked of the wallet.
  if (store) throw new Error(STORE_NAME_NOTE);
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

/** Gift a name: send the name ordinal to an ordinals address (opnsGift.ts picks it). Free, network fee only. */
export const giftOpnsName = async (ctx: OneSatContext, id: string, address: string): Promise<string> => {
  const res = await sendOpns.execute(ctx, { id, address });
  if (res.error || !res.txid) throw new Error(String(res.error ?? 'Gift failed'));
  return res.txid;
};

/** The wallet's current basket id for a name (after a cancel the name is a new output). */
export const opnsIdFor = async (ctx: OneSatContext, name: string): Promise<string | undefined> => {
  const r = await listOpns.execute(ctx, { includeTags: true, limit: 1000 });
  for (const o of r.outputs) {
    if (opnsNameOf(o) !== name || o.tags?.some((t) => t.startsWith('ordlock'))) continue;
    return o.tags?.find((t) => t.startsWith('id:'))?.slice(3) ?? o.outpoint;
  }
  return undefined;
};
