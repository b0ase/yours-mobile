/**
 * Pre-signed payments — transaction builders (docs/PRESIGNED-PAYMENTS.md §1.4, §8.2).
 *
 *   creation: funding (+ token) inputs → N slots + token change + BSV change
 *   claim:    slot input (payer pre-sig) → recipient output; service adds fee input + change
 *   refund:   slot input via the Lock branch, nLockTime = T → back to the payer
 */
import {
  LockingScript,
  P2PKH,
  type PrivateKey,
  SatoshisPerKilobyte,
  type Script,
  Transaction,
  type TransactionInput,
} from '@bsv/sdk';
import { type Bsv21Transfer, type SlotParams, slotLockingScript, withTransfer } from './script';
import { type PresignScope, claimTemplate, presignClaim, refundTemplate } from './sign';

type UnlockingScriptTemplate = NonNullable<TransactionInput['unlockingScriptTemplate']>;

export const FINAL = 0xffffffff;
export const NON_FINAL = 0xfffffffe;
/** 1 sat/byte = 1000 sat/kB is far above today's floor; callers may pass less. */
export const DEFAULT_FEE_SAT_PER_KB = 100;

export interface SpendableInput {
  sourceTransaction: Transaction;
  sourceOutputIndex: number;
  unlock: UnlockingScriptTemplate;
  /** token carried by this input, if any (used for the no-burn check) */
  token?: Bsv21Transfer;
}

export interface SlotSpec extends SlotParams {
  /** sats in the slot; token slots should hold 1 */
  satoshis: number;
}

export interface CreationArgs {
  inputs: SpendableInput[];
  slots: SlotSpec[];
  /** where token change and BSV change go (payer) */
  changeAddress: string;
  feeSatPerKb?: number;
}

export interface Creation {
  tx: Transaction;
  /** output index of slot i */
  slotVouts: number[];
}

function addInputs(tx: Transaction, inputs: SpendableInput[], sequence = FINAL) {
  for (const i of inputs) {
    tx.addInput({
      sourceTransaction: i.sourceTransaction,
      sourceOutputIndex: i.sourceOutputIndex,
      unlockingScriptTemplate: i.unlock,
      sequence,
    });
  }
}

function tokenTotals(list: (Bsv21Transfer | undefined)[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const t of list) if (t) m.set(t.id, (m.get(t.id) ?? 0n) + t.amt);
  return m;
}

/** Build and sign the creation tx. Token change is added so nothing is burned. */
export async function buildCreation(a: CreationArgs): Promise<Creation> {
  if (a.slots.length === 0) throw new Error('presign: no slots');
  const tx = new Transaction();
  addInputs(tx, a.inputs);
  const slotVouts: number[] = [];
  for (const s of a.slots) {
    if (!Number.isInteger(s.satoshis) || s.satoshis < 1) throw new Error('presign: slot sats must be ≥ 1');
    slotVouts.push(tx.outputs.length);
    tx.addOutput({ lockingScript: slotLockingScript(s), satoshis: s.satoshis });
  }
  const tin = tokenTotals(a.inputs.map((i) => i.token));
  const tout = tokenTotals(a.slots.map((s) => s.token));
  for (const [id, out] of tout) {
    const have = tin.get(id) ?? 0n;
    if (out > have) throw new Error(`presign: slots need ${out} of ${id}, inputs carry ${have}`);
  }
  for (const [id, have] of tin) {
    const left = have - (tout.get(id) ?? 0n);
    if (left > 0n) {
      tx.addOutput({ lockingScript: withTransfer(new P2PKH().lock(a.changeAddress), { id, amt: left }), satoshis: 1 });
    }
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(a.changeAddress), change: true });
  await tx.fee(new SatoshisPerKilobyte(a.feeSatPerKb ?? DEFAULT_FEE_SAT_PER_KB));
  await tx.sign();
  return { tx, slotVouts };
}

export interface SlotOutpoint {
  sourceTransaction: Transaction;
  sourceOutputIndex: number;
}

