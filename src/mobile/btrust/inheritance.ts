// bTrust "Passing on": a non-custodial inheritance output. Pure script builders, no network, no keys held.
//
//   OP_IF                                     owner, any time (check-in = spend and re-lock with a later height)
//     <ownerPub> OP_CHECKSIG
//   OP_ELSE
//     OP_IF                                   heirs: any 2 of 3 after `heirsHeight`
//       OP_2 <h1> <h2> <h3> OP_3 OP_CHECKMULTISIGVERIFY
//       <1Sat Lock: GATE key, until heirsHeight>
//     OP_ELSE                                 lead heir alone after the later `leadHeight`
//       <1Sat Lock: lead heir PKH, until leadHeight>
//     OP_ENDIF
//   OP_ENDIF
//
// BSV has no live OP_CHECKLOCKTIMEVERIFY after Genesis, so the timelock reuses the audited 1Sat Lock
// contract (OP_PUSH_TX: reads nLockTime from the sighash preimage, refuses a final nSequence), exactly as
// placement/scripts.ts does. On the heirs branch the Lock is keyed to a PUBLIC gate key (private key = 1):
// it only enforces the height, while the 2-of-3 CHECKMULTISIGVERIFY over the same SIGHASH_ALL preimage
// does the authorising. Anyone can make the gate signature; nobody can make the heirs' signatures.
//
// Recovery needs no server: the owner key derives from the seed, the heirs hold their own keys, and the
// script rebuilds from the InheritancePlan (heir pubkeys + heights), which travels with the recovery slices.
// Without the plan file, derive.ts finds the locks from the seed alone (owner key slots + beacon outputs) and
// rebuilds the plan from the lock script on chain.

import { Lock } from '@1sat/templates';
import {
  BigNumber,
  LockingScript,
  OP,
  PrivateKey,
  PublicKey,
  Script,
  UnlockingScript,
  Utils,
  type Transaction,
} from '@bsv/sdk';
import { keySigner, multisigUnlock } from '../placement/scripts';

/** BRC-100 protocol for the seed-derived bTrust owner key (keyID 'owner', counterparty self). */
export const BTRUST_PROTOCOL: [1, string] = [1, 'btrust'];

export const HEIRS_M = 2;
export const HEIRS_N = 3;

/** The public gate key for the heirs branch (private key 1). Deliberately not secret. */
export const GATE_KEY = new PrivateKey(new BigNumber(1));

export type InheritancePlan = {
  v: 1;
  ownerPubKey: string;
  /** Built in a developer build's test mode (3-block timings). Never set in production. */
  test?: true;
  /** Exactly three heir public keys, in the order signatures must follow. */
  heirs: { name: string; paymail?: string; pubKey: string }[];
  /** Height after which any two heirs may spend (if the owner has not checked in). */
  heirsHeight: number;
  /** Later height after which heirs[0] (the lead heir) may spend alone. */
  leadHeight: number;
};

const isHeight = (h: number) => Number.isInteger(h) && h > 0 && h < 500_000_000;
const hexPub = (k: string) => PublicKey.fromString(k).toString();

export function validatePlan(p: InheritancePlan): InheritancePlan {
  if (p.v !== 1) throw new Error('unknown plan version');
  if (p.heirs.length !== HEIRS_N) throw new Error(`bTrust needs exactly ${HEIRS_N} heirs`);
  const keys = [p.ownerPubKey, ...p.heirs.map((h) => h.pubKey)];
  for (const k of keys) if (!/^0[23][0-9a-f]{64}$/.test(k)) throw new Error('keys must be compressed public keys');
  keys.forEach(hexPub);
  if (new Set(keys).size !== keys.length) throw new Error('owner and heir keys must all differ');
  if (!isHeight(p.heirsHeight) || !isHeight(p.leadHeight)) throw new Error('heights must be block heights');
  if (p.leadHeight <= p.heirsHeight) throw new Error('the lead heir height must be later than the heirs height');
  for (const h of p.heirs) if (!h.name.trim()) throw new Error('every heir needs a name');
  return p;
}

