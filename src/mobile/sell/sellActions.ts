/**
 * Sell tickets / BSV-21: create and cancel OrdLock listings (wallet side).
 *
 * Create: upstream `sendBsv21` with one recipient whose destination is our listing script
 * (sell.ts buildListingScript). sendBsv21 already does what a listing needs: picks overlay-valid
 * token inputs, returns token change to the wallet, adds the 1sat-stack overlay fee
 * (fee_per_output × token outputs) and submits the tx to the overlay — so the listing is indexed
 * and shows on 1sat.market and in our Market. Broadcast is 0-conf (the wallet's normal path).
 *
 * Cancel: spend the OrdLock with the cancel key (OrdLock.cancelWithWallet) back to a fresh wallet
 * key in the BSV-21 basket, plus the overlay fee for that one token output.
 */
import {
  BSV21_BASKET,
  P1SAT_PROTOCOL,
  buildBsv21CustomInstructions,
  bsv21FilterTags,
  defaultPayAddress,
  executeTrackedAction,
  prepareP1SatArgs,
  sendBsv21,
  type OneSatContext,
} from '@1sat/actions';
import { BSV21, OrdLock, OrdLockV2 } from '@1sat/templates';
import { Beef, P2PKH, PublicKey, Transaction, type CreateActionOutput } from '@bsv/sdk';
import { search } from '../market/indexer';
import {
  addRecord,
  buildListingScript,
  cancelKeyID,
  decodeListing,
  loadRecords,
  removeRecord,
  type ListingRecord,
} from './sell';

const normId = (id: string) => id.replace('.', '_');
const dotted = (outpoint: string) => outpoint.replace('_', '.');

type Details = { status?: { fee_address?: string; fee_per_output?: number; is_active?: boolean } };
const tokenDetails = async (ctx: OneSatContext, tokenId: string): Promise<Details | null> => {
  const c = (ctx.services as unknown as { bsv21?: { getTokenDetails(id: string): Promise<unknown> } } | undefined)
    ?.bsv21;
  if (!c) return null;
  return ((await c.getTokenDetails(normId(tokenId)).catch(() => null)) as Details | null) ?? null;
};

/** The token's overlay fee per output (what the confirm sheet shows), or null if unknown. */
export async function overlayFeePerOutput(ctx: OneSatContext, tokenId: string): Promise<number | null> {
  const fpo = (await tokenDetails(ctx, tokenId))?.status?.fee_per_output;
  return typeof fpo === 'number' && fpo > 0 ? fpo : null;
}

const cancelAddress = async (ctx: OneSatContext, keyID: string) => {
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: P1SAT_PROTOCOL,
    keyID,
    counterparty: 'self',
    forSelf: true,
  });
  return PublicKey.fromString(publicKey).toAddress();
};

/** Which output of the broadcast tx is the listing (sendBsv21 keeps order, so normally 0). */
function listingVout(tx: number[] | undefined, tokenId: string): number {
  if (!tx?.length) return 0;
  let parsed: Transaction | null = null;
  try {
    parsed = Transaction.fromAtomicBEEF(tx);
  } catch {
    try {
      parsed = Transaction.fromBinary(tx);
    } catch {
      return 0;
    }
  }
  const i = parsed.outputs.findIndex((o) => decodeListing(o.lockingScript)?.tokenId === normId(tokenId));
  return i < 0 ? 0 : i;
}

export type CreateListingInput = {
  tokenId: string;
  symbol: string;
  dec: number;
  amount: bigint;
  priceSats: number;
};

export async function createListing(ctx: OneSatContext, input: CreateListingInput): Promise<ListingRecord> {
  const tokenId = normId(input.tokenId);
  const keyID = cancelKeyID(tokenId);
  const [cancel, pay] = await Promise.all([cancelAddress(ctx, keyID), defaultPayAddress(ctx)]);
  const script = buildListingScript(tokenId, input.amount, cancel, pay, input.priceSats);
  const res = await sendBsv21.execute(ctx, {
    tokenId,
    recipients: [{ amount: input.amount.toString(), destination: { lockingScript: script.toHex() } }],
  } as Parameters<typeof sendBsv21.execute>[1]);
  if (!res.txid || res.error) throw new Error(friendly(res.error) ?? 'Listing was not broadcast');
  const record: ListingRecord = {
    outpoint: `${res.txid}.${listingVout(res.tx, tokenId)}`,
    tokenId,
    symbol: input.symbol,
    dec: input.dec,
    amount: input.amount.toString(),
    priceSats: input.priceSats,
    keyID,
    createdAt: Date.now(),
  };
  addRecord(record);
  return record;
}

