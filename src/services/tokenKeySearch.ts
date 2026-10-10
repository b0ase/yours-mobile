/**
 * Find the keyID behind a token output the wallet owns but has no record of.
 *
 * @1sat/actions sendBsv21 sends token change to a key derived (BRC-42, self)
 * from keyID `${tokenId}-${Date.now()}`. The keyID lives only in wallet
 * storage, so a browser whose storage never saw the send cannot spend the
 * change, or even see it. The address is on chain, though, and the millisecond
 * clock value sits a little before the block that mined the transaction. This
 * walks candidate milliseconds in a window and returns the one whose derived
 * address matches.
 *
 * The derived public key is rootPub + HMAC(sharedSecret, invoice)·G. sharedSecret
 * is fixed for counterparty 'self', so each candidate costs one HMAC, one
 * fixed-base multiplication and one hash160. The multiplication uses a
 * precomputed 8-bit window table in native BigInt and batched inversion, which
 * is several times faster than a generic point multiply.
 *
 * Nothing here leaves the device; the private key is used only to derive the
 * shared secret and is never logged.
 */
import { Hash, PrivateKey, Utils } from '@bsv/sdk';

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

type Affine = { x: bigint; y: bigint };
type Jac = { x: bigint; y: bigint; z: bigint };

const mod = (a: bigint): bigint => {
  const r = a % P;
  return r < 0n ? r + P : r;
};

const powMod = (base: bigint, exp: bigint): bigint => {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
};

const inv = (a: bigint): bigint => powMod(a, P - 2n);

const INF: Jac = { x: 0n, y: 1n, z: 0n };

const jDouble = (p: Jac): Jac => {
  if (p.z === 0n || p.y === 0n) return INF;
  const ysq = (p.y * p.y) % P;
  const s = (4n * p.x * ysq) % P;
  const m = (3n * p.x * p.x) % P;
  const x = mod(m * m - 2n * s);
  const y = mod(m * (s - x) - 8n * ysq * ysq);
  const z = (2n * p.y * p.z) % P;
  return { x, y, z };
};

/** Jacobian + affine. */
const jAddAffine = (p: Jac, q: Affine): Jac => {
  if (p.z === 0n) return { x: q.x, y: q.y, z: 1n };
  const z2 = (p.z * p.z) % P;
  const u2 = (q.x * z2) % P;
  const s2 = (q.y * z2 * p.z) % P;
  const h = mod(u2 - p.x);
  const r = mod(s2 - p.y);
  if (h === 0n) return r === 0n ? jDouble(p) : INF;
  const h2 = (h * h) % P;
  const h3 = (h2 * h) % P;
  const u1h2 = (p.x * h2) % P;
  const x = mod(r * r - h3 - 2n * u1h2);
  const y = mod(r * (u1h2 - x) - p.y * h3);
  const z = (p.z * h) % P;
  return { x, y, z };
};

/** Normalise many Jacobian points with one inversion (Montgomery's trick). */
const batchToAffine = (pts: Jac[]): (Affine | null)[] => {
  const n = pts.length;
  const prefix: bigint[] = new Array(n);
  let acc = 1n;
  for (let i = 0; i < n; i++) {
    prefix[i] = acc;
    if (pts[i].z !== 0n) acc = (acc * pts[i].z) % P;
  }
  let accInv = inv(acc);
  const out: (Affine | null)[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const pt = pts[i];
    if (pt.z === 0n) {
      out[i] = null;
      continue;
    }
    const zInv = (accInv * prefix[i]) % P;
    accInv = (accInv * pt.z) % P;
    const zInv2 = (zInv * zInv) % P;
    out[i] = { x: (pt.x * zInv2) % P, y: (pt.y * zInv2 * zInv) % P };
  }
  return out;
};

const WINDOWS = 32;
let gTable: Affine[][] | null = null;

/** table[i][j] = j · 256^i · G, j in 1..255 (index 0 unused). */
const getTable = (): Affine[][] => {
  if (gTable) return gTable;
  const table: Affine[][] = [];
  let base: Affine = { x: GX, y: GY };
  for (let i = 0; i < WINDOWS; i++) {
    const row: Jac[] = [];
    let accJ: Jac = INF;
    for (let j = 1; j < 256; j++) {
      accJ = jAddAffine(accJ, base);
      row.push(accJ);
    }
    const affine = batchToAffine(row) as Affine[];
    table.push([base, ...affine]); // index 0 placeholder
    // next base = 256 · base = 255·base + base
    const next = batchToAffine([jAddAffine({ ...row[254] }, base)])[0] as Affine;
    base = next;
  }
  gTable = table;
  return table;
};

const bytesToBig = (b: number[] | Uint8Array): bigint => {
  let r = 0n;
  for (const v of b) r = (r << 8n) | BigInt(v);
  return r;
};

