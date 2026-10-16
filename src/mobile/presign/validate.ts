/**
 * Pre-signed payments — validation (docs/PRESIGNED-PAYMENTS.md §1.4, §2, §4.4).
 * Pure checks run before anything is signed or broadcast.
 */
import { P2PKH, Spend, type Transaction, Utils } from '@bsv/sdk';
import { decodeSlot, tokenOf } from './script';
import { SIGHASH } from './sign';

/** §4.4, baked in. */
export const LIMITS = {
  noneSlotsPerSet: 50,
  noneOpenUsdPerPayer: 20,
  defaultDeadlineBlocks: 7 * 144,
  maxDeadlineBlocks: 30 * 144,
  refundFeeReserveSats: 1000,
  /** the service stops co-signing this many blocks before T (§2, §5.1) */
  claimStopBlocks: 6,
} as const;

export type Check = { ok: true } | { ok: false; error: string };
const ok: Check = { ok: true };
const fail = (error: string): Check => ({ ok: false, error });

/** Run every input through the @bsv/sdk interpreter. Inputs need sourceTransaction. */
export function verifyTx(tx: Transaction): Check {
  for (let i = 0; i < tx.inputs.length; i++) {
    const r = verifyInput(tx, i);
    if (!r.ok) return fail(`input ${i}: ${r.error}`);
  }
  return ok;
}

export function verifyInput(tx: Transaction, i: number): Check {
  const input = tx.inputs[i];
  const src = input.sourceTransaction?.outputs[input.sourceOutputIndex];
  if (!src || !input.unlockingScript) return fail('missing source or unlocking script');
  try {
    const spend = new Spend({
      sourceTXID: input.sourceTransaction!.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: src.satoshis ?? 0,
      lockingScript: src.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== i),
      outputs: tx.outputs,
      inputIndex: i,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    });
    return spend.validate() ? ok : fail('script returned false');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * No-burn check: per token id, outputs must carry exactly what inputs carry.
 * Fewer = burned remainder; more = invalid transfer (the whole tx is void to the indexer).
 */
export function checkTokenBalance(tx: Transaction): Check {
  const sum = (scripts: (import('@bsv/sdk').Script | undefined)[]) => {
    const m = new Map<string, bigint>();
    for (const s of scripts) {
      const t = s && tokenOf(s);
      if (t) m.set(t.id, (m.get(t.id) ?? 0n) + t.amt);
    }
    return m;
  };
  const tin = sum(tx.inputs.map((i) => i.sourceTransaction?.outputs[i.sourceOutputIndex]?.lockingScript));
  const tout = sum(tx.outputs.map((o) => o.lockingScript));
  for (const id of new Set([...tin.keys(), ...tout.keys()])) {
    const a = tin.get(id) ?? 0n;
    const b = tout.get(id) ?? 0n;
    if (a !== b) return fail(`token ${id.slice(0, 10)}…: inputs ${a}, outputs ${b}`);
  }
  return ok;
}

/**
 * Service pre-broadcast check for a claim (§1.4): the slot is input 0, output 0
 * pays the recipient and, for a token slot, carries the same transfer amount.
 */
export function checkClaim(tx: Transaction, recipientAddress: string): Check {
  const input = tx.inputs[0];
  const src = input?.sourceTransaction?.outputs[input.sourceOutputIndex];
  if (!src) return fail('slot input missing');
  const slot = decodeSlot(src.lockingScript);
  if (!slot) return fail('input 0 is not a presign slot');
  if (tx.lockTime !== 0 && tx.lockTime >= slot.until) return fail('claim nLockTime reaches the refund height');
  const out0 = tx.outputs[0];
  if (!out0) return fail('no output 0');
  const want = new P2PKH().lock(recipientAddress).toHex();
  if (!out0.lockingScript.toHex().endsWith(want)) return fail('output 0 does not pay the recipient');
  if (slot.token) {
    const t = tokenOf(out0.lockingScript);
    if (!t || t.id !== slot.token.id || t.amt !== slot.token.amt) return fail('output 0 does not carry the slot token');
    const bal = checkTokenBalance(tx);
    if (!bal.ok) return bal;
  } else if ((out0.satoshis ?? 0) < (src.satoshis ?? 0)) {
    return fail('output 0 pays less than the slot');
  }
  return verifyTx(tx);
}

export interface SetPlan {
  scope: number;
  slots: number;
  /** USD value of the slots in this set (NONE only) */
  usdValue: number;
  /** USD already open in this payer's other NONE sets */
  usdOpenElsewhere: number;
  createdHeight: number;
  until: number;
  /** spare sats the wallet keeps for refund fees */
  reserveSats: number;
}

/** §4.4 limits. No user toggles. */
export function checkLimits(p: SetPlan): Check {
  const span = p.until - p.createdHeight;
  if (span < 1) return fail('the refund height must be in the future');
  if (span <= LIMITS.claimStopBlocks) return fail('the deadline is too close for any claim');
  if (p.scope === SIGHASH.NONE_ACP) {
    if (p.slots > LIMITS.noneSlotsPerSet) return fail(`at most ${LIMITS.noneSlotsPerSet} open slots per set`);
    if (span > LIMITS.maxDeadlineBlocks) return fail('open slots can be set aside for 30 days at most');
    if (p.usdValue + p.usdOpenElsewhere > LIMITS.noneOpenUsdPerPayer) {
      return fail(`at most $${LIMITS.noneOpenUsdPerPayer} can be open in invite slots`);
    }
  } else if (p.scope !== SIGHASH.SINGLE_ACP) {
    return fail('unknown pre-sign scope');
  }
  if (p.reserveSats < LIMITS.refundFeeReserveSats) return fail('keep 1,000 sats for refund fees');
  return ok;
}

/** May the service still co-sign at this tip height? */
export function claimWindowOpen(tip: number, until: number): boolean {
  return tip < until - LIMITS.claimStopBlocks;
}

/** A refund with nLockTime T is final once the tip has reached T (next block is T+1). */
export function refundFinal(tip: number, until: number): boolean {
  return tip >= until;
}

export const toHex = Utils.toHex;