export async function cancelListing(ctx: OneSatContext, record: ListingRecord): Promise<string> {
  if (!ctx.services) throw new Error('No network services');
  const outpoint = dotted(record.outpoint);
  const [txid, voutStr] = outpoint.split('.');
  const vout = Number(voutStr);
  const beef: Beef = await ctx.services.getBeefForTxid(txid);
  const listingTx = beef.findTxid(txid)?.tx;
  if (!listingTx) throw new Error('Listing transaction not found');
  const decoded = decodeListing(listingTx.outputs[vout].lockingScript);
  if (!decoded) throw new Error('That output is not a token listing');

  const tokenId = decoded.tokenId;
  const amount = decoded.amount;
  const backKeyID = `${tokenId}-${Date.now()}`;
  const back = await cancelAddress(ctx, backKeyID);
  const details = await tokenDetails(ctx, tokenId);
  const outputs: CreateActionOutput[] = [
    {
      lockingScript: BSV21.transfer(tokenId, amount).lock(new P2PKH().lock(back)).toHex(),
      satoshis: 1,
      outputDescription: 'Cancelled listing (tokens back)',
      basket: BSV21_BASKET,
      tags: bsv21FilterTags({ tokenId }),
      customInstructions: buildBsv21CustomInstructions({
        token: { id: tokenId, amt: amount.toString(), op: 'transfer', sym: record.symbol, dec: record.dec },
        protocolID: P1SAT_PROTOCOL,
        keyID: backKeyID,
        counterparty: 'self',
      }),
    },
  ];
  const fee = details?.status;
  if (fee?.fee_address && typeof fee.fee_per_output === 'number' && fee.fee_per_output > 0) {
    outputs.push({
      lockingScript: new P2PKH().lock(fee.fee_address).toHex(),
      satoshis: fee.fee_per_output,
      outputDescription: 'Overlay processing fee',
      tags: ['fee:overlay'],
    });
  }
  const inputBEEF = beef.toBinary();
  const args = await prepareP1SatArgs(ctx, {
    description: `Cancel ${record.symbol ? `$${record.symbol} ` : ''}listing`.slice(0, 50),
    inputBEEF,
    inputs: [{ outpoint, inputDescription: 'Listed tokens', unlockingScriptLength: decoded.v2 ? 120 : 108 }],
    outputs,
    options: { randomizeOutputs: false },
  });
  const res = await executeTrackedAction(
    ctx.wallet,
    args,
    undefined,
    inputBEEF,
    async (tx: Transaction) => {
      const idx = tx.inputs.findIndex(
        (i) => (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === txid && i.sourceOutputIndex === vout,
      );
      if (idx < 0) throw new Error('Listing input missing from the transaction');
      if (!tx.inputs[idx].sourceTransaction) tx.inputs[idx].sourceTransaction = listingTx;
      const unlocker = decoded.v2
        ? OrdLockV2.cancelWithWallet(ctx.wallet, P1SAT_PROTOCOL, record.keyID, 'self')
        : OrdLock.cancelWithWallet(ctx.wallet, P1SAT_PROTOCOL, record.keyID, 'self');
      const unlock = await unlocker.sign(tx, idx);
      return { [idx]: { unlockingScript: unlock.toHex() } };
    },
    { spends: [{ outpoint, scheme: 'bsv21' }], permissionScheme: 'bsv21' } as Parameters<
      typeof executeTrackedAction
    >[5],
  );
  if ('error' in res && res.error) throw new Error(String(res.error));
  if (!res.txid) throw new Error('Cancel was not broadcast');
  const overlay = (ctx.services as unknown as { overlay?: { submitBsv21(tx: number[], id: string): Promise<unknown> } })
    .overlay;
  if (res.tx && overlay) await overlay.submitBsv21(res.tx, tokenId).catch(() => undefined);
  removeRecord(record.outpoint);
  return res.txid;
}

export type ListingStatus = 'live' | 'indexing' | 'gone';
export type MyListing = ListingRecord & { status: ListingStatus };

/** Grace period after creation before a listing missing from the index counts as gone (sold/cancelled). */
const INDEX_GRACE_MS = 10 * 60_000;

/** Our recorded listings with their market status (unspent OrdLock in the 1Sat index = live). */
export async function myListings(records = loadRecords(), now = Date.now()): Promise<MyListing[]> {
  const ids = [...new Set(records.map((r) => r.tokenId))];
  const live = new Set<string>();
  let searched = true;
  await Promise.all(
    ids.map(async (id) => {
      try {
        const rows = await search({
          key: [`bsv21:${id}`, 'ordlock'],
          join: 'intersect',
          unspent: 'true',
          rev: 'true',
          limit: '200',
          tags: 'bsv21,ordlock',
        });
        for (const r of rows) live.add(normId(r.outpoint));
      } catch {
        searched = false;
      }
    }),
  );
  return records.map((r) => ({
    ...r,
    status: live.has(normId(r.outpoint))
      ? 'live'
      : !searched || now - r.createdAt < INDEX_GRACE_MS
        ? 'indexing'
        : 'gone',
  }));
}

const ERRORS: Record<string, string> = {
  'token-not-active': 'This token is not indexed yet (its indexing is unfunded). Finish setting it up first.',
  'insufficient-valid-tokens': "You don't hold that many indexed tokens yet. Wait for your last transfer to index.",
  'insufficient-tokens': "You don't hold that many tokens.",
  'token-not-found': 'The indexer does not know this token yet.',
  'overlay-validation-failed': 'Could not reach the token indexer. Try again.',
};
const friendly = (e: string | undefined) => (e ? (ERRORS[e] ?? e) : undefined);
