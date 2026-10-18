/**
 * Creator vesting at launch (Exchange › Launchpad). Pure helpers: the schedule, the tranche lock scripts, the
 * public receipt and its verifier. Nothing here signs, fetches or holds a key.
 *
 * The creator may keep 0–20% of the supply (default 10%), always time-locked: by default a 12-month cliff, then
 * 24 months of linear unlocking, never less than 6 months in all. Linear unlocking is a ladder of tranches, one per
 * month of the linear period (24 by default, at most MAX_TRANCHES), each its own on-chain output with its own unlock
 * height. A cliff with no linear period is one tranche.
 *
 * Each tranche output is a BSV-21 transfer inscription on top of the audited 1Sat Lock contract (the script Lock
 * BSV and bShares already use; BSV has no live CLTV after Genesis, so the lock reads nLockTime from the sighash
 * preimage and refuses a final nSequence). The lock pays to the creator's own key, derived from their seed by the
 * BRC-100 wallet (protocol [0, 'onesat'], keyID "vest", counterparty self): no bWalletX key, no server, recoverable by any
 * BRC-100 wallet restored from the same seed.
 *
 * The receipt is an OP_RETURN MAP output in the same transaction as the tranches. That transaction also spends the
 * token's deploy outpoint, so anyone can find it (the deploy output's spender) and check every tranche against it
 * (verifyVestingTx): the receipt proves nothing by itself, the outputs do.
 */
import { Lock } from '@1sat/templates';
import { LockingScript, OP, Script, Transaction, Utils } from '@bsv/sdk';
import { BLOCKS_PER_DAY } from '../../locks/schedule';
import { MAP_PREFIX } from '../../names/personalToken';

export const VEST_MAX_BPS = 2000; // 20%
export const VEST_DEFAULT_BPS = 1000; // 10%
export const VEST_DEFAULT_CLIFF = 12;
export const VEST_DEFAULT_LINEAR = 24;
export const VEST_MIN_MONTHS = 6;
export const VEST_MAX_MONTHS = 48; // per part (cliff, linear)
export const MAX_TRANCHES = 48;
export const VEST_BASKET = 'vesting';
export const VEST_KEY_ID = 'vest';
/** The 1Sat wallets' protocol (P1SAT_PROTOCOL in @1sat/actions), so any 1Sat-style BRC-100 wallet derives the same key. */
export const VEST_PROTOCOL: [0, 'onesat'] = [0, 'onesat'];
export const VEST_RECEIPT_TYPE = 'creator-vesting';
/** Days in a month for block maths (the same figure bShares uses). */
const MONTH_DAYS = 30.44;

export type VestPlan = { keepBps: number; cliffMonths: number; linearMonths: number };
export type Tranche = { height: number; amt: bigint };

export const defaultVestPlan = (): VestPlan => ({
  keepBps: VEST_DEFAULT_BPS,
  cliffMonths: VEST_DEFAULT_CLIFF,
  linearMonths: VEST_DEFAULT_LINEAR,
});

export const monthsToBlocks = (months: number) => Math.ceil(months * MONTH_DAYS * BLOCKS_PER_DAY);

const isWhole = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;

/** Plan rules; null when fine. keepBps 0 means "keep nothing" (no vesting at all). */
export function validateVestPlan(p: VestPlan): string | null {
  if (!isWhole(p.keepBps, 0, VEST_MAX_BPS)) return 'Keep between 0% and 20% of the supply.';
  if (p.keepBps === 0) return null;
  if (!isWhole(p.cliffMonths, 0, VEST_MAX_MONTHS)) return `The cliff is 0 to ${VEST_MAX_MONTHS} months.`;
  if (!isWhole(p.linearMonths, 0, VEST_MAX_MONTHS)) return `Linear unlocking is 0 to ${VEST_MAX_MONTHS} months.`;
  if (p.cliffMonths + p.linearMonths < VEST_MIN_MONTHS)
    return `Your share stays locked for at least ${VEST_MIN_MONTHS} months.`;
  return null;
}

/** Tokens kept (raw units): floor(supply × keepBps / 10 000). */
export const keptAmount = (supply: bigint, keepBps: number): bigint => (supply * BigInt(keepBps)) / 10_000n;

export const trancheCount = (p: VestPlan) => (p.linearMonths === 0 ? 1 : Math.min(p.linearMonths, MAX_TRANCHES));

/**
 * The ladder. Tranche i (1..n) opens at cliff + i × linear / n months after `startHeight`; amounts are equal, the
 * last takes the rounding remainder. Throws (fail closed) on a bad plan, a bad height or too few tokens to split.
 */
