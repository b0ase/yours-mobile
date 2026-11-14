import { P2PKH } from '@bsv/sdk';
import { deriveFeeAddress } from '../../tokens/indexFund';

/**
 * BSV-21 send safety (15 Oct 2026 audit). sendBsv21 (@1sat/actions) adds one extra output besides the 1-sat token
 * transfers: an "Overlay processing fee" P2PKH paying `fee_per_output × token outputs` sats to the indexer's
 * `fee_address`, both read from the indexer at send time. The confirm sheet must show it, and the send must not
 * pay more (or anyone else) than the user confirmed. Pure.
 */

export type OverlayFee = { address: string; sats: number };

/**
 * The most the indexer fee can be for this send: one charge per recipient output plus one for token change.
 * null when the indexer charges nothing (no address or no per-output fee).
 */
export const maxOverlayFee = (
  feeAddress: string | undefined,
  feePerOutput: number | undefined,
  recipientOutputs: number,
): OverlayFee | null =>
  feeAddress && typeof feePerOutput === 'number' && feePerOutput > 0 && recipientOutputs > 0
    ? { address: feeAddress, sats: feePerOutput * (recipientOutputs + 1) }
    : null;

/**
 * Most any token path pays the indexer per token output when no sheet confirmed the fee (b-Aware 28 Oct 2026,
 * hilmiadi677 H-5). `fee_per_output` comes from the indexer at spend time; the default is 1,000 sats.
 */
export const MAX_OVERLAY_FEE_PER_OUTPUT = 10_000;
export const OVERLAY_FEE_REFUSAL = "The token indexer's fee looks wrong, so nothing was sent.";

export const OVERLAY_FEE_ADDRESS_REFUSAL =
  "The token indexer asked to be paid at an address that isn't this token's fee address, so nothing was sent.";

/** The locking script of `tokenId`'s own fee address (deriveFeeAddress), or null for a malformed id. */
export const feeScriptFor = (tokenId: string): string | null => {
  const a = deriveFeeAddress(tokenId);
  return a ? new P2PKH().lock(a).toHex() : null;
};

/**
 * The indexer's served fee_address for `tokenId`, only if it is the token's own (deriveFeeAddress); null when none was
 * served (no fee). Throws OVERLAY_FEE_ADDRESS_REFUSAL for any other address, so a caller refuses before signing
 * (purchases, swaps; review of b-Aware row 123).
 */
export const checkedServedFeeAddress = (tokenId: string, served: unknown): string | null => {
  if (typeof served !== 'string' || !served) return null;
  if (served !== deriveFeeAddress(tokenId)) throw new Error(OVERLAY_FEE_ADDRESS_REFUSAL);
  return served;
};

/** What upstream sendBsv21 (and our own fee outputs) call the indexer's fee output. */
export const OVERLAY_FEE_DESCRIPTION = 'Overlay processing fee';
const isOverlayFeeOutput = (o: { outputDescription?: string; tags?: string[] }) =>
  o.outputDescription === OVERLAY_FEE_DESCRIPTION || !!o.tags?.includes('fee:overlay');

/**
 * Why a token spend's overlay fee outputs pay somewhere other than `tokenId`'s own fee address, or more than
 * MAX_OVERLAY_FEE_PER_OUTPUT per token output (1-sat outputs), or null when they don't (none at all is fine). The
 * indexer serves fee_address and fee_per_output at spend time; this is checked on every sendBsv21
 * (guardedSendBsv21). Review of row 123.
 */
export const overlayFeeAddressProblem = (
  tokenId: string,
  outputs: readonly { lockingScript: string; satoshis: number; outputDescription?: string; tags?: string[] }[],
): string | null => {
  const fees = outputs.filter(isOverlayFeeOutput);
  if (!fees.length) return null;
  const want = feeScriptFor(tokenId);
  if (!want || fees.some((o) => o.lockingScript !== want)) return OVERLAY_FEE_ADDRESS_REFUSAL;
  const tokenOuts = outputs.filter((o) => o.satoshis === 1).length;
  const paid = fees.reduce((n, o) => n + o.satoshis, 0);
  return paid > MAX_OVERLAY_FEE_PER_OUTPUT * Math.max(1, tokenOuts) ? OVERLAY_FEE_REFUSAL : null;
};

