// bTrust plan files: a stable short code from the lock script, a filename that never carries heir names, and the
// optional funding fields written after the lock is funded. Old plan files (no extra fields) load unchanged.

import { Hash, Utils } from '@bsv/sdk';
import { inheritanceLock, validatePlan, type InheritancePlan } from './inheritance';

/** 6 hex from sha256(lock script): the same lock always gives the same code. */
export const planCode = (plan: InheritancePlan) =>
  Utils.toHex(Hash.sha256(inheritanceLock(plan).toBinary())).slice(0, 6);

export const planLabel = (plan: InheritancePlan) => `Plan ${planCode(plan)}`;

/** btrust-plan-YYYY-MM-DD-<code>.json, or …-<code>-TEST.json for a test plan. */
export function planFileName(plan: InheritancePlan, at = new Date()): string {
  const d = at.toISOString().slice(0, 10);
  return `btrust-plan-${d}-${planCode(plan)}${plan.test ? '-TEST' : ''}.json`;
}

/** The plan with where its lock lives, after funding. */
export function withFunding(
  plan: InheritancePlan,
  f: { slot: number; fundingTxid: string; vout: number; createdAt?: number },
): InheritancePlan {
  if (!/^[0-9a-f]{64}$/.test(f.fundingTxid)) throw new Error('bad funding txid');
  return validatePlan({
    ...plan,
    slot: f.slot,
    fundingTxid: f.fundingTxid,
    vout: f.vout,
    createdAt: f.createdAt ?? Date.now(),
  });
}

export const planJson = (plan: InheritancePlan) => JSON.stringify(plan, null, 2);
