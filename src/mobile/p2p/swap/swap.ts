/**
 * Contract-tied atomic swap: N BSV-21 tokens for a BSV price, in ONE transaction (owner "money-ok atomic swap",
 * 27 Oct 2026). Pure: everything here is unit-tested in swap.test.ts with forged partial transactions.
 *
 * Shape of the final transaction:
 *   in  0  seller's token output (exactly the contract amount)   signed by the seller, SIGHASH_SINGLE|ANYONECANPAY|FORKID
 *   in  1… buyer's BSV funding inputs                            signed by the buyer, SIGHASH_ALL|FORKID (the wallet)
 *   out 0  price → seller (P2PKH)                                committed by the seller's signature (SINGLE ↔ in 0)
 *   out 1  OP_FALSE OP_RETURN "bwx-swap" <ref> <docHash>         committed by the buyer's signature (ALL)
 *   out 2  BSV-21 transfer of the amount → buyer's own key       committed by the buyer's signature
 *   out 3  token overlay (indexer) fee, when the token has one
 *   out 4… buyer's BSV change (added by the wallet)
 *
 * The seller's half (the "partial transaction") is in 0 + out 0 + out 1. Because of SINGLE|ANYONECANPAY the
 * seller's signature only covers in 0 and out 0: nobody can take the tokens without paying out 0 in the same
 * transaction, and nothing moves until the buyer broadcasts. Out 1 rides along in the partial transaction so the
 * buyer sees and checks the reference before signing; the buyer's own SIGHASH_ALL signature then fixes it on chain.
 */
import { BSV21 } from '@1sat/templates';
import {
  Beef,
  Hash,
  LockingScript,
  OP,
  P2PKH,
  Script,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
} from '@bsv/sdk';

/** Hard caps for the first version (owner, 27 Oct 2026). Raise here; tests read the same object. */
export const SWAP_CAPS = Object.freeze({ maxUsd: 10 });

export const SWAP_PROTOCOL = 'bwx-swap';
export const SWAP_SIGHASH =
  TransactionSignature.SIGHASH_SINGLE | TransactionSignature.SIGHASH_ANYONECANPAY | TransactionSignature.SIGHASH_FORKID;

export class SwapError extends Error {
  constructor(reason: string) {
    super(`Swap stopped before signing: ${reason}`);
    this.name = 'SwapError';
  }
}
const fail = (reason: string): never => {
  throw new SwapError(reason);
};

/** What the contract says. Both wallets are given these by the room and both check them. */
export type SwapTerms = {
  /** Contract reference (document id in the room). */
  ref: string;
  /** sha256 hex of the completed (signed) document. */
  docHash: string;
  /** BSV-21 token id, txid_vout. */
  tokenId: string;
  /** Token amount in base units (after decimals), decimal string. */
  amount: string;
  /** Price in USD the contract names (e.g. 1). */
  priceUsd: number;
};

/** The seller's half, as relayed privately to the buyer. */
export type SwapOffer = {
  k: typeof SWAP_PROTOCOL;
  v: 1;
  terms: SwapTerms;
  /** Price in sats, fixed by the seller at its rate. */
  priceSats: number;
  /** USD per BSV the seller used, and where it came from. */
  rate: number;
  rateSource: string;
  /** Raw partial transaction hex: 1 signed input, 2 outputs. */
  partialTx: string;
  /** BEEF hex holding the token output's source transaction (and its ancestry). */
  tokenBeef: string;
};

const HEX64 = /^[0-9a-f]{64}$/;
const normId = (id: string) => id.trim().toLowerCase().replace('.', '_');

export const validTerms = (t: unknown): t is SwapTerms => {
  const o = t as Record<string, unknown>;
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.ref === 'string' &&
    /^[\w.:-]{1,100}$/.test(o.ref) &&
    typeof o.docHash === 'string' &&
    HEX64.test(o.docHash) &&
    typeof o.tokenId === 'string' &&
    /^[0-9a-f]{64}[_.]\d+$/.test(o.tokenId.toLowerCase()) &&
    typeof o.amount === 'string' &&
    /^[1-9]\d{0,30}$/.test(o.amount) &&
    typeof o.priceUsd === 'number' &&
    Number.isFinite(o.priceUsd) &&
    o.priceUsd > 0
  );
};

