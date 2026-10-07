/**
 * Ported from tokenblaster.lol src/lib/launch/shape.ts: the trade plan the BlastPad server proposes
 * and matchesPlan, the check the client runs on the wallet's transaction before anything is signed.
 */
import type { Transaction } from '@bsv/sdk';

export type OutSpec = { script: string; sats: number; what: string };
export type TradePlan = {
  lease: string;
  side: 'buy' | 'sell';
  tokenId: string;
  sym: string;
  inputs: { outpoint: string; sats: number; what: string }[]; // pool inputs, in order, first
  outputs: OutSpec[]; // fixed outputs, in order, first
  beef: string; // hex BEEF with the pool inputs' history
  quote: {
    tokens: string;
    curveSats: string;
    houseFee: string;
    routeFee: string;
    userSats: string;
    soldAfter: string;
    indexFee: number;
  };
  expires: number; // ms epoch
};

/**
 * Check that `tx` starts with the plan's inputs and outputs, exactly. Returns the extra outputs
 * (the wallet's) so callers can inspect them.
 */
export function matchesPlan(
  tx: Transaction,
  plan: Pick<TradePlan, 'inputs' | 'outputs'>,
): { ok: true } | { ok: false; why: string } {
  for (let i = 0; i < plan.inputs.length; i++) {
    const inp = tx.inputs[i];
    if (!inp) return { ok: false, why: `input ${i} missing` };
    const op = `${inp.sourceTXID ?? inp.sourceTransaction?.id('hex')}_${inp.sourceOutputIndex}`;
    if (op !== plan.inputs[i].outpoint)
      return { ok: false, why: `input ${i} is ${op}, expected ${plan.inputs[i].outpoint}` };
  }
  for (let i = 0; i < plan.outputs.length; i++) {
    const o = tx.outputs[i];
    if (!o) return { ok: false, why: `output ${i} missing` };
    if (o.lockingScript.toHex() !== plan.outputs[i].script || (o.satoshis ?? 0) !== plan.outputs[i].sats) {
      return { ok: false, why: `output ${i} (${plan.outputs[i].what}) was changed` };
    }
  }
  return { ok: true };
}

export type Route =
  | { kind: 'creator'; address: string }
  | { kind: 'split'; to: { address: string; bps: number }[] }
  | { kind: 'holders' }
  | { kind: 'buyback' };