const bigTo32 = (v: bigint): number[] => {
  const out = new Array<number>(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};

/** rootPub + k·G in Jacobian form, k < n. */
const addMulG = (root: Affine, k: bigint): Jac => {
  const table = getTable();
  let acc: Jac = { x: root.x, y: root.y, z: 1n };
  let s = k;
  for (let i = 0; i < WINDOWS && s > 0n; i++) {
    const b = Number(s & 0xffn);
    s >>= 8n;
    if (b !== 0) acc = jAddAffine(acc, table[i][b]);
  }
  return acc;
};

export const hash160OfAffine = (pt: Affine): string => {
  const enc = [pt.y & 1n ? 3 : 2, ...bigTo32(pt.x)];
  return Utils.toHex(Hash.hash160(enc));
};

/** BRC-43 invoice number prefix, as KeyDeriver.computeInvoiceNumber builds it. */
export const invoicePrefixFor = (protocolID: [number, string]): string =>
  `${protocolID[0]}-${protocolID[1].toLowerCase().trim()}-`;

export interface KeySearchSetup {
  /** Shared secret (compressed) for counterparty 'self'. */
  secret: number[];
  /** Root public key, affine. */
  root: Affine;
  /** e.g. "0-onesat-" — the BRC-43 invoice prefix for the protocol. */
  invoicePrefix: string;
}

export const buildKeySearchSetup = (rootWif: string, invoicePrefix: string): KeySearchSetup => {
  const priv = PrivateKey.fromWif(rootWif);
  const pub = priv.toPublicKey();
  const secret = priv.deriveSharedSecret(pub).encode(true) as number[];
  const root = { x: BigInt(`0x${pub.getX().toHex(32)}`), y: BigInt(`0x${pub.getY().toHex(32)}`) };
  return { secret, root, invoicePrefix };
};

/** hash160 of the key derived for one keyID (the slow path, for checks and tests). */
export const derivedHash160 = (setup: KeySearchSetup, keyID: string): string => {
  const h = bytesToBig(Hash.sha256hmac(setup.secret, Utils.toArray(setup.invoicePrefix + keyID, 'utf8')));
  const [pt] = batchToAffine([addMulG(setup.root, h % N)]);
  return pt ? hash160OfAffine(pt) : '';
};

export interface MsSearchArgs {
  setup: KeySearchSetup;
  /** keyID = keyIDPrefix + ms, e.g. `${tokenId}-` */
  keyIDPrefix: string;
  /** hash160 hex values to look for. */
  targets: Set<string>;
  fromMs: number;
  toMs: number;
  /** Candidates per batch between yields. */
  batch?: number;
  /** Called between batches; return false to stop. */
  onProgress?: (doneMs: number, totalMs: number) => boolean | void;
  /** Yield to the event loop between batches (default: setTimeout 0). */
  yieldFn?: () => Promise<void>;
}

export interface MsSearchHit {
  hash160: string;
  keyID: string;
}

/**
 * Walk every millisecond in [fromMs, toMs] (inclusive), newest first, and return
 * the keyIDs whose derived address is one of `targets`. Stops early once every
 * target is found.
 */
export const searchMsKeyIDs = async (args: MsSearchArgs): Promise<MsSearchHit[]> => {
  const { setup, keyIDPrefix, targets, fromMs, toMs } = args;
  const batch = args.batch ?? 512;
  const yieldFn = args.yieldFn ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  const prefixBytes = Utils.toArray(setup.invoicePrefix + keyIDPrefix, 'utf8');
  const remaining = new Set(targets);
  const hits: MsSearchHit[] = [];
  const total = toMs - fromMs + 1;
  let ms = toMs;
  while (ms >= fromMs && remaining.size > 0) {
    const stop = Math.max(fromMs, ms - batch + 1);
    const pts: Jac[] = [];
    const ids: number[] = [];
    for (let t = ms; t >= stop; t--) {
      const msg = prefixBytes.concat(Utils.toArray(String(t), 'utf8'));
      const h = bytesToBig(Hash.sha256hmac(setup.secret, msg)) % N;
      pts.push(addMulG(setup.root, h));
      ids.push(t);
    }
    const aff = batchToAffine(pts);
    for (let i = 0; i < aff.length; i++) {
      const a = aff[i];
      if (!a) continue;
      const h160 = hash160OfAffine(a);
      if (remaining.has(h160)) {
        remaining.delete(h160);
        hits.push({ hash160: h160, keyID: keyIDPrefix + String(ids[i]) });
      }
    }
    ms = stop - 1;
    if (args.onProgress?.(toMs - ms, total) === false) break;
    await yieldFn();
  }
  return hits;
};