/** A wallet whose createAction refuses an overlay fee output that doesn't pay `tokenId`'s own fee address. */
export const withOverlayFeeAddressCheck = <W extends object>(wallet: W, tokenId: string): W =>
  new Proxy(wallet, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== 'function') return v;
      if (prop !== 'createAction') return (v as (...a: unknown[]) => unknown).bind(target);
      return (args: { outputs?: { lockingScript: string; satoshis: number }[] }, ...rest: unknown[]) => {
        const problem = overlayFeeAddressProblem(tokenId, args.outputs ?? []);
        if (problem) throw new Error(problem);
        return (v as (...a: unknown[]) => unknown).call(target, args, ...rest);
      };
    },
  });

/**
 * The overlay fee output for `tokenOuts` token outputs of `tokenId`, or null when the token charges nothing. Throws
 * when the indexer's per-output fee is not a whole number or is above MAX_OVERLAY_FEE_PER_OUTPUT, or when its
 * `fee_address` is not the address this token's id leads to (deriveFeeAddress, the indexer's own derivation): the
 * address is read from the indexer at spend time and paid in a signed output no sheet shows (b-Aware 25 Oct 2026,
 * fzsusanto row 123; the cap alone was 17c4eee5). Use on every token spend that builds its own fee output (unlock,
 * room messages, invites, cancels). Pure.
 */
export const cappedOverlayFee = (
  tokenId: string,
  feeAddress: unknown,
  feePerOutput: unknown,
  tokenOuts: number,
): OverlayFee | null => {
  if (typeof feeAddress !== 'string' || !feeAddress || typeof feePerOutput !== 'number' || !(feePerOutput > 0))
    return null;
  if (!Number.isSafeInteger(feePerOutput) || feePerOutput > MAX_OVERLAY_FEE_PER_OUTPUT)
    throw new Error(OVERLAY_FEE_REFUSAL);
  const derived = deriveFeeAddress(tokenId);
  if (!derived || feeAddress !== derived) throw new Error(OVERLAY_FEE_ADDRESS_REFUSAL);
  return { address: derived, sats: feePerOutput * tokenOuts };
};

type Out = { lockingScript: string; satoshis: number };

/**
 * Why a token send's outputs differ from what the user confirmed, or null when they match: every output is a
 * 1-sat token output (transfer / change) or a 0-sat data output (note), except at most the confirmed fee output,
 * paid to exactly `feeScript` and no more than `maxSats`.
 */
export const tokenSendProblem = (outputs: readonly Out[], fee: { feeScript: string; maxSats: number } | null) => {
  let feeSeen = false;
  for (const o of outputs) {
    if (o.satoshis <= 1) continue;
    if (!fee || feeSeen || o.lockingScript !== fee.feeScript) return 'This send pays someone you did not confirm.';
    if (o.satoshis > fee.maxSats) return "The indexer's fee went up since you confirmed.";
    feeSeen = true;
  }
  return null;
};

/**
 * A wallet whose createAction refuses outputs that tokenSendProblem flags (wraps sendBsv21's wallet). The confirmed
 * fee must pay `tokenId`'s own fee address (feeScriptFor), whatever the indexer served (review of row 123).
 */
export const withTokenSendGuard = <W extends object>(
  wallet: W,
  fee: { feeScript: string; maxSats: number } | null,
  tokenId: string,
): W =>
  new Proxy(wallet, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== 'function') return v;
      if (prop !== 'createAction') return (v as (...a: unknown[]) => unknown).bind(target);
      return (args: { outputs?: Out[] }, ...rest: unknown[]) => {
        const problem =
          fee && fee.feeScript !== feeScriptFor(tokenId)
            ? OVERLAY_FEE_ADDRESS_REFUSAL.replace(', so nothing was sent.', '.')
            : tokenSendProblem(args.outputs ?? [], fee);
        if (problem) throw new Error(`${problem} Nothing was sent. Review and try again.`);
        return (v as (...a: unknown[]) => unknown).call(target, args, ...rest);
      };
    },
  });