/** Refuses prices over the cap, by the contract and by the sats at the given rate. */
export const assertWithinCaps = (priceUsd: number, priceSats: number, rate: number) => {
  if (!(priceUsd > 0) || priceUsd > SWAP_CAPS.maxUsd) fail(`price $${priceUsd} is over the $${SWAP_CAPS.maxUsd} cap`);
  if (!Number.isSafeInteger(priceSats) || priceSats <= 0) fail('no price in sats');
  if (!(rate > 0)) fail('no BSV/USD rate');
  const usd = (priceSats * rate) / 1e8;
  if (usd > SWAP_CAPS.maxUsd) fail(`price ${priceSats} sats ($${usd.toFixed(2)}) is over the $${SWAP_CAPS.maxUsd} cap`);
};

export const usdToSats = (usd: number, rate: number) => Math.ceil((usd / rate) * 1e8);

/** OP_FALSE OP_RETURN "bwx-swap" <ref> <docHash bytes>. */
export const swapOpReturn = (ref: string, docHash: string): LockingScript =>
  new LockingScript([
    { op: OP.OP_FALSE },
    { op: OP.OP_RETURN },
    ...[Utils.toArray(SWAP_PROTOCOL, 'utf8'), Utils.toArray(ref, 'utf8'), Utils.toArray(docHash, 'hex')].map((d) => ({
      op: d.length,
      data: d,
    })),
  ]);

/** The BSV-21 amount an output carries for `tokenId`, or null. Handles deploy+mint (id = its own outpoint). */
export const tokenAmountOf = (script: Script, outpoint: string): { id: string; amount: bigint } | null => {
  try {
    const t = BSV21.decode(script);
    if (!t) return null;
    const op = t.getOperation();
    const id = op === 'deploy+mint' ? normId(outpoint) : op === 'transfer' ? normId(t.getTokenId() ?? '') : '';
    if (!id) return null;
    return { id, amount: t.getAmount() };
  } catch {
    return null;
  }
};

export type SellerSigner = (sighash: number[]) => Promise<{ signature: number[]; publicKey: string }>;

/**
 * Build and sign the seller's half. `sourceTx` holds the token output at `vout`; `payScript` is the seller's
 * receive script (P2PKH). The token output must hold exactly the contract amount.
 */
export async function buildSellerPartial(a: {
  sourceTx: Transaction;
  vout: number;
  terms: SwapTerms;
  priceSats: number;
  payScript: LockingScript;
  sign: SellerSigner;
}): Promise<Transaction> {
  const src = a.sourceTx.outputs[a.vout];
  if (!src) fail('token output not found');
  const tok = tokenAmountOf(src.lockingScript, `${a.sourceTx.id('hex')}_${a.vout}`);
  if (!tok || tok.id !== normId(a.terms.tokenId)) fail('that output is not the contract token');
  if (tok!.amount !== BigInt(a.terms.amount)) fail(`that output holds ${tok!.amount}, not ${a.terms.amount}`);
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: a.sourceTx, sourceOutputIndex: a.vout, sequence: 0xffffffff });
  tx.addOutput({ lockingScript: a.payScript, satoshis: a.priceSats });
  tx.addOutput({ lockingScript: swapOpReturn(a.terms.ref, a.terms.docHash), satoshis: 0 });
  const preimage = sellerPreimage(tx);
  const { signature, publicKey } = await a.sign(hash256(preimage));
  tx.inputs[0].unlockingScript = new UnlockingScript()
    .writeBin([...signature, SWAP_SIGHASH])
    .writeBin(Utils.toArray(publicKey, 'hex')) as UnlockingScript;
  return tx;
}

const hash256 = (b: number[]) => Hash.sha256(Hash.sha256(b));

