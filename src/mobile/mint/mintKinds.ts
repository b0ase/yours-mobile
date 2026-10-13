/**
 * Mint by type (owner, 13 Oct 2026): the media mint asks "Picture / Music / Video / 3D" first, then shows the
 * fields for that type. Pure helpers (no DOM) so they are unit-tested in mintKinds.test.ts.
 *
 * Metadata (MAP, 1Sat conventions): every mint keeps `app`, `type: 'ord'`, `name` (+ `description`). Type fields:
 *   kind      picture | music | video | 3d
 *   artist, album, track          music only (same field names bMusic's indexer reads: title/artist/album)
 *   edition   "1/1" for a one-off; "1/N" … "N/N" style is the vout+1 of N identical outputs (see planEditions)
 *   editions  N (only when N > 1)
 *   price     the creator's "original" price in sats (informational; nothing is listed for sale)
 *   poster    "_<vout>": a companion image inscription in the SAME tx (cover art, video frame, 3D still).
 *             ORDFS serves it at /content/<txid>_<vout>; readers resolve "_n" against the item's own txid.
 *
 * Editions (1 of N): N identical inscription outputs in one transaction when the whole tx stays small
 * (N × bytes ≤ EDITION_INLINE_MAX_BYTES and N ≤ EDITION_INLINE_MAX); each is its own 1Sat origin, all locked to
 * the minter, and the one issuer signature covers them all (same script hash). Above that, ONE inscription with
 * `editions: N` metadata: a numbered master, never N copies of a big file (would multiply the fee by N).
 */

export type MintKind = 'picture' | 'music' | 'video' | '3d';

export const MINT_KINDS: { id: MintKind; label: string; accept: string; hint: string }[] = [
  { id: 'picture', label: 'Picture', accept: 'image/*', hint: 'an image' },
  { id: 'music', label: 'Music', accept: 'audio/*', hint: 'an audio file' },
  { id: 'video', label: 'Video', accept: 'video/*', hint: 'a video' },
  {
    id: '3d',
    label: '3D',
    accept: '.glb,.gltf,.usdz,model/gltf-binary,model/gltf+json,model/vnd.usdz+zip',
    hint: 'a .glb, .gltf or .usdz model',
  },
];

export const MB = 1024 * 1024;
/** Video and 3D may be up to 50 MB (the 1Sat single-inscription ceiling); everything else stays at 10 MB. */
export const BIG_MINT_BYTES = 50 * MB;
export const SMALL_MINT_BYTES = 10 * MB;
/** Above this, warn that the mint may take a few minutes to land (it shows as Pending until then). */
export const SLOW_LAND_BYTES = 10 * MB;

export const maxBytesFor = (kind: MintKind | null | undefined) =>
  kind === 'video' || kind === '3d' ? BIG_MINT_BYTES : SMALL_MINT_BYTES;

export const slowLandWarning = (bytes: number) =>
  bytes > SLOW_LAND_BYTES
    ? 'This is a big file: it may take a few minutes to land. It shows as Pending until then.'
    : '';

export const MODEL_TYPES = ['model/gltf-binary', 'model/gltf+json', 'model/vnd.usdz+zip'] as const;
export type ModelType = (typeof MODEL_TYPES)[number];
export const isModelType = (t: string | null | undefined): t is ModelType =>
  (MODEL_TYPES as readonly string[]).includes((t ?? '').split(';')[0].trim().toLowerCase());

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

export type ModelCheck = { ok: true; contentType: ModelType } | { ok: false; message: string };

/**
 * Which 3D format these bytes really are, by magic bytes (never trust the extension or the browser's type):
 *   GLB  "glTF" + version 2 · glTF JSON with an "asset" object and every buffer/image embedded as a data: URI ·
 *   USDZ a zip ("PK\3\4") whose first entry is a .usd/.usda/.usdc layer.
 */
