/**
 * Offer swap (seller) and Accept swap (buyer): the wallet halves of the contract-tied atomic swap (swap.ts).
 *
 * Offer: check the token is indexed, find (or split off, with one token send to ourselves) an output holding
 * exactly the contract amount, then sign ONLY that input with SIGHASH_SINGLE|ANYONECANPAY against "price → me".
 * Nothing is broadcast; the signed half goes back to the room, which relays it to the named buyer only.
 *
 * Accept: verify the offer (swap.ts verifyOffer), check with the indexer that the token is funded and the input
 * is a valid unspent token output, show the approval sheet, then ONE createAction (checked again by
 * verifyAcceptArgs) that the wallet funds, signs and broadcasts now. Save-before-commit: the ref is marked
 * "signing" before createAction and the txid is kept before the room is told, so a spend is never re-sent.
 */
import {
  BSV21_BASKET,
  P1SAT_PROTOCOL,
  bsv21FilterTags,
  buildBsv21CustomInstructions,
  defaultPayAddress,
  ensurePlaintextCi,
  type OneSatContext,
} from '@1sat/actions';
import { Beef, P2PKH, PublicKey, Transaction, Utils, type WalletProtocol } from '@bsv/sdk';
import { assertNotPaused } from '../../config/killSwitch';
import { withBroadcastNow } from '../../../services/bigDelayed';
import { guardedSendBsv21 } from '../../../services/tokenSpendGuard';
import { checkedContext } from '../checkedWallet';
import {
  SwapError,
  assertWithinCaps,
  buildSellerPartial,
  swapOpReturn,
  tokenAmountOf,
  tokenReceiveScript,
  usdToSats,
  validTerms,
  verifyAcceptArgs,
  verifyOffer,
  type AcceptArgs,
  type SwapOffer,
  type SwapTerms,
} from './swap';

const normId = (id: string) => id.trim().toLowerCase().replace('.', '_');
const dotted = (op: string) => normId(op).replace('_', '.');

type Status = { is_active?: boolean; fee_address?: string; fee_per_output?: number };
type TokenInfo = { status?: Status; token?: { sym?: string; dec?: string | number } };
type Bsv21Svc = {
  getTokenDetails(id: string, o?: { fresh?: boolean }): Promise<unknown>;
  getOutputStatus(id: string, outpoints: string[]): Promise<{ outpoint: string; state: string }[]>;
};
type OverlaySvc = { submitBsv21(tx: number[], id: string): Promise<unknown> };
const svc = (ctx: OneSatContext) => {
  const s = ctx.services as unknown as { bsv21?: Bsv21Svc; overlay?: OverlaySvc } | undefined;
  if (!s?.bsv21) throw new SwapError('the token indexer is not reachable');
  return { bsv21: s.bsv21, overlay: s.overlay };
};

/** The token must be funded and validating on the 1Sat indexer, or the buyer's tokens would never index. */
export async function indexedToken(ctx: OneSatContext, tokenId: string): Promise<TokenInfo> {
  const info = (await svc(ctx)
    .bsv21.getTokenDetails(normId(tokenId), { fresh: true })
    .catch(() => null)) as TokenInfo | null;
  if (!info) throw new SwapError('the 1Sat indexer does not know this token');
  if (!info.status?.is_active)
    throw new SwapError('the 1Sat indexer is not validating this token (its indexing fee is unfunded). Fund it first');
  return info;
}

const STATE_TEXT: Record<string, string> = {
  spent: 'the offered tokens have already been spent',
  queued: 'the offered tokens are still waiting to be indexed. Try again in a minute',
  unknown: 'the indexer does not recognise the offered tokens as valid',
};
async function assertValidOutput(ctx: OneSatContext, tokenId: string, outpoint: string) {
  const r = await svc(ctx)
    .bsv21.getOutputStatus(normId(tokenId), [normId(outpoint)])
    .catch(() => null);
  const state = r?.[0]?.state ?? 'unknown';
  if (state !== 'valid') throw new SwapError(STATE_TEXT[state] ?? STATE_TEXT.unknown);
}

type Ci = { protocolID: WalletProtocol; keyID: string; counterparty?: string };
const parseCi = (raw: string | undefined): Ci | null => {
  try {
    const o = JSON.parse(raw ?? '');
    return o?.protocolID && o.keyID ? (o as Ci) : null;
  } catch {
    return null;
  }
};

type Candidate = { outpoint: string; tx: Transaction; vout: number; ci: Ci; beef: Beef };