export function sellerPreimage(tx: Transaction): number[] {
  const inp = tx.inputs[0];
  const sourceTx = inp.sourceTransaction;
  if (!sourceTx) fail('token source missing');
  const out = sourceTx!.outputs[inp.sourceOutputIndex];
  return TransactionSignature.format({
    sourceTXID: sourceTx!.id('hex'),
    sourceOutputIndex: inp.sourceOutputIndex,
    sourceSatoshis: out.satoshis ?? 1,
    transactionVersion: tx.version,
    otherInputs: [],
    inputIndex: 0,
    outputs: tx.outputs,
    inputSequence: inp.sequence ?? 0xffffffff,
    subscript: out.lockingScript,
    lockTime: tx.lockTime,
    scope: SWAP_SIGHASH,
  });
}

export type VerifiedOffer = {
  partial: Transaction;
  sourceTx: Transaction;
  outpoint: string;
  sellerPayScript: string;
  priceSats: number;
  unlockingScript: string;
  beef: number[];
};

/**
 * The buyer's checks on the seller's half, before anything is signed:
 * - the offer is for exactly the terms the buyer signed (ref, document hash, token, amount, USD price);
 * - one input: a token output (from the BEEF) holding exactly that amount of that token;
 * - its signature is valid under SIGHASH_SINGLE|ANYONECANPAY and the script really unlocks it;
 * - exactly two outputs: out 0 pays the price to a P2PKH, out 1 is the swap OP_RETURN with the signed hash;
 * - the price is within the cap at the buyer's own rate.
 */
export function verifyOffer(offer: SwapOffer, expected: SwapTerms, buyerRate: number): VerifiedOffer {
  if (offer?.k !== SWAP_PROTOCOL || offer.v !== 1) fail('not a swap offer');
  if (!validTerms(offer.terms) || !validTerms(expected)) fail('malformed terms');
  const t = offer.terms;
  if (t.ref !== expected.ref) fail('the offer is for a different contract');
  if (t.docHash.toLowerCase() !== expected.docHash.toLowerCase())
    fail('the document hash does not match the contract you signed');
  if (normId(t.tokenId) !== normId(expected.tokenId)) fail('the offer is a different token');
  if (t.amount !== expected.amount) fail(`the offer is ${t.amount} tokens, the contract says ${expected.amount}`);
  if (t.priceUsd !== expected.priceUsd) fail(`the offer asks $${t.priceUsd}, the contract says $${expected.priceUsd}`);
  assertWithinCaps(expected.priceUsd, offer.priceSats, buyerRate);
  // The seller's sats must be about the contract's dollars at the buyer's rate too (10% slack for price moves).
  const buyerUsd = (offer.priceSats * buyerRate) / 1e8;
  if (buyerUsd > expected.priceUsd * 1.1)
    fail(`the price is $${buyerUsd.toFixed(2)} at today's rate, not $${expected.priceUsd}`);

  let partial: Transaction;
  let beef: Beef;
  try {
    partial = Transaction.fromHex(offer.partialTx);
    beef = Beef.fromString(offer.tokenBeef, 'hex');
  } catch {
    return fail('the offer could not be read');
  }
  if (partial.inputs.length !== 1) fail('the offer must spend exactly one output');
  if (partial.outputs.length !== 2) fail('the offer has extra or missing outputs');
  const inp = partial.inputs[0];
  const srcTxid = inp.sourceTXID ?? '';
  const sourceTx = beef.findTxid(srcTxid)?.tx;
  if (!sourceTx) fail('the token transaction is missing from the offer');
  const src = sourceTx!.outputs[inp.sourceOutputIndex];
  if (!src) fail('the token output is missing');
  const outpoint = `${srcTxid}_${inp.sourceOutputIndex}`;
  const tok = tokenAmountOf(src.lockingScript, outpoint);
  if (!tok || tok.id !== normId(expected.tokenId)) fail('the input is not the contract token');
  if (tok!.amount !== BigInt(expected.amount)) fail(`the input holds ${tok!.amount}, not ${expected.amount}`);

  const [pay, ret] = partial.outputs;
  if (pay.satoshis !== offer.priceSats) fail('the seller output is not the agreed price');
  const payHex = pay.lockingScript.toHex();
  if (!isP2PKH(payHex)) fail('the price does not go to a plain address');
  if (ret.satoshis !== 0 || ret.lockingScript.toHex() !== swapOpReturn(expected.ref, expected.docHash).toHex())
    fail('the contract reference on chain does not match the document you signed');

  const unlock = inp.unlockingScript;
  const chunks = unlock?.chunks ?? [];
  const sig = chunks[0]?.data;
  if (chunks.length !== 2 || !sig || sig[sig.length - 1] !== SWAP_SIGHASH)
    fail('the seller signature is not a swap signature');
  try {
    const ok = new Spend({
      sourceTXID: srcTxid,
      sourceOutputIndex: inp.sourceOutputIndex,
      sourceSatoshis: src.satoshis ?? 1,
      lockingScript: src.lockingScript,
      transactionVersion: partial.version,
      otherInputs: [],
      outputs: partial.outputs,
      inputIndex: 0,
      unlockingScript: unlock!,
      inputSequence: inp.sequence ?? 0xffffffff,
      lockTime: partial.lockTime,
    }).validate();
    if (!ok) fail('the seller signature does not unlock the tokens');
  } catch (e) {
    if (e instanceof SwapError) throw e;
    fail('the seller signature does not unlock the tokens');
  }
  return {
    partial,
    sourceTx: sourceTx!,
    outpoint,
    sellerPayScript: payHex,
    priceSats: offer.priceSats,
    unlockingScript: unlock!.toHex(),
    beef: beef.toBinary(),
  };
}