export function inheritanceLock(plan: InheritancePlan, mainnet = true): LockingScript {
  const p = validatePlan(plan);
  const net = mainnet ? 'mainnet' : 'testnet';
  const s = new Script()
    .writeOpCode(OP.OP_IF)
    .writeBin(Utils.toArray(p.ownerPubKey, 'hex'))
    .writeOpCode(OP.OP_CHECKSIG)
    .writeOpCode(OP.OP_ELSE)
    .writeOpCode(OP.OP_IF)
    .writeOpCode(OP.OP_2);
  for (const h of p.heirs) s.writeBin(Utils.toArray(h.pubKey, 'hex'));
  s.writeOpCode(OP.OP_3)
    .writeOpCode(OP.OP_CHECKMULTISIGVERIFY)
    .writeScript(Lock.lock(GATE_KEY.toPublicKey().toAddress(net), p.heirsHeight))
    .writeOpCode(OP.OP_ELSE)
    .writeScript(Lock.lock(PublicKey.fromString(p.heirs[0].pubKey).toAddress(net), p.leadHeight))
    .writeOpCode(OP.OP_ENDIF)
    .writeOpCode(OP.OP_ENDIF);
  return new LockingScript(s.chunks);
}

/** True when `script` is exactly the lock for `plan` (byte-for-byte rebuild). */
export const matchesPlan = (script: Script, plan: InheritancePlan, mainnet = true) =>
  script.toHex() === inheritanceLock(plan, mainnet).toHex();

type Signer = (tx: Transaction, inputIndex: number) => Promise<number[]>;

/** Owner path (check-in or withdraw): <sig> OP_1. */
export function ownerUnlock(owner: Signer) {
  return {
    sign: async (tx: Transaction, i: number) =>
      new UnlockingScript(new Script().writeBin(await owner(tx, i)).writeOpCode(OP.OP_1).chunks),
    estimateLength: async () => 75,
  };
}

/**
 * Heirs path: two heir signers in key order. tx.lockTime must be >= heirsHeight and the input's
 * nSequence < 0xffffffff. Stack: <gate Lock unlock…> OP_0 <sigA> <sigB> OP_1 OP_0.
 */
export function heirsUnlock(signers: [Signer, Signer]) {
  const gate = Lock.unlock(GATE_KEY);
  const multi = multisigUnlock(signers);
  return {
    sign: async (tx: Transaction, i: number) => {
      const s = await gate.sign(tx, i);
      s.writeScript(await multi.sign(tx, i));
      s.writeOpCode(OP.OP_1).writeOpCode(OP.OP_0);
      return new UnlockingScript(s.chunks);
    },
    estimateLength: async () => 1250,
  };
}

/** Lead heir alone after leadHeight: Lock unlock, then OP_0 OP_0. */
export function leadHeirUnlock(lead: PrivateKey) {
  const inner = Lock.unlock(lead);
  return {
    sign: async (tx: Transaction, i: number) => {
      const s = await inner.sign(tx, i);
      s.writeOpCode(OP.OP_0).writeOpCode(OP.OP_0);
      return new UnlockingScript(s.chunks);
    },
    estimateLength: async () => 1100,
  };
}

export { keySigner };

/** Approximate blocks for a number of months (144 a day, 30.44 days a month). */
export const blocksForMonths = (months: number) => Math.ceil(months * 30.44 * 144);

/** Owner check-in: the same plan with both heights pushed forward from `currentHeight`. */
export function checkIn(
  plan: InheritancePlan,
  currentHeight: number,
  months = 12,
  leadExtraMonths = 6,
): InheritancePlan {
  if (!isHeight(currentHeight)) throw new Error('current height required');
  const heirsHeight = currentHeight + blocksForMonths(months);
  return validatePlan({ ...plan, heirsHeight, leadHeight: heirsHeight + blocksForMonths(leadExtraMonths) });
}

/** Plain-English status for the screen. */
export function planStatus(plan: InheritancePlan, currentHeight: number): string {
  if (currentHeight >= plan.leadHeight) return `${plan.heirs[0].name} can now claim alone, or any two heirs together`;
  if (currentHeight >= plan.heirsHeight) return 'Any two heirs can now claim. Check in to push the date back.';
  const days = Math.ceil((plan.heirsHeight - currentHeight) / 144);
  return `Yours. Heirs can claim in about ${days} ${days === 1 ? 'day' : 'days'} unless you check in.`;
}
