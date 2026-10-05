/**
 * The one "mint media" routine, shared by the Mint screen (MintButton.tsx) and paired-CLI minting
 * (pair/agentPairing.ts, scope "mint"). Same transactions either way:
 *   inscribe (no collection) · mintCollection + mintCollectionItem (new) · mintCollectionItem (existing),
 * the 1% bWallet mint fee output on the item tx (withFeeOutput), the issuer signature in the same tx
 * (withIssuerSignature) and registration with bit-sign after broadcast (registerIssuer).
 */
import { inscribe, mintCollection, mintCollectionItem, type OneSatContext } from '@1sat/actions';
import { Transaction, type CreateActionArgs, type WalletInterface } from '@bsv/sdk';
import { withIssuerSignature } from '../issuer/issuerSign';
import { registerIssuer } from '../issuer/issuerVerify';
import { buildMap, collectionIdFrom, MINT_APP, withFeeOutput, type Collection } from './mint';

export type MintMediaInput = {
  base64Content: string;
  contentType: string;
  title: string;
  description: string;
  collection: Collection;
  /** The 1% mint fee in sats (estimateCost().feeSats); 0 = no fee output. */
  feeSats: number;
};
export type MintMediaResult = {
  txid: string;
  /** The new item's outpoint; a fresh inscription's origin is the same outpoint. */
  outpoint: string;
  origin: string;
  collectionId?: string;
  /** Network fees of every tx this mint created, where the wallet returned the tx (else null). */
  networkSats: number | null;
};

/**
 * Wraps ctx so every createAction's network fee is added up (from the returned atomic BEEF).
 * `total()` is null when any tx couldn't be measured.
 */
export function meterFees(ctx: OneSatContext): { ctx: OneSatContext; total: () => number | null } {
  let sum = 0;
  let unknown = false;
  const wallet = new Proxy(ctx.wallet as WalletInterface, {
    get(target, prop, receiver) {
      if (prop === 'createAction') {
        return async (args: CreateActionArgs, originator?: string) => {
          const r = await target.createAction(args, originator);
          try {
            if (!r.tx) throw new Error('no tx');
            sum += Transaction.fromAtomicBEEF(r.tx).getFee();
          } catch {
            unknown = true;
          }
          return r;
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ctx: { ...ctx, wallet } as OneSatContext, total: () => (unknown ? null : sum) };
}

export async function mintMedia(apiContext: OneSatContext, m: MintMediaInput): Promise<MintMediaResult> {
  const meter = meterFees(apiContext);
  const base = meter.ctx;
  const { base64Content, contentType, collection, feeSats } = m;
  const name = m.title.trim();
  const description = m.description.trim();
  let signedAt: number | null = null;
  const signed = (ctx: OneSatContext) =>
    withIssuerSignature(ctx, 'ordinal', (r) => {
      signedAt = r.index;
    });
  const register = (txid?: string) => {
    if (txid && signedAt !== null) void registerIssuer(`${txid}_${signedAt}`);
    signedAt = null;
  };
  let res: { txid?: string; error?: string };
  let collectionId: string | undefined;
  if (collection.kind === 'none') {
    res = await inscribe.execute(signed(withFeeOutput(base, feeSats)), {
      base64Content,
      contentType,
      map: buildMap({ title: name, description, collection }),
    });
  } else {
    collectionId = collection.kind === 'existing' ? collection.id : '';
    if (collection.kind === 'new') {
      const c = await mintCollection.execute(signed(base), {
        base64Content,
        contentType,
        name: collection.name.trim(),
        description,
        quantity: 1000,
        app: MINT_APP,
      });
      if (!c.txid || c.error) throw new Error(c.error || 'Collection mint failed');
      register(c.txid);
      collectionId = collectionIdFrom(c.txid, c.collectionId);
    }
    res = await mintCollectionItem.execute(signed(withFeeOutput(base, feeSats)), {
      base64Content,
      contentType,
      name,
      collectionId,
      app: MINT_APP,
    });
  }
  if (!res.txid || res.error) throw new Error(res.error || 'Mint failed');
  register(res.txid);
  // Output 0 is the inscription (withFeeOutput and the issuer signature append after it).
  const outpoint = `${res.txid}_0`;
  return {
    txid: res.txid,
    outpoint,
    origin: outpoint,
    ...(collectionId && { collectionId }),
    networkSats: meter.total(),
  };
}