export function vestSchedule(supply: bigint, p: VestPlan, startHeight: number): Tranche[] {
  const err = validateVestPlan(p);
  if (err) throw new Error(err);
  if (p.keepBps === 0) return [];
  if (!Number.isInteger(startHeight) || startHeight <= 0 || startHeight >= 400_000_000)
    throw new Error('Current block height unknown.');
  const kept = keptAmount(supply, p.keepBps);
  const n = trancheCount(p);
  if (kept < BigInt(n)) throw new Error('The supply is too small to split into the unlock schedule.');
  const each = kept / BigInt(n);
  const out: Tranche[] = [];
  for (let i = 1; i <= n; i++) {
    const months = p.cliffMonths + (p.linearMonths * i) / n;
    out.push({ height: startHeight + monthsToBlocks(months), amt: i === n ? kept - each * BigInt(n - 1) : each });
  }
  return out;
}

const hex = (s: string) => Utils.toHex(Utils.toArray(s, 'utf8'));

/** One tranche output: a BSV-21 transfer of `amt` of `tokenId`, locked to `address` until block `height`. */
export function vestTrancheScript(tokenId: string, amt: bigint, address: string, height: number): LockingScript {
  if (amt <= 0n) throw new Error('Tranche amount must be positive.');
  if (!Number.isInteger(height) || height <= 0 || height >= 500_000_000)
    throw new Error('Unlock must be a block height.');
  const ins = Script.fromASM(
    `OP_0 OP_IF ${hex('ord')} OP_1 ${hex('application/bsv-20')} OP_0 ${hex(JSON.stringify({ p: 'bsv-20', op: 'transfer', id: tokenId, amt: amt.toString() }))} OP_ENDIF`,
  );
  const s = new Script().writeScript(ins).writeScript(Lock.lock(address, height));
  const d = Lock.decode(s);
  if (!d || d.address !== address || d.until !== height) throw new Error('Could not build the vesting lock.');
  return new LockingScript(s.chunks);
}

export type VestReceipt = {
  app: 'bwalletx';
  type: typeof VEST_RECEIPT_TYPE;
  v: 1;
  token: string;
  sym: string;
  supply: string;
  kept: string;
  keepBps: number;
  cliffMonths: number;
  linearMonths: number;
  startHeight: number;
  lockAddress: string;
  /** How the creator's wallet derives the lock key from their seed (public, not a secret). */
  key: { protocolID: [0, 'onesat']; keyID: typeof VEST_KEY_ID; counterparty: 'self' };
  /** Tranche outputs come first in the transaction, in schedule order. */
  tranches: { vout: number; height: number; amt: string }[];
};

export function buildVestReceipt(o: {
  tokenId: string;
  sym: string;
  supply: bigint;
  plan: VestPlan;
  startHeight: number;
  lockAddress: string;
  tranches: Tranche[];
}): VestReceipt {
  return {
    app: 'bwalletx',
    type: VEST_RECEIPT_TYPE,
    v: 1,
    token: o.tokenId,
    sym: o.sym,
    supply: o.supply.toString(),
    kept: o.tranches.reduce((n, t) => n + t.amt, 0n).toString(),
    keepBps: o.plan.keepBps,
    cliffMonths: o.plan.cliffMonths,
    linearMonths: o.plan.linearMonths,
    startHeight: o.startHeight,
    lockAddress: o.lockAddress,
    key: { protocolID: [...VEST_PROTOCOL], keyID: VEST_KEY_ID, counterparty: 'self' },
    tranches: o.tranches.map((t, i) => ({ vout: i, height: t.height, amt: t.amt.toString() })),
  };
}

/** OP_FALSE OP_RETURN MAP SET app bWallet type creator-vesting token <id> receipt <json>. */
export function vestReceiptScript(r: VestReceipt): LockingScript {
  const s = new LockingScript();
  s.writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  const parts = [MAP_PREFIX, 'SET', 'app', 'bWallet', 'type', VEST_RECEIPT_TYPE, 'token', r.token, 'receipt'];
  for (const p of [...parts, JSON.stringify(r)]) s.writeBin(Utils.toArray(p, 'utf8'));
  return s;
}

/** The receipt JSON inside a MAP OP_RETURN script, or null. */
export function parseVestReceiptScript(script: Script): VestReceipt | null {
  const c = script.chunks;
  if (c.length < 2 || c[0].op !== OP.OP_FALSE || c[1].op !== OP.OP_RETURN) return null;
  // A script read from hex (the wallet's transaction, the chain) keeps everything after OP_RETURN as ONE data
  // chunk; a script we built keeps the pushes. Read the pushes either way.
  let pushes = c.slice(2);
  if (pushes.length === 0 && c[1].data?.length) {
    try {
      pushes = Script.fromBinary(c[1].data).chunks;
    } catch {
      return null;
    }
  }
  if (pushes.some((x) => !x.data)) return null;
  const text = pushes.map((x) => Utils.toUTF8(x.data!));
  if (text[0] !== MAP_PREFIX || text[1] !== 'SET') return null;
  const i = text.indexOf('receipt');
  if (i < 0 || i % 2 !== 0 || !text.includes(VEST_RECEIPT_TYPE)) return null;
  let r: VestReceipt;
  try {
    r = JSON.parse(text[i + 1] ?? '') as VestReceipt;
  } catch {
    return null;
  }
  if (!r || r.type !== VEST_RECEIPT_TYPE || r.v !== 1) return null;
  // Exactly the canonical receipt script for this JSON, byte for byte (no extra or reordered fields).
  try {
    return vestReceiptScript(r).toHex() === script.toHex() ? r : null;
  } catch {
    return null;
  }
}

