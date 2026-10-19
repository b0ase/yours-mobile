/**
 * Bounded walks over untrusted transaction, BUMP and BEEF bytes, run BEFORE @bsv/sdk parses them.
 *
 * The idea (not the code) comes from Lightweb's bcommon `guard` package (Apache-2.0): a walk that
 * allocates nothing, refuses any declared count or length that overruns the bytes actually present,
 * refuses trailing bytes, and holds counts to limits, so the SDK is never asked to allocate more than
 * the input holds. It is a structural check only; whether the proofs prove anything is decided later.
 */

export interface Limits {
  /** Largest input accepted at all, in bytes. */
  bytes: number;
  transactions: number;
  bumps: number;
  inputs: number;
  outputs: number;
  /** Longest single script, in bytes. */
  script: number;
  /** Merkle tree height (a block of 2^64 txs does not exist). */
  treeHeight: number;
  /** Leaves on one BUMP level. */
  leaves: number;
}

/** Far above any real bMint mint (one inscription ≤ ~10 MB, a few inputs) and far below what hurts a phone. */
export const DEFAULT_LIMITS: Limits = {
  bytes: 64 << 20,
  transactions: 10_000,
  bumps: 10_000,
  inputs: 10_000,
  outputs: 10_000,
  script: 32 << 20,
  treeHeight: 64,
  leaves: 1 << 20,
};

export class GuardError extends Error {
  constructor(what: string, msg: string) {
    super(`${what}: ${msg}`);
    this.name = 'GuardError';
  }
}

class Walker {
  i = 0;
  constructor(
    readonly b: Uint8Array,
    readonly what: string,
  ) {}
  fail(msg: string): never {
    throw new GuardError(this.what, `${msg} at byte ${this.i}`);
  }
  need(n: number) {
    if (n < 0 || this.i + n > this.b.length) this.fail(`needs ${n} more bytes, ${this.b.length - this.i} left`);
  }
  skip(n: number) {
    this.need(n);
    this.i += n;
  }
  u8(): number {
    this.need(1);
    return this.b[this.i++];
  }
  u32(): number {
    this.need(4);
    const v = this.b[this.i] | (this.b[this.i + 1] << 8) | (this.b[this.i + 2] << 16) | (this.b[this.i + 3] << 24);
    this.i += 4;
    return v >>> 0;
  }
  /** Bitcoin varint; values above 2^53 are refused (no real count is that large). */
  varint(): number {
    const p = this.u8();
    if (p < 0xfd) return p;
    const n = p === 0xfd ? 2 : p === 0xfe ? 4 : 8;
    this.need(n);
    let v = 0;
    for (let k = n - 1; k >= 0; k--) v = v * 256 + this.b[this.i + k];
    this.i += n;
    if (!Number.isSafeInteger(v)) this.fail('varint too large');
    return v;
  }
  /** A count that must fit both its limit and the bytes left (each item is at least `minBytes`). */
  count(label: string, limit: number, minBytes: number): number {
    const n = this.varint();
    if (n > limit) this.fail(`declares ${n} ${label}, the limit is ${limit}`);
    if (n * minBytes > this.b.length - this.i) this.fail(`declares ${n} ${label}, the bytes hold fewer`);
    return n;
  }
  end() {
    if (this.i !== this.b.length) this.fail(`${this.b.length - this.i} trailing bytes`);
  }
}

function walkTx(w: Walker, l: Limits) {
  w.skip(4); // version
  // Smallest input: 32 + 4 + 1 + 4; smallest output: 8 + 1.
  const ins = w.count('inputs', l.inputs, 41);
  if (ins === 0) w.fail('a transaction with no inputs (or an extended-format marker) is refused');
  for (let k = 0; k < ins; k++) {
    w.skip(36);
    const s = w.varint();
    if (s > l.script) w.fail(`unlocking script of ${s} bytes, the limit is ${l.script}`);
    w.skip(s);
    w.skip(4);
  }
  const outs = w.count('outputs', l.outputs, 9);
  for (let k = 0; k < outs; k++) {
    w.skip(8);
    const s = w.varint();
    if (s > l.script) w.fail(`locking script of ${s} bytes, the limit is ${l.script}`);
    w.skip(s);
  }
  w.skip(4); // locktime
}

