import { Beef, Hash, OP, Script, Utils, type MerklePath, type Transaction } from '@bsv/sdk';
import { expandChunks, isTokenId, MAP_PREFIX, normTokenId, verifyIssueTx } from '../../issuer/issuer';
import { checkBeef, GuardError } from './guard';

/**
 * "Check this mint": a verifier for bMint mints that trusts no server.
 *
 * Spec: docs/CHECK-THIS-MINT.md. The output contract (one verdict, a specific reason, never a quiet
 * pass) is modelled on Lightweb's bfinger (Apache-2.0); this is our own code.
 *
 * Everything below `verifyMintEvidence` is pure: it takes bytes and decides. `checkMint` (sources.ts)
 * only fetches those bytes from public services and hands them over.
 */

export type RefuseCode =
  | 'malformed' // BEEF / BUMP / transaction bytes fail the bounded walk or the parser
  | 'not-in-proof' // the BEEF does not hold the transaction the outpoint names
  | 'no-output' // the transaction has no such output
  | 'not-a-mint' // the output holds no 1Sat inscription
  | 'unsigned' // no bMint issuer signature in the transaction
  | 'bad-signature' // a signature is there but does not verify, or is for another output or key
  | 'content-mismatch' // the file you gave hashes to something other than what was minted
  | 'proof-mismatch' // the merkle path does not lead to the block header's merkle root
  | 'header-pow-invalid' // the header's hash is above its target, or its target is too easy
  | 'header-mismatch'; // header sources disagree, or a header is not for the proof's height

export interface MintFacts {
  outpoint: string;
  txid: string;
  vout: number;
  /** The identity key that signed (issuer statement, MAP + AIP). */
  identityKey: string;
  /** The AIP address that signed: the identity key's [2,'bwallet issuer'] child. */
  signer: string;
  contentType: string;
  contentBytes: number;
  /** sha256 of the inscribed bytes, hex. */
  contentSha256: string;
  /** MAP name the minter gave it, if any (a label, not a claim this check proves). */
  name: string | null;
  /** True: the file you gave matches. Null: no file given. (A mismatch is a REFUSED.) */
  fileMatch: boolean | null;
}

export interface BlockFacts {
  height: number;
  blockHash: string;
  /** Header timestamp, unix seconds (miners may set it up to ~2 hours off). */
  blockTime: number;
  /** Header sources that returned the same 80 bytes. */
  headerSources: string[];
}

export type Verdict =
  | ({ status: 'VERIFIED' } & MintFacts & BlockFacts)
  | ({ status: 'PENDING'; reason: string } & MintFacts)
  | { status: 'REFUSED'; code: RefuseCode; reason: string; outpoint?: string }
  | { status: 'UNREACHABLE'; reason: string; outpoint?: string };

export interface HeaderAnswer {
  source: string;
  height: number;
  /** The 80-byte block header. */
  raw: number[];
}

export interface Evidence {
  outpoint: string;
  /** BEEF holding the mint tx (and its BUMP once mined). */
  beef: Uint8Array | number[];
  /** Headers for the BUMP's height, one per source that answered. */
  headers: HeaderAnswer[];
  /** sha256 (hex) of a local file to compare with the inscribed bytes. */
  fileSha256?: string;
}

export interface Options {
  /** Header sources that must agree. Default 2. */
  minHeaderSources?: number;
}

const { toHex, toUTF8 } = Utils;

// ---------------------------------------------------------------- outpoints

/**
 * An outpoint from whatever someone pasted: `txid`, `txid_1`, `txid.1`, `txid:1`, or a link holding one
 * (`?o=…`, ORDFS `/content/<txid>_<n>`, a WhatsOnChain tx page). No vout means 0 (bMint's inscription
 * is output 0). Null when nothing usable is in it.
 */