export interface ClaimTemplateArgs {
  slot: SlotOutpoint;
  /** outputs the payer sees at signing time; for SINGLE, output 0 is pinned */
  outputs: { lockingScript: Script; satoshis: number }[];
  /** per-period nLockTime for SINGLE subscriptions; 0 for claims */
  lockTime?: number;
  sequence?: number;
}

/** The unsigned tx the payer pre-signs. The slot is always input 0. */
export function claimSkeleton(a: ClaimTemplateArgs): Transaction {
  const tx = new Transaction();
  tx.lockTime = a.lockTime ?? 0;
  tx.addInput({
    sourceTransaction: a.slot.sourceTransaction,
    sourceOutputIndex: a.slot.sourceOutputIndex,
    sequence: a.sequence ?? (tx.lockTime > 0 ? NON_FINAL : FINAL),
  });
  for (const o of a.outputs)
    tx.addOutput({ lockingScript: LockingScript.fromHex(o.lockingScript.toHex()), satoshis: o.satoshis });
  return tx;
}

export function presignSlot(P: PrivateKey, a: ClaimTemplateArgs, scope: PresignScope): number[] {
  return presignClaim(P, claimSkeleton(a), 0, scope);
}

export interface FinishClaimArgs extends ClaimTemplateArgs {
  sigP: number[];
  S: PrivateKey;
  feeInputs: SpendableInput[];
  /** service change address */
  changeAddress: string;
  feeSatPerKb?: number;
}

/**
 * Service side: rebuild the claim with the final outputs, add the fee input and
 * change, sign. lockTime and the slot's sequence must match the pre-signature.
 */
export async function finishClaim(a: FinishClaimArgs): Promise<Transaction> {
  const tx = claimSkeleton(a);
  tx.inputs[0].unlockingScriptTemplate = claimTemplate(a.sigP, a.S);
  addInputs(tx, a.feeInputs, tx.inputs[0].sequence);
  tx.addOutput({ lockingScript: new P2PKH().lock(a.changeAddress), change: true });
  await tx.fee(new SatoshisPerKilobyte(a.feeSatPerKb ?? DEFAULT_FEE_SAT_PER_KB));
  await tx.sign();
  return tx;
}

export interface RefundArgs {
  slot: SlotOutpoint;
  R: PrivateKey;
  until: number;
  /** payer address that receives the slot (token or sats) */
  toAddress: string;
  /** token in the slot, if any: the refund writes the transfer back to the payer */
  token?: Bsv21Transfer;
  /** fee inputs (needed for 1-sat token slots) */
  feeInputs?: SpendableInput[];
  changeAddress?: string;
  feeSatPerKb?: number;
}

/** Payer-alone refund. Valid only at nLockTime ≥ T (enforced by the covenant). */
export async function buildRefund(a: RefundArgs): Promise<Transaction> {
  const tx = new Transaction();
  tx.lockTime = a.until;
  tx.addInput({
    sourceTransaction: a.slot.sourceTransaction,
    sourceOutputIndex: a.slot.sourceOutputIndex,
    unlockingScriptTemplate: refundTemplate(a.R),
    sequence: NON_FINAL,
  });
  addInputs(tx, a.feeInputs ?? [], NON_FINAL);
  const slotSats = a.slot.sourceTransaction.outputs[a.slot.sourceOutputIndex].satoshis ?? 0;
  const pay = new P2PKH().lock(a.toAddress);
  if (a.token) {
    tx.addOutput({ lockingScript: withTransfer(pay, a.token), satoshis: slotSats });
    if (!a.feeInputs?.length) throw new Error('presign: a token refund needs a fee input');
    tx.addOutput({ lockingScript: new P2PKH().lock(a.changeAddress ?? a.toAddress), change: true });
  } else if (a.feeInputs?.length) {
    tx.addOutput({ lockingScript: pay, satoshis: slotSats });
    tx.addOutput({ lockingScript: new P2PKH().lock(a.changeAddress ?? a.toAddress), change: true });
  } else {
    tx.addOutput({ lockingScript: pay, change: true });
  }
  await tx.fee(new SatoshisPerKilobyte(a.feeSatPerKb ?? DEFAULT_FEE_SAT_PER_KB));
  await tx.sign();
  return tx;
}