function walkBump(w: Walker, l: Limits) {
  w.varint(); // block height
  const height = w.u8();
  if (height === 0 || height > l.treeHeight) w.fail(`tree height ${height}`);
  for (let lev = 0; lev < height; lev++) {
    const n = w.count('leaves', l.leaves, 2);
    for (let k = 0; k < n; k++) {
      w.varint(); // offset
      const flags = w.u8();
      if (flags > 3) w.fail(`leaf flags ${flags}`);
      if (!(flags & 1)) w.skip(32);
    }
  }
}

const asBytes = (b: Uint8Array | number[]) => (b instanceof Uint8Array ? b : Uint8Array.from(b));

function sized(b: Uint8Array | number[], what: string, l: Limits): Uint8Array {
  const u = asBytes(b);
  if (u.length === 0) throw new GuardError(what, 'empty');
  if (u.length > l.bytes) throw new GuardError(what, `${u.length} bytes, the limit is ${l.bytes}`);
  return u;
}

/** Throws GuardError unless `raw` is exactly one well-formed transaction within limits. */
export function checkTx(raw: Uint8Array | number[], l: Limits = DEFAULT_LIMITS): void {
  const w = new Walker(sized(raw, 'transaction', l), 'transaction');
  walkTx(w, l);
  w.end();
}

/** Throws GuardError unless `raw` is exactly one well-formed BUMP (BRC-74) within limits. */
export function checkBump(raw: Uint8Array | number[], l: Limits = DEFAULT_LIMITS): void {
  const w = new Walker(sized(raw, 'BUMP', l), 'BUMP');
  walkBump(w, l);
  w.end();
}

const BEEF_V1 = 4022206465; // 0100BEEF read little-endian
const BEEF_V2 = 4022206466; // 0200BEEF
const ATOMIC = 0x01010101;

/**
 * Throws GuardError unless `raw` is a well-formed BEEF V1 (BRC-62), V2 (BRC-96) or Atomic BEEF (BRC-95)
 * around either, within limits: every count and length fits the bytes, every bump index names a BUMP,
 * nothing trails. Returns the BEEF version seen.
 */
export function checkBeef(raw: Uint8Array | number[], l: Limits = DEFAULT_LIMITS): 1 | 2 {
  const w = new Walker(sized(raw, 'BEEF', l), 'BEEF');
  let ver = w.u32();
  if (ver === ATOMIC) {
    w.skip(32);
    ver = w.u32();
  }
  if (ver !== BEEF_V1 && ver !== BEEF_V2) w.fail(`unknown version ${ver.toString(16)}`);
  // Smallest BUMP: height, tree height, one level count.
  const bumps = w.count('BUMPs', l.bumps, 3);
  for (let k = 0; k < bumps; k++) walkBump(w, l);
  // Smallest transaction: 4 + 1 + 41 + 1 + 4.
  const txs = w.count('transactions', l.transactions, 51);
  if (txs === 0) w.fail('a BEEF of no transactions is refused');
  for (let k = 0; k < txs; k++) {
    if (ver === BEEF_V1) {
      walkTx(w, l);
      if (w.u8()) {
        const idx = w.varint();
        if (idx >= bumps) w.fail(`bump index ${idx} of ${bumps}`);
      }
    } else {
      const fmt = w.u8();
      if (fmt === 2) {
        w.skip(32);
        continue;
      }
      if (fmt > 2) w.fail(`transaction format ${fmt}`);
      if (fmt === 1) {
        const idx = w.varint();
        if (idx >= bumps) w.fail(`bump index ${idx} of ${bumps}`);
      }
      walkTx(w, l);
    }
  }
  w.end();
  return ver === BEEF_V1 ? 1 : 2;
}
