/**
 * Token locks (BSV-21), the pure half: scripts, eligibility, records. No wallet, no network.
 *
 * A token lock output is an ordinary BSV-21 transfer inscription whose locking script (the part after
 * the inscription envelope) is the same 1Sat time-lock contract the BSV locks use (@1sat/templates
 * Lock: OP_PUSH_TX checks the spending transaction's nLockTime ≥ the height and a signature by the key
 * hash in the script). So:
 *
 *   OP_FALSE OP_IF "ord" OP_1 "application/bsv-20" OP_0 {"p":"bsv-20","op":"transfer","id":…,"amt":…} OP_ENDIF
 *   <Lock prefix> <owner pkh> <until height> <Lock suffix>
 *
 * The envelope is a no-op when the script runs, so the lock behaves exactly like a BSV lock. The BSV-21
 * overlay admits a transfer output whatever its suffix script is (validity is input amount ≥ output
 * amount per token id), so the locked tokens stay valid tokens and the unlock spends them on as usual.
 *
 * The owner key is the wallet's own BRC-42 key (protocol "onesat", keyID "token-lock", counterparty
 * self): it comes from the seed alone. It is a different key from the BSV locks ("lock") so the BSV
 * lock auto-claim can never pick up a token lock and spend its 1 sat as plain BSV.
 */
import { BSV21, Lock } from '@1sat/templates';
import { LockingScript, type Script, type Transaction } from '@bsv/sdk';
import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import { parseReceipt } from './receipt';

export const TOKEN_LOCK_KEY_ID = 'token-lock';
/** Lock's unlocking script for a bare lock (sig + pubkey + preimage), from @1sat/actions unlockBsv. */
const BARE_UNLOCK_LEN = 1205;

export type TokenLockRecord = {
  /** "txid.vout" of the lock output. */
  outpoint: string;
  tokenId: string;
  sym?: string;
  dec: number;
  /** Base units, as a decimal string (BSV-21 amounts are u64). */
  amt: string;
  until: number;
  label: string;
  lockAddress: string;
  createdAt: string;
  /** The lock transaction also carries a receipt inscription. */
  receipt: boolean;
  /** Set once the lock has been spent back to the wallet. */
  unlockedTxid?: string;
};

/** The lock output's locking script. Throws on a bad amount or height. */
export function tokenLockScript(tokenId: string, amt: bigint, lockAddress: string, until: number): LockingScript {
  if (!/^[0-9a-f]{64}_\d+$/i.test(tokenId)) throw new Error('That is not a BSV-21 token id.');
  if (amt <= 0n || amt > 2n ** 64n - 1n) throw new Error('Enter an amount above zero.');
  if (!Number.isInteger(until) || until <= 0 || until >= 500_000_000)
    throw new Error('The unlock height is not valid.');
  const script = BSV21.transfer(tokenId, amt).lock(lockScriptFor(lockAddress, until));
  const d = decodeTokenLock(script);
  if (!d || d.tokenId !== tokenId || d.amt !== amt || d.until !== until || d.address !== lockAddress)
    throw new Error('Could not build the token lock script.');
  return script;
}

/** The bare time-lock (what sits after the inscription), as a LockingScript for BSV21.lock. */
export const lockScriptFor = (address: string, until: number) =>
  LockingScript.fromBinary(Lock.lock(address, until).toBinary());

export type DecodedTokenLock = { tokenId: string; amt: bigint; address: string; until: number };

/** A token lock read back from a script, or null when the script is not one. */
export function decodeTokenLock(script: Script): DecodedTokenLock | null {
  const lock = Lock.decode(script);
  if (!lock) return null;
  const t = BSV21.decode(script);
  if (!t || t.tokenData.op !== 'transfer' || !t.tokenData.id) return null;
  return { tokenId: t.tokenData.id, amt: t.getAmount(), address: lock.address, until: lock.until };
}

/**
 * A lock can be spent in a block above `until`'s nLockTime: the spend carries nLockTime = until and a
 * non-final sequence, which miners accept once the chain tip has reached `until`.
 */
export const canUnlock = (until: number, height: number) => until > 0 && height > 0 && until <= height;

/** Blocks left (0 when ready). */
export const blocksLeft = (until: number, height: number) => Math.max(0, until - height);

/** "3d 4h", "45m", "Ready": the countdown, at 10 minutes a block. */
export function countdown(until: number, height: number): string {
  const b = blocksLeft(until, height);
  if (b === 0) return 'Ready to unlock';
  const mins = b * 10;
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d >= 365) return `${(d / 365).toFixed(1)} years`;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** createAction unlockingScriptLength for spending a token lock (the preimage carries the whole script). */
export function tokenUnlockLength(lockingScript: Script): number {
  const d = Lock.decode(lockingScript);
  if (!d) throw new Error('Not a lock script.');
  const extra = lockingScript.toBinary().length - Lock.lock(d.address, d.until).toBinary().length;
  return BARE_UNLOCK_LEN + Math.max(0, extra) + 8;
}

/** Parse a user amount ("12.5") into base units for `dec` decimals. Null when invalid. */
export function parseTokenAmount(input: string, dec: number): bigint | null {
  const s = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  if (f.length > dec) return null;
  const v = BigInt(w) * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
  return v > 0n ? v : null;
}

// ── Records: localStorage for speed, plus the account settings so the backup file has them. ──
// The tokens never depend on these: the lock is on chain and the receipt (when minted) is in the
// wallet's own ordinals; recovery needs only the seed and the lock transaction.

