/**
 * Pre-signed payments — signatures (docs/PRESIGNED-PAYMENTS.md §1.1, §1.5).
 *
 * The payer pre-signs a slot input with NONE|ANYONECANPAY (payee unknown) or
 * SINGLE|ANYONECANPAY (payee known: output at the same index is pinned). The
 * service later signs the same input with ALL and the claim unlock is
 * `<sigP> <sigS> OP_TRUE`. Refunds go through the Lock branch: `<Lock unlock> OP_FALSE`.
 */
import { Lock } from '@1sat/templates';
import {
  Hash,
  OP,
  type PrivateKey,
  type PublicKey,
  type Script,
  type Transaction,
  TransactionSignature,
  UnlockingScript,
} from '@bsv/sdk';

export const SIGHASH = {
  ALL: 0x41,
  NONE_ACP: 0xc2,
  SINGLE_ACP: 0xc3,
} as const;
export type PresignScope = typeof SIGHASH.NONE_ACP | typeof SIGHASH.SINGLE_ACP;

export interface SourceOutput {
  satoshis: number;
  lockingScript: Script;
}

function sourceOf(tx: Transaction, inputIndex: number, src?: SourceOutput): SourceOutput & { txid: string } {
  const input = tx.inputs[inputIndex];
  if (!input) throw new Error(`presign: no input ${inputIndex}`);
  const txid = input.sourceTXID ?? input.sourceTransaction?.id('hex');
  if (!txid) throw new Error('presign: input needs sourceTXID or sourceTransaction');
  const out = input.sourceTransaction?.outputs[input.sourceOutputIndex];
  const satoshis = src?.satoshis ?? out?.satoshis;
  const lockingScript = src?.lockingScript ?? out?.lockingScript;
  if (satoshis === undefined || !lockingScript) throw new Error('presign: input source output unknown');
  return { txid, satoshis, lockingScript };
}

/** BIP143/FORKID preimage for one input under `scope`. */
export function preimage(tx: Transaction, inputIndex: number, scope: number, src?: SourceOutput): number[] {
  const s = sourceOf(tx, inputIndex, src);
  const input = tx.inputs[inputIndex];
  return TransactionSignature.format({
    sourceTXID: s.txid,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: s.satoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    outputs: tx.outputs,
    inputIndex,
    subscript: s.lockingScript,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime,
    scope,
  });
}

/** A checksig-format signature (DER + sighash byte) over one input. */
export function signInput(
  key: PrivateKey,
  tx: Transaction,
  inputIndex: number,
  scope: number,
  src?: SourceOutput,
): number[] {
  const raw = key.sign(Hash.sha256(preimage(tx, inputIndex, scope, src)));
  return new TransactionSignature(raw.r, raw.s, scope).toChecksigFormat();
}

/** Payer pre-signature for a claim template. Only the two pre-sign scopes are allowed. */
export function presignClaim(
  P: PrivateKey,
  template: Transaction,
  inputIndex: number,
  scope: PresignScope,
  src?: SourceOutput,
): number[] {
  if (scope !== SIGHASH.NONE_ACP && scope !== SIGHASH.SINGLE_ACP)
    throw new Error('presign: scope must be NONE|ACP or SINGLE|ACP');
  if (scope === SIGHASH.SINGLE_ACP && !template.outputs[inputIndex]) {
    throw new Error('presign: SINGLE needs an output at the same index as the slot input');
  }
  return signInput(P, template, inputIndex, scope, src);
}

/** Does `sig` (checksig format) verify for `pub` on this input of `tx`? */
export function verifyInputSig(
  pub: PublicKey,
  sig: number[],
  tx: Transaction,
  inputIndex: number,
  src?: SourceOutput,
): boolean {
  try {
    const ts = TransactionSignature.fromChecksigFormat(sig);
    return pub.verify(Hash.sha256(preimage(tx, inputIndex, ts.scope, src)), ts);
  } catch {
    return false;
  }
}

export function sigScope(sig: number[]): number {
  return sig[sig.length - 1];
}

export function claimUnlock(sigP: number[], sigS: number[]): UnlockingScript {
  return new UnlockingScript([{ op: sigP.length, data: sigP }, { op: sigS.length, data: sigS }, { op: OP.OP_TRUE }]);
}

/** Service-side unlocking template: adds sigS (ALL) to a stored payer pre-signature. */
export function claimTemplate(sigP: number[], S: PrivateKey, src?: SourceOutput) {
  return {
    sign: async (tx: Transaction, inputIndex: number) =>
      claimUnlock(sigP, signInput(S, tx, inputIndex, SIGHASH.ALL, src)),
    estimateLength: async () => sigP.length + 1 + 73 + 1 + 1,
  };
}

/** Payer-alone refund through the Lock branch. Needs nLockTime ≥ T and a non-final sequence. */
export function refundTemplate(R: PrivateKey, src?: SourceOutput) {
  return {
    sign: async (tx: Transaction, inputIndex: number) => {
      const s = sourceOf(tx, inputIndex, src);
      const inner = await Lock.unlock(R, 'all', false, s.satoshis, s.lockingScript).sign(tx, inputIndex);
      return new UnlockingScript([...inner.chunks, { op: OP.OP_FALSE }]);
    },
    estimateLength: async (tx: Transaction, inputIndex: number) => {
      const s = sourceOf(tx, inputIndex, src);
      // sig + pubkey + preimage (~ 180 + scriptCode) + OP_FALSE
      return 75 + 34 + 5 + 160 + s.lockingScript.toBinary().length + 1;
    },
  };
}
