/**
 * Buying a player's listing: a context for buyBsv21 whose createAction is checked (verify.ts verifyPurchaseArgs)
 * against what the buy sheet showed: the exact price to the seller, the token amount to our key, and fees no more
 * than shown. Pass the SAME tokenId and outpoint strings to buyBsv21 (its receive key is derived from them).
 * checkedOrdinalPurchaseContext does the same for buyOrdinal (verifyOrdinalPurchaseArgs).
 *
 * Every Market / Exchange / agent buy goes through one of these: the listing's own script decides what the
 * wallet pays, so without the check the wallet would sign whatever the listing asks, not the price shown.
 */
import { BSV21_BASKET, OPNS_BASKET, ORDINALS_BASKET, P1SAT_PROTOCOL, type OneSatContext } from '@1sat/actions';
import { BSV21 } from '@1sat/templates';
import { P2PKH, PublicKey } from '@bsv/sdk';
import { marketFeeOptions, marketFeeSats } from '../market/fee';
import { checkedContext } from './checkedWallet';
import { verifyOrdinalPurchaseArgs, verifyPurchaseArgs } from './verify';

export type PurchaseShown = {
  tokenId: string;
  outpoint: string;
  amount: bigint;
  priceSats: number;
  /** Indexing fee shown on the sheet (sats). Default: the token's own fee per output (what buyBsv21 adds). */
  maxOverlayFee?: number;
  /** The fee output the sheet showed (e.g. the 5% index-fund fee); default = the general market fee. */
  fee?: { address: string; sats: number; required?: boolean } | null;
};

type Details = { status?: { fee_address?: string; fee_per_output?: number } };

/** The fee output a buy will add for these buyOrdinal / buyBsv21 fee options (ceil(price * rate)), or null. */
export const feeFromOptions = (
  opts: { marketplaceAddress?: string; marketplaceRate?: number },
  priceSats: number,
): { address: string; sats: number } | null =>
  opts.marketplaceAddress && opts.marketplaceRate && opts.marketplaceRate > 0
    ? { address: opts.marketplaceAddress, sats: Math.ceil(priceSats * opts.marketplaceRate) }
    : null;

export async function checkedPurchaseContext<C extends OneSatContext>(ctx: C, shown: PurchaseShown): Promise<C> {
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: P1SAT_PROTOCOL,
    keyID: `${shown.tokenId}-${shown.outpoint}`,
    counterparty: 'self',
    forSelf: true,
  });
  const receiveScript = BSV21.transfer(shown.tokenId, shown.amount)
    .lock(new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()))
    .toHex();
  const bsv21 = (ctx.services as unknown as { bsv21?: { getTokenDetails(id: string): Promise<unknown> } } | undefined)
    ?.bsv21;
  const details = bsv21 ? ((await bsv21.getTokenDetails(shown.tokenId).catch(() => null)) as Details | null) : null;
  const mf = marketFeeOptions();
  return checkedContext(ctx, (args) =>
    verifyPurchaseArgs(args, {
      tokenId: shown.tokenId,
      outpoint: shown.outpoint,
      amount: shown.amount,
      priceSats: shown.priceSats,
      receiveScript,
      basket: BSV21_BASKET,
      marketFee:
        shown.fee !== undefined
          ? shown.fee
          : mf.marketplaceAddress
            ? { address: mf.marketplaceAddress, sats: marketFeeSats(shown.priceSats) }
            : null,
      feeAddress: details?.status?.fee_address ?? null,
      maxOverlayFee: shown.maxOverlayFee ?? overlayFeeOf(details),
    }),
  );
}

const overlayFeeOf = (d: Details | null): number => {
  const f = d?.status?.fee_per_output;
  return typeof f === 'number' && Number.isSafeInteger(f) && f > 0 ? f : 0;
};

export type OrdinalPurchaseShown = {
  outpoint: string;
  priceSats: number;
  /** The fee output the sheet showed; default = the general market fee. */
  fee?: { address: string; sats: number } | null;
};

/** buyOrdinal's context, checked against the sheet. Pass the SAME outpoint string to buyOrdinal. */
export async function checkedOrdinalPurchaseContext<C extends OneSatContext>(
  ctx: C,
  shown: OrdinalPurchaseShown,
): Promise<C> {
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: P1SAT_PROTOCOL,
    keyID: shown.outpoint,
    counterparty: 'self',
    forSelf: true,
  });
  const receiveScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex();
  const marketFee = shown.fee !== undefined ? shown.fee : feeFromOptions(marketFeeOptions(), shown.priceSats);
  return checkedContext(ctx, (args) =>
    verifyOrdinalPurchaseArgs(args, {
      outpoint: shown.outpoint,
      priceSats: shown.priceSats,
      receiveScript,
      baskets: [ORDINALS_BASKET, OPNS_BASKET],
      marketFee,
    }),
  );
}