const isP2PKH = (hex: string) => /^76a914[0-9a-f]{40}88ac$/.test(hex);

export const tokenReceiveScript = (tokenId: string, amount: bigint, address: string) =>
  BSV21.transfer(normId(tokenId), amount).lock(new P2PKH().lock(address));

export type AcceptOutput = {
  lockingScript: string;
  satoshis: number;
  outputDescription: string;
  basket?: string;
  tags?: string[];
  customInstructions?: string;
};
export type AcceptArgs = {
  inputs?: readonly { outpoint: string; unlockingScript?: string }[];
  outputs?: readonly AcceptOutput[];
};

/**
 * The last check on the buyer's createAction args (the wallet adds only BSV funding + change after this):
 * one input, the seller's token output with the seller's own unlocking script; outputs in order: price to the
 * seller, the swap OP_RETURN, the tokens to the buyer's key, then at most the overlay fee. Nothing else may take
 * the buyer's money.
 */
export function verifyAcceptArgs(
  args: AcceptArgs,
  e: { v: VerifiedOffer; terms: SwapTerms; receiveScript: string; feeAddress: string | null; maxOverlayFee: number },
): void {
  const ins = args.inputs ?? [];
  if (ins.length !== 1) fail('the swap must spend only the seller’s tokens (the wallet adds your BSV)');
  if (normId(ins[0].outpoint) !== normId(e.v.outpoint)) fail('the swap spends something other than the offered tokens');
  if (ins[0].unlockingScript !== e.v.unlockingScript) fail('the seller signature was changed');
  const outs = args.outputs ?? [];
  if (outs.length < 3 || outs.length > 4) fail('unexpected outputs');
  if (outs[0].lockingScript !== e.v.sellerPayScript || outs[0].satoshis !== e.v.priceSats)
    fail('output 0 must pay the seller exactly the price');
  if (outs[1].lockingScript !== swapOpReturn(e.terms.ref, e.terms.docHash).toHex() || outs[1].satoshis !== 0)
    fail('output 1 must be the contract reference');
  if (outs[2].lockingScript !== e.receiveScript || outs[2].satoshis !== 1) fail('the tokens are not coming to you');
  if (outs[3]) {
    if (!e.feeAddress || outs[3].lockingScript !== new P2PKH().lock(e.feeAddress).toHex())
      fail('an output pays someone unexpected');
    if (outs[3].satoshis > e.maxOverlayFee) fail('indexing fee is more than shown');
  }
}