/** Our own token outputs holding exactly `amount` of the token, with their spend keys. */
async function exactOutputs(ctx: OneSatContext, tokenId: string, amount: bigint): Promise<Candidate[]> {
  const r = await ctx.wallet.listOutputs({
    basket: BSV21_BASKET,
    include: 'entire transactions',
    includeCustomInstructions: true,
    limit: 10000,
  });
  if (!r.BEEF) return [];
  const beef = Beef.fromBinary(Array.from(r.BEEF));
  const out: Candidate[] = [];
  for (const o of r.outputs) {
    const [txid, v] = dotted(o.outpoint).split('.');
    const tx = beef.findTxid(txid)?.tx;
    const vout = Number(v);
    const lock = tx?.outputs[vout]?.lockingScript;
    if (!tx || !lock) continue;
    const tok = tokenAmountOf(lock, `${txid}_${vout}`);
    if (!tok || tok.id !== normId(tokenId) || tok.amount !== amount) continue;
    const ci = parseCi(await ensurePlaintextCi(ctx.wallet, o.customInstructions));
    if (ci) out.push({ outpoint: `${txid}.${vout}`, tx, vout, ci, beef });
  }
  return out;
}

export type SwapSheet = {
  side: 'offer' | 'accept';
  terms: SwapTerms;
  symbol: string;
  /** Whole tokens for display. */
  tokens: string;
  priceSats: number;
  usdAtRate: number;
  rate: number;
  rateSource: string;
  overlayFeeSats: number;
  /** Seller only: a token send to ourselves comes first, to make an output of exactly the amount. */
  split: boolean;
};
export type Ask = (sheet: SwapSheet) => Promise<boolean>;

const display = (raw: string, dec: number) =>
  dec > 0 ? (Number(BigInt(raw)) / 10 ** dec).toLocaleString('en-US', { maximumFractionDigits: dec }) : raw;
const decOf = (info: TokenInfo) => {
  const d = Number(info.token?.dec ?? 0);
  return Number.isInteger(d) && d >= 0 && d <= 18 ? d : 0;
};

export type RateQuote = { rate: number; source: string };

export async function offerSwap(
  ctx: OneSatContext,
  a: { terms: SwapTerms; quote: RateQuote; ask: Ask },
): Promise<SwapOffer> {
  if (!validTerms(a.terms)) throw new SwapError('the contract terms are incomplete');
  const terms = { ...a.terms, tokenId: normId(a.terms.tokenId) };
  const priceSats = usdToSats(terms.priceUsd, a.quote.rate);
  assertWithinCaps(terms.priceUsd, priceSats, a.quote.rate);
  const info = await indexedToken(ctx, terms.tokenId);
  const amount = BigInt(terms.amount);
  let found = (await exactOutputs(ctx, terms.tokenId, amount))[0];
  const ok = await a.ask({
    side: 'offer',
    terms,
    symbol: info.token?.sym ?? '',
    tokens: display(terms.amount, decOf(info)),
    priceSats,
    usdAtRate: (priceSats * a.quote.rate) / 1e8,
    rate: a.quote.rate,
    rateSource: a.quote.source,
    overlayFeeSats: found ? 0 : (info.status?.fee_per_output ?? 0) * 2,
    split: !found,
  });
  if (!ok) throw new SwapError('you declined');
  await assertNotPaused('spending');

  if (!found) {
    // One token send to ourselves: `amount` to a fresh self key, the rest back as change.
    const res = await guardedSendBsv21.execute(ctx, {
      tokenId: terms.tokenId,
      recipients: [{ amount: terms.amount, destination: {} }],
    } as Parameters<typeof guardedSendBsv21.execute>[1]);
    if (!res.txid || res.error)
      throw new SwapError(`could not set aside ${terms.amount} tokens: ${res.error ?? 'not sent'}`);
    found = (await exactOutputs(ctx, terms.tokenId, amount)).find((c) => c.outpoint.startsWith(res.txid!))!;
    if (!found) throw new SwapError('the set-aside tokens are not in the wallet yet. Try again in a moment');
  }

  const payScript = new P2PKH().lock(await defaultPayAddress(ctx));
  const { ci } = found;
  const counterparty = ci.counterparty ?? 'self';
  const partial = await buildSellerPartial({
    sourceTx: found.tx,
    vout: found.vout,
    terms,
    priceSats,
    payScript,
    sign: async (hash) => {
      const { signature } = await ctx.wallet.createSignature({
        protocolID: ci.protocolID,
        keyID: ci.keyID,
        counterparty,
        hashToDirectlySign: hash,
      });
      const { publicKey } = await ctx.wallet.getPublicKey({
        protocolID: ci.protocolID,
        keyID: ci.keyID,
        counterparty,
        forSelf: true,
      });
      return { signature, publicKey };
    },
  });
  return {
    k: 'bwx-swap',
    v: 1,
    terms,
    priceSats,
    rate: a.quote.rate,
    rateSource: a.quote.source,
    partialTx: partial.toHex(),
    tokenBeef: Utils.toHex(found.beef.toBinaryAtomic(found.tx.id('hex'))),
  };
}

