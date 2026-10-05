/**
 * The "mint" scope of a paired bWalletX CLI: limits chosen on the phone at pairing (how many items,
 * how many dollars at most), what has been used, and the encrypted-channel upload buffer that carries
 * files bigger than one relay frame (relay maxFrame = 4 MB; sealed frames grow base64 twice).
 * Pure apart from crypto.subtle; the handler is in agentPairing.ts.
 */
import { MAX_MINT_BYTES } from '../mint/mint';

export const MAX_MINT_ITEMS = 500;
export const MAX_MINT_USD = 100;

export type MintRecord = {
  at: number;
  name: string;
  txid: string;
  outpoint: string;
  usd: number;
  collectionId?: string;
};
export type MintLimits = {
  maxItems: number;
  maxUsd: number;
  items: number;
  spentUsd: number;
  /** Newest first, at most 50: shown under the pairing in Settings › Paired websites. */
  recent: MintRecord[];
};

export class MintLimitError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(Number.isFinite(v) ? v : lo, lo), hi);

export const makeMintLimits = (maxItems: number, maxUsd: number): MintLimits => ({
  maxItems: Math.round(clamp(maxItems, 1, MAX_MINT_ITEMS)),
  maxUsd: Math.round(clamp(maxUsd, 0.01, MAX_MINT_USD) * 100) / 100,
  items: 0,
  spentUsd: 0,
  recent: [],
});

export const usd2 = (n: number) => `$${n.toFixed(2)}`;
export const describeMintLimits = (l: Pick<MintLimits, 'maxItems' | 'maxUsd'>) =>
  `This computer may mint up to ${l.maxItems} item${l.maxItems === 1 ? '' : 's'}, spending at most ${usd2(l.maxUsd)}.`;

export const remaining = (l: MintLimits) => ({
  items: Math.max(0, l.maxItems - l.items),
  usd: Math.max(0, Math.round((l.maxUsd - l.spentUsd) * 1e6) / 1e6),
});

/** Refuse BEFORE signing when this mint would go over the count or the dollar budget. */
export function checkMintBudget(l: MintLimits | undefined, estUsd: number | null): void {
  if (!l) throw new MintLimitError('SCOPE', "This pairing isn't allowed to mint. Pair again and turn on “Mint NFTs”.");
  if (estUsd === null || !(estUsd >= 0))
    throw new MintLimitError(
      'NO_PRICE',
      'bWalletX has no BSV price right now, so it can’t check the mint budget. Try again shortly.',
    );
  const r = remaining(l);
  if (r.items < 1)
    throw new MintLimitError(
      'LIMIT',
      `Mint limit reached: ${l.items} of ${l.maxItems} items used. Pair again for more.`,
    );
  if (estUsd > r.usd)
    throw new MintLimitError(
      'BUDGET',
      `Over budget: this mint costs about ${usd2(estUsd)} but only ${usd2(r.usd)} of ${usd2(l.maxUsd)} is left. Pair again with a bigger budget.`,
    );
}

/** After broadcast: count the item and the actual dollars spent. */
export const recordMint = (l: MintLimits, rec: MintRecord): MintLimits => ({
  ...l,
  items: l.items + 1,
  spentUsd: Math.round((l.spentUsd + rec.usd) * 1e6) / 1e6,
  recent: [rec, ...l.recent].slice(0, 50),
});

// ---- Chunked upload over the encrypted channel ----

/** Raw bytes per chunk the CLI sends (a multiple of 3, so base64 chunks concatenate cleanly). */
export const UPLOAD_CHUNK_BYTES = 1_572_864; // 1.5 MiB → ~2.7 MB sealed frame, under the relay's 4 MB
const UPLOAD_TTL_MS = 15 * 60_000;
const MAX_UPLOADS = 2;

type Upload = { bytes: number; sha256: string; total: number; parts: (string | undefined)[]; at: number };
const b64Len = (bytes: number) => Math.ceil(bytes / 3) * 4;
const decodedLen = (b64: string) => (b64.length / 4) * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

export class UploadStore {
  private m = new Map<string, Upload>();
  constructor(private now: () => number = Date.now) {}

  private sweep() {
    for (const [k, u] of this.m) if (this.now() - u.at > UPLOAD_TTL_MS) this.m.delete(k);
  }

  /** One chunk. Chunk 0 declares the size and hash; the whole file must fit the 10 MB mint limit. */
  put(p: { uploadId: unknown; index: unknown; total: unknown; bytes: unknown; sha256: unknown; data: unknown }) {
    this.sweep();
    const id = String(p.uploadId ?? '');
    const index = Number(p.index);
    const total = Number(p.total);
    const bytes = Number(p.bytes);
    const sha = String(p.sha256 ?? '').toLowerCase();
    const data = String(p.data ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new MintLimitError('INVALID', 'Bad upload id');
    if (!(bytes > 0) || bytes > MAX_MINT_BYTES)
      throw new MintLimitError('TOO_BIG', 'Files must be under 10 MB to mint.');
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new MintLimitError('INVALID', 'Bad sha256');
    const want = Math.ceil(bytes / UPLOAD_CHUNK_BYTES);
    if (total !== want || !Number.isInteger(index) || index < 0 || index >= total)
      throw new MintLimitError('INVALID', 'Bad chunk numbering');
    const last = index === total - 1;
    const expect = last ? b64Len(bytes - UPLOAD_CHUNK_BYTES * (total - 1)) : b64Len(UPLOAD_CHUNK_BYTES);
    if (data.length !== expect || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || (!last && data.includes('=')))
      throw new MintLimitError('INVALID', 'Bad chunk data');
    let u = this.m.get(id);
    if (!u) {
      if (this.m.size >= MAX_UPLOADS) throw new MintLimitError('BUSY', 'Too many uploads at once');
      u = { bytes, sha256: sha, total, parts: Array.from({ length: total }, () => undefined), at: this.now() };
      this.m.set(id, u);
    } else if (u.bytes !== bytes || u.sha256 !== sha || u.total !== total)
      throw new MintLimitError('INVALID', 'Upload changed');
    u.parts[index] = data;
    u.at = this.now();
    return { received: u.parts.filter(Boolean).length, total };
  }

  /** The complete file as base64, checked against its declared size and SHA-256; removes it. */
  async take(uploadId: unknown): Promise<string> {
    this.sweep();
    const id = String(uploadId ?? '');
    const u = this.m.get(id);
    if (!u)
      throw new MintLimitError('NO_UPLOAD', 'Upload not found (it expires after 15 minutes). Send the file again.');
    if (u.parts.some((x) => x === undefined))
      throw new MintLimitError('INCOMPLETE', 'Upload incomplete. Send the file again.');
    this.m.delete(id);
    const b64 = u.parts.join('');
    if (decodedLen(b64) !== u.bytes) throw new MintLimitError('INVALID', 'Upload size mismatch');
    if ((await sha256Hex(b64)) !== u.sha256) throw new MintLimitError('INVALID', 'Upload hash mismatch');
    return b64;
  }
}

export async function sha256Hex(b64: string): Promise<string> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}
