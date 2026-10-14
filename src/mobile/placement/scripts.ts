// bCorp share placement: pure locking-script builders (no network, no keys held).
//
// Share token lock — two spend paths:
//   OP_IF   <1Sat Lock: investor PKH, until height>        (investor alone, after the timelock)
//   OP_ELSE OP_2 <directorPub> <investorPub> OP_2 OP_CHECKMULTISIG   (2-of-2, any time)
//   OP_ENDIF
//
// BSV has no live OP_CHECKLOCKTIMEVERIFY after Genesis (it is OP_NOP2), so the
// timelock path reuses the audited 1Sat Lock contract (OP_PUSH_TX: it reads
// nLockTime from the sighash preimage and refuses a final nSequence). That is
// the same script bWalletX already uses for non-custodial locks.
//
// Treasury: bare m-of-n multisig, OP_m <pk1..pkn> OP_n OP_CHECKMULTISIG.

import { Lock } from '@1sat/templates';
import {
  Hash,
  LockingScript,
  OP,
  P2PKH,
  PublicKey,
  Script,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type PrivateKey,
  type Transaction,
} from '@bsv/sdk';
import { BLOCKS_PER_DAY } from '../locks/schedule';

export const DEFAULT_LOCK_MONTHS = 12;
export const MAX_TREASURY_KEYS = 15;

const smallInt = (n: number) => {
  if (n < 1 || n > 16) throw new Error('multisig counts must be 1–16');
  return OP.OP_1 + n - 1;
};

/** Block height ~`months` from now (30.44 days a month, 144 blocks a day). */
export function unlockHeightAfterMonths(currentHeight: number, months = DEFAULT_LOCK_MONTHS): number {
  if (!Number.isFinite(months) || months <= 0 || months > 120) throw new Error('lock months must be 1–120');
  if (!Number.isInteger(currentHeight) || currentHeight <= 0) throw new Error('current height required');
  return currentHeight + Math.ceil(months * 30.44 * BLOCKS_PER_DAY);
}

function pubHex(k: PublicKey | string): string {
  const pk = typeof k === 'string' ? PublicKey.fromString(k) : k;
  return pk.toString();
}

export type ShareLockParams = {
  directorPubKey: PublicKey | string;
  investorPubKey: PublicKey | string;
  /** Block height (< 500,000,000) after which the investor alone may spend. */
  unlockHeight: number;
  /** Optional 1Sat inscription / $403 token envelope written in front of the lock. */
  prefix?: Script;
  mainnet?: boolean;
};

export function shareLock(p: ShareLockParams): LockingScript {
  if (!Number.isInteger(p.unlockHeight) || p.unlockHeight <= 0 || p.unlockHeight >= 500_000_000)
    throw new Error('unlockHeight must be a block height');
  const d = pubHex(p.directorPubKey);
  const i = pubHex(p.investorPubKey);
  if (d === i) throw new Error('director and investor keys must differ');
  const investorAddr = PublicKey.fromString(i).toAddress(p.mainnet === false ? 'testnet' : 'mainnet');
  const s = new Script();
  if (p.prefix) s.writeScript(p.prefix);
  s.writeOpCode(OP.OP_IF)
    .writeScript(Lock.lock(investorAddr, p.unlockHeight))
    .writeOpCode(OP.OP_ELSE)
    .writeOpCode(OP.OP_2)
    .writeBin(Utils.toArray(d, 'hex'))
    .writeBin(Utils.toArray(i, 'hex'))
    .writeOpCode(OP.OP_2)
    .writeOpCode(OP.OP_CHECKMULTISIG)
    .writeOpCode(OP.OP_ENDIF);
  return new LockingScript(s.chunks);
}

/** Reads the parameters back out of a share lock (null when it isn't one). */
export function parseShareLock(
  script: Script,
): { directorPubKey: string; investorPubKey: string; unlockHeight: number } | null {
  const c = script.chunks;
  // The 2-of-2 tail may be followed by inscription MAP data, so find it rather than reading from the end.
  let e = -1;
  for (let j = 6; j < c.length; j++) {
    if (
      c[j].op === OP.OP_ENDIF &&
      c[j - 1].op === OP.OP_CHECKMULTISIG &&
      c[j - 2].op === OP.OP_2 &&
      c[j - 5].op === OP.OP_2 &&
      c[j - 6].op === OP.OP_ELSE &&
      c[j - 4].data?.length === 33 &&
      c[j - 3].data?.length === 33
    ) {
      e = j;
      break;
    }
  }
  if (e < 0) return null;
  const d = c[e - 4].data!;
  const i = c[e - 3].data!;
  const decoded = Lock.decode(script);
  if (!decoded) return null;
  const investorPubKey = Utils.toHex(i);
  if (PublicKey.fromString(investorPubKey).toAddress() !== decoded.address) return null;
  return { directorPubKey: Utils.toHex(d), investorPubKey, unlockHeight: decoded.until };
}