/** Local record per contract ref: written BEFORE the spend and again with the txid before the room is told. */
export type SwapRecord = { ref: string; state: 'signing' | 'sent'; txid?: string; beef?: string; at: number };
export type SwapStore = { get(ref: string): Promise<SwapRecord | undefined>; put(r: SwapRecord): Promise<void> };

export async function acceptSwap(
  ctx: OneSatContext,
  a: { offer: SwapOffer; terms: SwapTerms; quote: RateQuote; ask: Ask; store: SwapStore; now?: () => number },
): Promise<{ txid: string; recovered?: boolean }> {
  const now = a.now ?? Date.now;
  const prior = await a.store.get(a.terms.ref);
  if (prior?.state === 'sent' && prior.txid) return { txid: prior.txid, recovered: true };
  if (prior)
    throw new SwapError(
      'this swap was already started on this device and may have been sent. Check your activity before trying again',
    );

  const v = verifyOffer(a.offer, a.terms, a.quote.rate);
  const tokenId = normId(a.terms.tokenId);
  const info = await indexedToken(ctx, tokenId);
  await assertValidOutput(ctx, tokenId, v.outpoint);

  const keyID = `${tokenId}-swap-${a.terms.ref}`;
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: P1SAT_PROTOCOL,
    keyID,
    counterparty: 'self',
    forSelf: true,
  });
  const amount = BigInt(a.terms.amount);
  const receiveScript = tokenReceiveScript(tokenId, amount, PublicKey.fromString(publicKey).toAddress()).toHex();
  const feeAddress = info.status?.fee_address ?? null;
  const feeSats = feeAddress && (info.status?.fee_per_output ?? 0) > 0 ? info.status!.fee_per_output! : 0;

  const ok = await a.ask({
    side: 'accept',
    terms: a.terms,
    symbol: info.token?.sym ?? '',
    tokens: display(a.terms.amount, decOf(info)),
    priceSats: v.priceSats,
    usdAtRate: (v.priceSats * a.quote.rate) / 1e8,
    rate: a.quote.rate,
    rateSource: a.quote.source,
    overlayFeeSats: feeSats,
    split: false,
  });
  if (!ok) throw new SwapError('you declined');

  const outputs = [
    { lockingScript: v.sellerPayScript, satoshis: v.priceSats, outputDescription: 'Swap: price to seller' },
    {
      lockingScript: swapOpReturn(a.terms.ref, a.terms.docHash).toHex(),
      satoshis: 0,
      outputDescription: 'Swap: contract reference',
    },
    {
      lockingScript: receiveScript,
      satoshis: 1,
      outputDescription: 'Swap: tokens to you',
      basket: BSV21_BASKET,
      tags: bsv21FilterTags({ tokenId }),
      customInstructions: buildBsv21CustomInstructions({
        token: { id: tokenId, amt: a.terms.amount, op: 'transfer', sym: info.token?.sym, dec: decOf(info) },
        protocolID: P1SAT_PROTOCOL,
        keyID,
        counterparty: 'self',
      }),
    },
    ...(feeSats && feeAddress
      ? [
          {
            lockingScript: new P2PKH().lock(feeAddress).toHex(),
            satoshis: feeSats,
            outputDescription: 'Overlay processing fee',
            tags: ['fee:overlay'],
          },
        ]
      : []),
  ];
  const checked = checkedContext(ctx, (args) =>
    verifyAcceptArgs(args as AcceptArgs, { v, terms: a.terms, receiveScript, feeAddress, maxOverlayFee: feeSats }),
  );
  // Save before commit: from here on this ref is never spent again from this device.
  await a.store.put({ ref: a.terms.ref, state: 'signing', at: now() });
  const r = await checked.wallet.createAction(
    withBroadcastNow({
      description: `Swap ${a.terms.ref}`.slice(0, 50),
      inputBEEF: v.beef,
      inputs: [{ outpoint: dotted(v.outpoint), unlockingScript: v.unlockingScript, inputDescription: 'Seller tokens' }],
      outputs,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    }),
  );
  if (!r?.txid) throw new SwapError('the wallet did not return a transaction, so nothing was sent');
  const txid = r.txid.toLowerCase();
  await a.store.put({ ref: a.terms.ref, state: 'sent', txid, beef: r.tx ? Utils.toHex(r.tx) : undefined, at: now() });
  if (r.tx)
    await svc(ctx)
      .overlay?.submitBsv21(Array.from(r.tx), tokenId)
      .catch(() => undefined);
  return { txid };
}