export function detectModel(bytes: Uint8Array): ModelCheck {
  if (startsWith(bytes, [0x67, 0x6c, 0x54, 0x46])) {
    const version = bytes[4] | (bytes[5] << 8);
    return version === 2
      ? { ok: true, contentType: 'model/gltf-binary' }
      : { ok: false, message: 'That .glb is an old glTF version. Export it as glTF 2.0.' };
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const nameLen = bytes[26] | (bytes[27] << 8);
    const name = new TextDecoder().decode(bytes.subarray(30, 30 + nameLen)).toLowerCase();
    return /\.usd[ac]?$/.test(name)
      ? { ok: true, contentType: 'model/vnd.usdz+zip' }
      : { ok: false, message: 'That zip is not a USDZ model.' };
  }
  let i = 0;
  while (i < bytes.length && i < 4 && (bytes[i] === 0xef || bytes[i] === 0xbb || bytes[i] === 0xbf)) i++; // BOM
  while (i < bytes.length && /\s/.test(String.fromCharCode(bytes[i]))) i++;
  if (bytes[i] === 0x7b) {
    let json: { asset?: unknown; buffers?: { uri?: string }[]; images?: { uri?: string }[] };
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return { ok: false, message: 'That .gltf file is not valid JSON.' };
    }
    if (!json || typeof json.asset !== 'object') return { ok: false, message: 'That file is not a glTF model.' };
    const external = [...(json.buffers ?? []), ...(json.images ?? [])].some(
      (r) => typeof r?.uri === 'string' && !r.uri.startsWith('data:'),
    );
    if (external)
      return {
        ok: false,
        message: 'That .gltf points at other files. Export it as one .glb (or an embedded .gltf) and pick that.',
      };
    return { ok: true, contentType: 'model/gltf+json' };
  }
  return { ok: false, message: 'Pick a .glb, .gltf or .usdz 3D model.' };
}

/** Does a picked file belong to this kind (by browser type; 3D is checked by magic bytes separately)? */
export function fileFitsKind(kind: MintKind, type: string, name: string): boolean {
  const t = type.toLowerCase();
  if (kind === 'picture') return t.startsWith('image/');
  if (kind === 'music') return t.startsWith('audio/');
  if (kind === 'video') return t.startsWith('video/');
  return isModelType(t) || /\.(glb|gltf|usdz)$/i.test(name) || t === '' || t === 'application/octet-stream';
}

export type KindFields = {
  artist?: string;
  album?: string;
  track?: string;
  editions?: number;
  /** "Original" price in sats; 0/undefined = none. */
  priceSats?: number;
};

export const MAX_EDITIONS = 1000;

export function validateKindFields(kind: MintKind, f: KindFields): string | null {
  const n = f.editions ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_EDITIONS)
    return `Editions must be a whole number from 1 to ${MAX_EDITIONS}.`;
  if (f.priceSats !== undefined && (!Number.isFinite(f.priceSats) || f.priceSats < 0)) return 'Check the price.';
  if (kind === 'music') {
    if ((f.artist ?? '').trim().length > 100) return 'Keep the artist under 100 characters.';
    if ((f.album ?? '').trim().length > 100) return 'Keep the album under 100 characters.';
    const t = (f.track ?? '').trim();
    if (t && !/^\d{1,3}$/.test(t)) return 'Track number should be a number, like 3.';
  }
  return null;
}

/** MAP fields for the type (added to buildMap's app/type/name/description). */
export function kindMap(kind: MintKind, f: KindFields, plan: EditionPlan, posterVout?: number): Record<string, string> {
  const m: Record<string, string> = { kind };
  if (kind === 'music') {
    const artist = (f.artist ?? '').trim();
    const album = (f.album ?? '').trim();
    const track = (f.track ?? '').trim();
    if (artist) m.artist = artist;
    if (album) m.album = album;
    if (track) m.track = String(Number(track));
  }
  if (plan.editions > 1) m.editions = String(plan.editions);
  m.edition = plan.editions > 1 ? (plan.mode === 'inline' ? 'numbered' : 'master') : '1/1';
  if (f.priceSats && f.priceSats > 0) m.price = String(Math.round(f.priceSats));
  if (posterVout !== undefined) m.poster = `_${posterVout}`;
  return m;
}

export const EDITION_INLINE_MAX = 25;
export const EDITION_INLINE_MAX_BYTES = 2 * MB;

export type EditionPlan = { editions: number; mode: 'single' | 'inline'; outputs: number };

/** 1 of N: N outputs in one tx when small enough, else one inscription carrying `editions: N`. */
export function planEditions(editions: number, bytes: number): EditionPlan {
  const n = Math.max(1, Math.floor(editions) || 1);
  if (n === 1) return { editions: 1, mode: 'single', outputs: 1 };
  if (n <= EDITION_INLINE_MAX && n * bytes <= EDITION_INLINE_MAX_BYTES)
    return { editions: n, mode: 'inline', outputs: n };
  return { editions: n, mode: 'single', outputs: 1 };
}

/** Bytes the inscription tx carries: the body × outputs, plus a companion poster. */
export const mintTxBytes = (bytes: number, plan: EditionPlan, posterBytes = 0) => bytes * plan.outputs + posterBytes;

/** A plain BSV amount for the confirm sheet ("0.00012345 BSV"). */
export const fmtBsv = (sats: number) => `${(sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')} BSV`;
