/**
 * Pre-signed payments — slot locking script (docs/PRESIGNED-PAYMENTS.md §1.3, §1.4).
 *
 *   [BSV-21 transfer envelope]           (token slots only)
 *   OP_IF
 *       <S> OP_CHECKSIGVERIFY <P> OP_CHECKSIG                    claim: service + payer
 *   OP_ELSE
 *       <LOCK_PREFIX> <HASH160(R)> <T> <LOCK_SUFFIX>              refund: 1Sat Lock covenant
 *   OP_ENDIF
 */
import { Lock, buildInscriptionScript } from '@1sat/templates';
import { BSV21 } from '@1sat/templates';
import { LockingScript, OP, type PublicKey, Script, Utils } from '@bsv/sdk';

export interface Bsv21Transfer {
  /** token id, e.g. `8353…98804_0` */
  id: string;
  /** whole-unit amount as a decimal string or bigint */
  amt: bigint;
}

export interface SlotParams {
  S: PublicKey;
  P: PublicKey;
  /** refund key R (only its HASH160 goes on chain, inside the Lock branch) */
  R: PublicKey;
  /** refund height T: the payer alone can spend at nLockTime ≥ T */
  until: number;
  token?: Bsv21Transfer;
}

/** The SCAM token used by Named Invites and the §8 proof. */
export const SCAM_TOKEN_ID = '8353949b27e8e16025702ce2b5d9b1ac2dad56d725eb2a38761974a857d98804_0';

/** Highest block height a Lock may use (nLockTime below 500M means a height). */
export const MAX_HEIGHT = 499_999_999;

export function transferContent(t: Bsv21Transfer): Uint8Array {
  if (t.amt <= 0n) throw new Error('presign: token amount must be positive');
  const json = JSON.stringify({ p: 'bsv-20', op: 'transfer', id: t.id, amt: t.amt.toString() });
  return Uint8Array.from(Utils.toArray(json, 'utf8'));
}

/** Prefix any lock with a BSV-21 transfer envelope (envelope first, as indexers expect). */
export function withTransfer(lock: Script, t: Bsv21Transfer): LockingScript {
  return new LockingScript(
    buildInscriptionScript(lock as LockingScript, transferContent(t), 'application/bsv-20').chunks,
  );
}

/** The bare two-branch lock, without any envelope. */
export function slotCore(p: Omit<SlotParams, 'token'>): Script {
  if (!Number.isInteger(p.until) || p.until < 1 || p.until > MAX_HEIGHT) {
    throw new Error('presign: refund height must be a block height');
  }
  const refund = Lock.lock(p.R.toAddress(), p.until);
  const s = new Script();
  s.writeOpCode(OP.OP_IF);
  s.writeBin(p.S.encode(true) as number[]);
  s.writeOpCode(OP.OP_CHECKSIGVERIFY);
  s.writeBin(p.P.encode(true) as number[]);
  s.writeOpCode(OP.OP_CHECKSIG);
  s.writeOpCode(OP.OP_ELSE);
  for (const c of refund.chunks) s.chunks.push(c);
  s.writeOpCode(OP.OP_ENDIF);
  return s;
}

export function slotLockingScript(p: SlotParams): LockingScript {
  const core = slotCore(p);
  return p.token ? withTransfer(core, p.token) : new LockingScript(core.chunks);
}

export interface DecodedSlot {
  S: string;
  P: string;
  /** refund address (base58) */
  refundAddress: string;
  until: number;
  token?: { id: string; amt: bigint };
}

/** Find the slot core inside a script (after any envelope) and read it back. */
export function decodeSlot(script: Script): DecodedSlot | null {
  const ch = script.chunks;
  // skip a leading `OP_FALSE OP_IF … OP_ENDIF` envelope
  let i = 0;
  if (ch[0]?.op === OP.OP_FALSE && ch[1]?.op === OP.OP_IF) {
    i = 2;
    while (i < ch.length && ch[i].op !== OP.OP_ENDIF) i++;
    i++;
  }
  const c = ch.slice(i);
  if (c.length < 8) return null;
  if (
    c[0].op !== OP.OP_IF ||
    c[2].op !== OP.OP_CHECKSIGVERIFY ||
    c[4].op !== OP.OP_CHECKSIG ||
    c[5].op !== OP.OP_ELSE
  ) {
    return null;
  }
  if (c[c.length - 1].op !== OP.OP_ENDIF) return null;
  const S = c[1].data;
  const P = c[3].data;
  if (S?.length !== 33 || P?.length !== 33) return null;
  const lock = Lock.decode(new Script(c.slice(6, -1)));
  if (!lock) return null;
  const out: DecodedSlot = {
    S: Utils.toHex(S),
    P: Utils.toHex(P),
    refundAddress: lock.address,
    until: lock.until,
  };
  const tok = BSV21.decode(script);
  if (tok && tok.tokenData.op === 'transfer' && tok.tokenData.id) {
    out.token = { id: tok.tokenData.id, amt: tok.getAmount() };
  }
  return out;
}

/** BSV-21 transfer carried by any output script, or null. */
export function tokenOf(script: Script): { id: string; amt: bigint } | null {
  const tok = BSV21.decode(script);
  if (!tok || tok.tokenData.op !== 'transfer' || !tok.tokenData.id) return null;
  return { id: tok.tokenData.id, amt: tok.getAmount() };
}