/** Wallet label: "bCorp shares · N · locked 2-of-2" (or "· unlocked" once the investor may move them alone). */
export function shareLabel(shares: number, unlockHeight: number, currentHeight: number): string {
  const n = shares.toLocaleString('en-GB');
  return currentHeight >= unlockHeight ? `bCorp shares · ${n} · unlocked` : `bCorp shares · ${n} · locked 2-of-2`;
}

export function treasuryLock(m: number, pubKeys: (PublicKey | string)[]): LockingScript {
  const keys = pubKeys.map(pubHex);
  if (keys.length < 1 || keys.length > MAX_TREASURY_KEYS) throw new Error(`treasury needs 1–${MAX_TREASURY_KEYS} keys`);
  if (new Set(keys).size !== keys.length) throw new Error('treasury keys must be distinct');
  if (!Number.isInteger(m) || m < 1 || m > keys.length) throw new Error('m must be 1..n');
  const s = new Script().writeOpCode(smallInt(m));
  for (const k of keys) s.writeBin(Utils.toArray(k, 'hex'));
  s.writeOpCode(smallInt(keys.length)).writeOpCode(OP.OP_CHECKMULTISIG);
  return new LockingScript(s.chunks);
}

// ── unlocking ────────────────────────────────────────────────────────────────

type Signer = (tx: Transaction, inputIndex: number) => Promise<number[]>;
const SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID;

function sourceOf(tx: Transaction, inputIndex: number) {
  const input = tx.inputs[inputIndex];
  const out = input.sourceTransaction?.outputs[input.sourceOutputIndex];
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex');
  if (!out || !sourceTXID) throw new Error('input needs its source transaction');
  return { input, out, sourceTXID };
}

/** Checksig signature (DER + sighash byte) for one input, from a local key (tests / CLI). */
export function keySigner(key: PrivateKey): Signer {
  return async (tx, inputIndex) => {
    const { input, out, sourceTXID } = sourceOf(tx, inputIndex);
    const preimage = TransactionSignature.format({
      sourceTXID,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: out.satoshis!,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== inputIndex),
      outputs: tx.outputs,
      inputIndex,
      subscript: out.lockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
      scope: SCOPE,
    });
    const sig = key.sign(Hash.sha256(preimage), undefined, true);
    return new TransactionSignature(sig.r, sig.s, SCOPE).toChecksigFormat();
  };
}

/** Multisig unlock: OP_0 <sig1> … <sigm> (signers in key order). `branch` adds the OP_ELSE selector. */
export function multisigUnlock(signers: Signer[], branch = false) {
  return {
    sign: async (tx: Transaction, inputIndex: number) => {
      const s = new Script().writeOpCode(OP.OP_0);
      for (const sign of signers) s.writeBin(await sign(tx, inputIndex));
      if (branch) s.writeOpCode(OP.OP_0);
      return new UnlockingScript(s.chunks);
    },
    estimateLength: async () => 1 + signers.length * 73 + (branch ? 1 : 0),
  };
}

/** 2-of-2 path: director then investor signature. */
export const shareUnlock2of2 = (director: Signer, investor: Signer) => multisigUnlock([director, investor], true);

/** Investor-alone path after the timelock: 1Sat Lock unlock + OP_1 selector. tx.lockTime must be >= unlockHeight and nSequence < 0xffffffff. */
export function shareUnlockAfterTimelock(investor: PrivateKey) {
  const inner = Lock.unlock(investor);
  return {
    sign: async (tx: Transaction, inputIndex: number) => {
      const s = await inner.sign(tx, inputIndex);
      s.writeOpCode(OP.OP_1);
      return new UnlockingScript(s.chunks);
    },
    estimateLength: async () => 1100,
  };
}

export const p2pkhFor = (pub: PublicKey | string) => new P2PKH().lock(PublicKey.fromString(pubHex(pub)).toAddress());