export type VerifiedVesting = { txid: string; receipt: VestReceipt; kept: bigint; tranches: Tranche[] };

/**
 * Checks a vesting transaction against the token, fail closed: the receipt must exist and name this token; the
 * transaction must spend the token's deploy outpoint; every tranche output must be exactly the lock script the
 * receipt describes (rebuilt here, byte for byte); amounts must add up to `kept` and to keepBps of supply (≤ 20%);
 * the schedule must last at least 6 months. Returns the checked schedule, or an error string.
 */
export function verifyVestingTx(tx: Transaction, tokenId: string): VerifiedVesting | string {
  const id = tokenId.replace('.', '_');
  const [deployTxid, deployVout] = id.split('_');
  const spendsDeploy = tx.inputs.some(
    (i) =>
      (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === deployTxid && i.sourceOutputIndex === Number(deployVout),
  );
  if (!spendsDeploy) return 'This transaction does not spend the token’s deploy output.';
  const found = tx.outputs.map((o) => parseVestReceiptScript(o.lockingScript)).filter((r): r is VestReceipt => !!r);
  if (found.length !== 1) return 'No single vesting receipt in this transaction.';
  const r = found[0];
  if (r.token !== id) return 'The receipt names a different token.';
  if (!isWhole(r.keepBps, 1, VEST_MAX_BPS)) return 'The receipt keeps more than 20%.';
  if (!Array.isArray(r.tranches) || r.tranches.length < 1 || r.tranches.length > MAX_TRANCHES)
    return 'The receipt has no valid tranches.';
  let supply: bigint, kept: bigint;
  try {
    supply = BigInt(r.supply);
    kept = BigInt(r.kept);
  } catch {
    return 'The receipt amounts are not numbers.';
  }
  if (kept !== keptAmount(supply, r.keepBps)) return 'The kept amount does not match the stated share.';
  let sum = 0n;
  let last = 0;
  const tranches: Tranche[] = [];
  for (const t of r.tranches) {
    let amt: bigint;
    try {
      amt = BigInt(t.amt);
    } catch {
      return 'A tranche amount is not a number.';
    }
    if (!Number.isInteger(t.height) || t.height < last) return 'Tranche heights are out of order.';
    const out = tx.outputs[t.vout];
    let want: string;
    try {
      want = vestTrancheScript(id, amt, r.lockAddress, t.height).toHex();
    } catch {
      return 'A tranche is malformed.';
    }
    if (!out || out.lockingScript.toHex() !== want) return `Output ${t.vout} is not the lock the receipt describes.`;
    sum += amt;
    last = t.height;
    tranches.push({ height: t.height, amt });
  }
  if (new Set(r.tranches.map((t) => t.vout)).size !== r.tranches.length) return 'Tranches repeat an output.';
  if (sum !== kept) return 'The tranches do not add up to the kept amount.';
  if (
    !Number.isInteger(r.startHeight) ||
    tranches[tranches.length - 1].height - r.startHeight < monthsToBlocks(VEST_MIN_MONTHS)
  )
    return 'The lock is shorter than 6 months.';
  let txid: string;
  try {
    txid = tx.id('hex');
  } catch {
    return 'The transaction is incomplete.';
  }
  return { txid, receipt: r, kept, tranches };
}

/** Months (rounded) from `now` to `height`, for display. */
export const monthsUntil = (height: number, now: number) => Math.max(0, (height - now) / (MONTH_DAYS * BLOCKS_PER_DAY));

/** "12-month cliff, then 24 monthly unlocks" style summary. */
export function scheduleSummary(p: Pick<VestPlan, 'cliffMonths' | 'linearMonths'>): string {
  const cliff = p.cliffMonths > 0 ? `${p.cliffMonths}-month cliff` : 'no cliff';
  if (p.linearMonths === 0) return `all unlocks after ${p.cliffMonths} months`;
  const n = Math.min(p.linearMonths, MAX_TRANCHES);
  return `${cliff}, then ${n} monthly unlock${n === 1 ? '' : 's'} over ${p.linearMonths} months`;
}