const recKey = (account: string) => `bwx.tokenLocks.${account}`;

export function mergeRecords(a: TokenLockRecord[], b: TokenLockRecord[]): TokenLockRecord[] {
  const by = new Map<string, TokenLockRecord>();
  for (const r of [...b, ...a]) {
    const prev = by.get(r.outpoint);
    by.set(r.outpoint, prev ? { ...prev, ...r, unlockedTxid: r.unlockedTxid ?? prev.unlockedTxid } : r);
  }
  return [...by.values()].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
}

/** "txid.vout" or "txid_vout" (the indexer's form) → parts; null when malformed. */
export function splitOutpoint(o: string): { txid: string; vout: number } | null {
  const m = /^([0-9a-f]{64})[._](\d+)$/i.exec(o);
  return m ? { txid: m[1].toLowerCase(), vout: Number(m[2]) } : null;
}

/**
 * A record rebuilt from a lock transaction found on chain (wallet restore / new device). Null unless
 * output `vout` decodes as a token lock to `lockAddress`: amount, token and height come from the script
 * itself, never from the indexer. The receipt in the same transaction, when there is one for this
 * output, gives back the label and the token's decimals and symbol.
 */
export function recordFromLockTx(
  tx: Transaction,
  vout: number,
  lockAddress: string,
  meta: { sym?: string; dec?: number; createdAt?: string } = {},
): TokenLockRecord | null {
  const out = tx.outputs[vout];
  const lock = out ? decodeTokenLock(out.lockingScript) : null;
  if (!lock || lock.address !== lockAddress) return null;
  const receipt = tx.outputs
    .map((o) => parseReceipt(o.lockingScript))
    .find(
      (r) =>
        !!r &&
        r.lockAddress === lockAddress &&
        r.token?.id === lock.tokenId &&
        r.schedule.some((s) => s.vout === vout || s.height === lock.until),
    );
  const dec = meta.dec ?? receipt?.token?.dec;
  return {
    outpoint: `${tx.id('hex')}.${vout}`,
    tokenId: lock.tokenId,
    sym: meta.sym ?? receipt?.token?.sym,
    dec: Number.isInteger(dec) && (dec as number) >= 0 ? (dec as number) : 0,
    amt: lock.amt.toString(),
    until: lock.until,
    label: receipt?.label?.trim() || 'Token lock',
    lockAddress,
    createdAt: receipt?.lockedAt ?? meta.createdAt ?? new Date().toISOString(),
    receipt: !!receipt,
  };
}

/**
 * The wallet's list after a scan: what this device already knew (its labels win) plus every lock found on
 * chain, with a record marked unlocked when the chain shows its output spent (`spends`: outpoint → spending
 * txid, null/absent = unspent or unknown).
 */
export function reconcileTokenLocks(
  local: TokenLockRecord[],
  found: TokenLockRecord[],
  spends: Record<string, string | null | undefined> = {},
): TokenLockRecord[] {
  const unspent = new Set(found.map((r) => r.outpoint));
  return mergeRecords(local, found).map((r) => {
    // Unspent on chain beats a note that it was unlocked (e.g. an unlock that never confirmed): the lock
    // must stay visible and unlockable. unlockTokenLock re-checks the chain before spending anyway.
    if (unspent.has(r.outpoint) && r.unlockedTxid) {
      const { unlockedTxid: _gone, ...rest } = r;
      return rest;
    }
    const spent = spends[r.outpoint];
    return !r.unlockedTxid && typeof spent === 'string' && /^[0-9a-f]{64}$/i.test(spent)
      ? { ...r, unlockedTxid: spent }
      : r;
  });
}

// ── Recovery scan: once per account per device, so a restored wallet finds its locks by itself. ──
const scanKey = (account: string) => `bwx.tokenLocks.scanned.${account}`;

export function tokenLocksScanned(account: string): boolean {
  try {
    return !!localStorage.getItem(scanKey(account));
  } catch {
    return false;
  }
}

export function markTokenLocksScanned(account: string) {
  try {
    localStorage.setItem(scanKey(account), new Date().toISOString());
  } catch {
    // storage blocked: the next open scans again, which is harmless
  }
}

const backed = (cs: ChromeStorageService | undefined, account: string): TokenLockRecord[] => {
  const a = cs?.getAllAccounts().find((x) => x.addresses?.identityAddress === account);
  const list = a?.settings?.tokenLocks;
  return Array.isArray(list) ? (list as TokenLockRecord[]) : [];
};

export function loadTokenLocks(account: string, cs?: ChromeStorageService): TokenLockRecord[] {
  let local: TokenLockRecord[] = [];
  try {
    local = JSON.parse(localStorage.getItem(recKey(account)) || '[]') as TokenLockRecord[];
  } catch {
    local = [];
  }
  return mergeRecords(Array.isArray(local) ? local : [], backed(cs, account));
}

export function saveTokenLocks(account: string, list: TokenLockRecord[], cs?: ChromeStorageService) {
  try {
    localStorage.setItem(recKey(account), JSON.stringify(list));
  } catch {
    // storage blocked: the locks are on chain
  }
  const found = cs?.getAllAccounts().find((x) => x.addresses?.identityAddress === account);
  if (!cs || !found) return;
  const { address: _drop, ...acct } = found as typeof found & { address?: string };
  void cs
    .updateNested('accounts', {
      [account]: { ...acct, settings: { ...acct.settings, tokenLocks: list } },
    } as Parameters<typeof cs.updateNested<'accounts'>>[1])
    .catch(() => undefined);
}