export function parseOutpoint(input: string): string | null {
  const s = (input || '').trim();
  if (!s) return null;
  let text = s;
  if (/^https?:\/\//i.test(s))
    try {
      const u = new URL(s);
      const o = u.searchParams.get('o') || u.searchParams.get('outpoint');
      text = o ? o : decodeURIComponent(u.pathname + u.hash);
    } catch {
      /* not a URL after all */
    }
  const m = /(?<![0-9a-f])([0-9a-f]{64})(?:[_.:](\d{1,6}))?(?![0-9a-f])/i.exec(text);
  if (!m) return null;
  const id = `${m[1].toLowerCase()}_${Number(m[2] ?? 0)}`;
  return isTokenId(id) ? normTokenId(id) : null;
}

// ---------------------------------------------------------------- inscriptions

export interface Inscription {
  contentType: string;
  body: number[];
  name: string | null;
}

/** The 1Sat envelope (OP_FALSE OP_IF "ord" … OP_ENDIF) in a locking script, plus a MAP name after it. */
export function parseInscription(script: Script): Inscription | null {
  const ch = expandChunks(script);
  let at = -1;
  for (let i = 0; i + 2 < ch.length; i++) {
    if (ch[i].op === OP.OP_FALSE && ch[i + 1].op === OP.OP_IF && ch[i + 2].data && toUTF8(ch[i + 2].data!) === 'ord') {
      at = i + 3;
      break;
    }
  }
  if (at < 0) return null;
  let contentType = '';
  let body: number[] | null = null;
  let i = at;
  for (; i + 1 < ch.length && ch[i].op !== OP.OP_ENDIF; i += 2) {
    const t = ch[i];
    const tag =
      t.op === OP.OP_0 && !t.data?.length
        ? 0
        : t.op >= OP.OP_1 && t.op <= OP.OP_16
          ? t.op - OP.OP_1 + 1
          : t.data?.length === 1
            ? t.data[0]
            : -1;
    const v = ch[i + 1].data ?? [];
    if (tag === 0) body = v;
    else if (tag === 1) contentType = toUTF8(v);
  }
  if (body === null) return null;
  let name: string | null = null;
  for (let k = i; k + 2 < ch.length; k++) {
    if (ch[k].data && toUTF8(ch[k].data!) === MAP_PREFIX && toUTF8(ch[k + 1].data ?? []) === 'SET') {
      for (let j = k + 2; j + 1 < ch.length; j += 2) {
        const key = toUTF8(ch[j].data ?? []);
        if (key === '|') break;
        if (key === 'name') {
          name = toUTF8(ch[j + 1].data ?? []);
          break;
        }
      }
      break;
    }
  }
  return { contentType, body, name };
}

// ---------------------------------------------------------------- headers

/** Easiest target accepted: bits 0x1900ffff (difficulty ~4.3e9). Recent BSV blocks run ~37e9 (block 971,558: bits 0x181d2ca9). */
export const FLOOR_BITS = 0x1900ffff;

export function targetFromBits(bits: number): bigint {
  const exp = bits >>> 24;
  const mant = BigInt(bits & 0x007fffff);
  if (bits & 0x00800000) return 0n; // negative: invalid
  return exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
}

const le32 = (b: number[], at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

export interface ParsedHeader {
  hash: string;
  prevHash: string;
  merkleRoot: string;
  time: number;
  bits: number;
}

export function parseHeader(raw: number[]): ParsedHeader | null {
  if (raw.length !== 80) return null;
  return {
    hash: toHex(Hash.hash256(raw).reverse()),
    prevHash: toHex(raw.slice(4, 36).reverse()),
    merkleRoot: toHex(raw.slice(36, 68).reverse()),
    time: le32(raw, 68),
    bits: le32(raw, 72),
  };
}

/** Proof of work, checked here: hash ≤ target(bits) and target no easier than FLOOR_BITS. */
export function powOk(h: ParsedHeader): boolean {
  const target = targetFromBits(h.bits);
  if (target === 0n || target > targetFromBits(FLOOR_BITS)) return false;
  return BigInt('0x' + h.hash) <= target;
}

/** 80 header bytes from the fields a JSON block API reports (WhatsOnChain). The verifier re-hashes them. */
export function headerFromFields(f: {
  version: number;
  previousblockhash: string;
  merkleroot: string;
  time: number;
  bits: string;
  nonce: number;
}): number[] {
  const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  const rev = (hex: string) => Utils.toArray(hex, 'hex').reverse();
  return [
    ...u32(f.version >>> 0),
    ...rev(f.previousblockhash),
    ...rev(f.merkleroot),
    ...u32(f.time >>> 0),
    ...u32(parseInt(f.bits, 16) >>> 0),
    ...u32(f.nonce >>> 0),
  ];
}

// ---------------------------------------------------------------- the verdict

const refuse = (code: RefuseCode, reason: string, outpoint?: string): Verdict => ({
  status: 'REFUSED',
  code,
  reason,
  outpoint,
});

const SIG_REASONS: Record<string, string> = {
  'invalid signature': 'The signature does not verify.',
  'signature is not from the stated identity': 'The signature is not from the identity key it names.',
  'issuer signature is for another output': 'The signature in this transaction is for a different output.',
  'bad identity key': 'The signature names a malformed identity key.',
};

/**
 * Decide, from bytes alone. In order: bounded parse; the BEEF holds the tx; the output is an inscription;
 * the issuer signature verifies for this exact output; the file (if given) matches; the merkle path leads
 * to a header whose proof of work we check and that enough sources agree on. Signatures come before the
 * block proof, as bfinger orders them: never decide who should have signed and then look for a match.
 */
export function verifyMintEvidence(ev: Evidence, opts: Options = {}): Verdict {
  const outpoint = parseOutpoint(ev.outpoint);
  if (!outpoint) return refuse('malformed', 'That is not a mint link or transaction id.');
  const [txid, voutStr] = outpoint.split('_');
  const vout = Number(voutStr);

  let beef: Beef;
  try {
    checkBeef(ev.beef);
    beef = Beef.fromBinaryStrict(Array.from(ev.beef));
  } catch (e) {
    const why = e instanceof GuardError ? e.message : 'the BEEF does not parse';
    return refuse('malformed', `The proof bytes are malformed (${why}).`, outpoint);
  }
  const btx = beef.findTxid(txid);
  let tx: Transaction | undefined;
  try {
    tx = btx?.tx;
  } catch {
    tx = undefined;
  }
  if (!tx || tx.id('hex') !== txid)
    return refuse('not-in-proof', 'The proof does not contain this transaction.', outpoint);

  const out = tx.outputs[vout];
  if (!out) return refuse('no-output', `The transaction has no output ${vout}.`, outpoint);
  const ins = parseInscription(out.lockingScript);
  if (!ins) return refuse('not-a-mint', `Output ${vout} is not an inscription.`, outpoint);

  const sig = verifyIssueTx(tx, outpoint);
  if (!sig.ok) {
    if (sig.reason === 'no issuer signature')
      return refuse('unsigned', 'There is no bMint signature in this transaction, so nobody vouches for it.', outpoint);
    return refuse('bad-signature', SIG_REASONS[sig.reason] ?? `Bad signature (${sig.reason}).`, outpoint);
  }

  const contentSha256 = toHex(Hash.sha256(ins.body));
  let fileMatch: boolean | null = null;
  if (ev.fileSha256) {
    if (ev.fileSha256.toLowerCase() !== contentSha256)
      return refuse('content-mismatch', 'Your file is not the file that was minted (the hashes differ).', outpoint);
    fileMatch = true;
  }
  const facts: MintFacts = {
    outpoint,
    txid,
    vout,
    identityKey: sig.identityKey,
    signer: sig.address,
    contentType: ins.contentType,
    contentBytes: ins.body.length,
    contentSha256,
    name: ins.name,
    fileMatch,
  };

  let bump: MerklePath | undefined;
  try {
    bump = beef.findBump(txid);
  } catch {
    bump = undefined;
  }
  if (!bump)
    return {
      status: 'PENDING',
      reason: 'Signed, but not in a block yet. Check again in a few minutes.',
      ...facts,
    };
  let root: string;
  try {
    root = bump.computeRoot(txid);
  } catch {
    return refuse('proof-mismatch', 'The merkle proof does not include this transaction.', outpoint);
  }

  const need = Math.max(1, opts.minHeaderSources ?? 2);
  const forHeight = ev.headers.filter((h) => h.height === bump!.blockHeight);
  if (forHeight.length < ev.headers.length)
    return refuse('header-mismatch', `A header source answered for another height than ${bump.blockHeight}.`, outpoint);
  if (forHeight.length < need)
    return {
      status: 'UNREACHABLE',
      reason: `Only ${forHeight.length} of ${need} block-header sources answered for height ${bump.blockHeight}.`,
      outpoint,
    };
  const first = toHex(forHeight[0].raw);
  if (forHeight.some((h) => toHex(h.raw) !== first))
    return refuse('header-mismatch', `Header sources disagree about block ${bump.blockHeight}.`, outpoint);
  const header = parseHeader(forHeight[0].raw);
  if (!header) return refuse('malformed', 'A block header is not 80 bytes.', outpoint);
  if (!powOk(header))
    return refuse('header-pow-invalid', "The block header's proof of work does not check out.", outpoint);
  if (header.merkleRoot !== root)
    return refuse('proof-mismatch', "The merkle proof does not lead to the block's merkle root.", outpoint);

  return {
    status: 'VERIFIED',
    ...facts,
    height: bump.blockHeight,
    blockHash: header.hash,
    blockTime: header.time,
    headerSources: forHeight.map((h) => h.source),
  };
}

/** sha256 hex of a file's bytes, in the browser (the file never leaves the device). */
export async function sha256File(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return toHex(Array.from(new Uint8Array(await subtle.digest('SHA-256', buf))));
  return toHex(Hash.sha256(Array.from(new Uint8Array(buf))));
}
