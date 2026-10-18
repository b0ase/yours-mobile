// bTrust check-in and heir claim: pure view helpers for the screens. No keys, no network, no signing.
// Signing lives in sign.ts (check-in, heir claims); seed-only lock discovery in derive.ts.

import { validatePlan, type InheritancePlan } from './inheritance';

export const BLOCKS_PER_DAY = 144;

export type Countdown = {
  /** Blocks until any two heirs may claim (0 once open). */
  heirsBlocks: number;
  /** Blocks until the lead heir may claim alone (0 once open). */
  leadBlocks: number;
  heirsDays: number;
  leadDays: number;
  /** 'ok' > 30 days left, 'soon' within 30 days, 'open' heirs can claim now. */
  tone: 'ok' | 'soon' | 'open';
};

export function countdown(plan: InheritancePlan, currentHeight: number): Countdown {
  const heirsBlocks = Math.max(0, plan.heirsHeight - currentHeight);
  const leadBlocks = Math.max(0, plan.leadHeight - currentHeight);
  const heirsDays = Math.ceil(heirsBlocks / BLOCKS_PER_DAY);
  const tone = heirsBlocks === 0 ? 'open' : heirsDays <= 30 ? 'soon' : 'ok';
  return { heirsBlocks, leadBlocks, heirsDays, leadDays: Math.ceil(leadBlocks / BLOCKS_PER_DAY), tone };
}

export type ClaimPath = 'none' | 'heirs' | 'lead';

/** Which heir path the chain would accept now (owner path is always open to the owner). */
export function claimPath(plan: InheritancePlan, currentHeight: number): ClaimPath {
  if (currentHeight >= plan.leadHeight) return 'lead';
  if (currentHeight >= plan.heirsHeight) return 'heirs';
  return 'none';
}

/** Parse a saved btrust-plan.json (as given to each heir) and validate it. */
export function parsePlan(text: string): InheritancePlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That is not a bTrust plan file');
  }
  if (!raw || typeof raw !== 'object') throw new Error('That is not a bTrust plan file');
  return validatePlan(raw as InheritancePlan);
}

/** Index of an heir by public key, or -1. Lets an heir see which seat is theirs. */
export const heirIndex = (plan: InheritancePlan, pubKey: string) =>
  plan.heirs.findIndex((h) => h.pubKey === pubKey.trim().toLowerCase());
