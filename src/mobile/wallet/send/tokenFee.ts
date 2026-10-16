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

/** A wallet whose createAction refuses outputs that tokenSendProblem flags (wraps sendBsv21's wallet). */
export const withTokenSendGuard = <W extends object>(
  wallet: W,
  fee: { feeScript: string; maxSats: number } | null,
): W =>
  new Proxy(wallet, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== 'function') return v;
      if (prop !== 'createAction') return (v as (...a: unknown[]) => unknown).bind(target);
      return (args: { outputs?: Out[] }, ...rest: unknown[]) => {
        const problem = tokenSendProblem(args.outputs ?? [], fee);
        if (problem) throw new Error(`${problem} Nothing was sent. Review and try again.`);
        return (v as (...a: unknown[]) => unknown).call(target, args, ...rest);
      };
    },
  });
