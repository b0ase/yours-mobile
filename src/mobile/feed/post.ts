import { OP, Script, Utils } from '@bsv/sdk';

/**
 * Feed: Bitcoin Schema (bitcoinschema.org) social actions, the protocol 1satsocial,
 * bSocial, Treechat and peck read and write. One OP_RETURN output per action:
 *
 *   OP_FALSE OP_RETURN
 *     B   <text> text/markdown UTF-8 [| B <image bytes> image/jpeg binary <filename>]
 *   | MAP SET app bWallet type post [context tx tx <parent txid>]
 *   | AIP BITCOIN_ECDSA <address> <sig>          (appended by @1sat/actions applyBapAip)
 *
 * Likes / follows are MAP-only (type like + tx, type follow + bapID). Pure helpers here
 * (build, decode, parse the bmap API, fee estimate); network + signing live in feedApi.ts.
 */
export const FEED_APP = 'bWallet';
export const B_PREFIX = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut';
export const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5';
export const AIP_PREFIX = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva';
export const MAX_POST_CHARS = 2000;
/** Inline (B://) image cap after downscale; bigger images are refused rather than silently costly. */
export const MAX_INLINE_IMAGE_BYTES = 250 * 1024;
/** Inputs, change, MAP, AIP signature around the B payloads. */
export const POST_OVERHEAD_BYTES = 450;

const { toArray } = Utils;
const PIPE = 0x7c;

export type PostImage = { bytes: number[]; mime: string; filename?: string };
export type PostInput = { text: string; image?: PostImage | null; replyTo?: string | null; app?: string };

const pushStr = (s: Script, v: string) => s.writeBin(toArray(v, 'utf8'));

const writeMap = (s: Script, kv: [string, string][], app: string) => {
  s.writeBin([PIPE]);
  pushStr(s, MAP_PREFIX);
  pushStr(s, 'SET');
  for (const [k, v] of [['app', app] as [string, string], ...kv]) {
    pushStr(s, k);
    pushStr(s, v);
  }
};

const opReturn = () => new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);

export const isTxid = (t: string | null | undefined): t is string => !!t && /^[0-9a-f]{64}$/i.test(t);

export function validatePost(p: PostInput): string | null {
  const text = p.text.trim();
  if (!text && !p.image) return 'Write something first.';
  if (text.length > MAX_POST_CHARS) return `Keep it under ${MAX_POST_CHARS} characters.`;
  if (p.image) {
    if (!/^image\/(jpeg|png|gif|webp)$/i.test(p.image.mime)) return 'Images must be JPEG, PNG, GIF or WebP.';
    if (p.image.bytes.length > MAX_INLINE_IMAGE_BYTES) return 'That image is too large to post, even after shrinking.';
  }
  if (p.replyTo != null && !isTxid(p.replyTo)) return 'That post id is not valid.';
  return null;
}

/** Unsigned post / reply script (B text, optional B image, MAP). */
export function buildPostScript(p: PostInput): Script {
  const err = validatePost(p);
  if (err) throw new Error(err);
  const s = opReturn();
  const text = p.text.trim();
  if (text) {
    pushStr(s, B_PREFIX);
    pushStr(s, text);
    pushStr(s, 'text/markdown');
    pushStr(s, 'UTF-8');
  }
  if (p.image) {
    if (text) s.writeBin([PIPE]);
    pushStr(s, B_PREFIX);
    s.writeBin(p.image.bytes);
    pushStr(s, p.image.mime);
    pushStr(s, 'binary');
    pushStr(s, p.image.filename || 'image');
  }
  const kv: [string, string][] = [['type', 'post']];
  if (p.replyTo) kv.push(['context', 'tx'], ['tx', p.replyTo.toLowerCase()]);
  writeMap(s, kv, p.app ?? FEED_APP);
  return s;
}

export function buildLikeScript(txid: string, app = FEED_APP, unlike = false): Script {
  if (!isTxid(txid)) throw new Error('That post id is not valid.');
  const s = opReturn();
  s.writeBin(toArray(MAP_PREFIX, 'utf8'));
  pushStr(s, 'SET');
  for (const [k, v] of [['app', app], ['type', unlike ? 'unlike' : 'like'], ['tx', txid.toLowerCase()]]) {
    pushStr(s, k);
    pushStr(s, v);
  }
  return s;
}

export function buildFollowScript(bapId: string, app = FEED_APP, unfollow = false): Script {
  if (!bapId || !/^[1-9A-HJ-NP-Za-km-z]{20,40}$/.test(bapId)) throw new Error('That identity id is not valid.');
  const s = opReturn();
  s.writeBin(toArray(MAP_PREFIX, 'utf8'));
  pushStr(s, 'SET');
  for (const [k, v] of [['app', app], ['type', unfollow ? 'unfollow' : 'follow'], ['bapID', bapId]]) {
    pushStr(s, k);
    pushStr(s, v);
  }
  return s;
}

/** Network fee estimate for one OP_RETURN output of `scriptBytes` (sat/kB rate). */
export const estimatePostFee = (scriptBytes: number, satsPerKb: number): number =>
  Math.max(1, Math.ceil(((scriptBytes + POST_OVERHEAD_BYTES) * Math.max(satsPerKb, 1)) / 1000));

// ── decoding (our own scripts; used by tests and to show a just-sent post) ──────
export type DecodedB = { content: number[]; mime: string; encoding: string; filename?: string };
export type Decoded = { B: DecodedB[]; MAP: Record<string, string>; aip: { address: string; signature: number[] } | null };

export function decodeScript(script: Script): Decoded | null {
  const chunks = script.chunks;
  const ret = chunks.findIndex((c) => c.op === OP.OP_RETURN);
  if (ret < 0) return null;
  // A parsed (serialised) script keeps everything after OP_RETURN as one data blob.
  const tail = chunks[ret].data?.length ? Script.fromBinary(chunks[ret].data!).chunks : chunks.slice(ret + 1);
  const parts: number[][][] = [[]];
  for (const c of tail) {
    const d = c.data ?? [];
    if (d.length === 1 && d[0] === PIPE) parts.push([]);
    else parts[parts.length - 1].push(d);
  }
  const str = (d: number[]) => Utils.toUTF8(d);
  const out: Decoded = { B: [], MAP: {}, aip: null };
  for (const p of parts) {
    if (!p.length) continue;
    const prefix = str(p[0]);
    if (prefix === B_PREFIX && p.length >= 4) {
      out.B.push({ content: p[1], mime: str(p[2]), encoding: str(p[3]), ...(p[4] ? { filename: str(p[4]) } : {}) });
    } else if (prefix === MAP_PREFIX && p[1] && str(p[1]) === 'SET') {
      for (let i = 2; i + 1 < p.length; i += 2) out.MAP[str(p[i])] = str(p[i + 1]);
    } else if (prefix === AIP_PREFIX && p.length >= 4) {
      out.aip = { address: str(p[2]), signature: p[3] };
    }
  }
  return out;
}

// ── bmap API parsing ─────────────────────────────────────────────────────────
export type Author = { address: string; bapId: string | null; name: string; avatar: string | null };
export type FeedImage = { src: string; mime: string };
export type FeedPost = {
  txid: string;
  text: string;
  images: FeedImage[];
  app: string;
  replyTo: string | null;
  author: Author;
  /** ms since epoch */
  at: number;
  likes: number;
  replies: number;
};

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** ORDFS for b:// / 1sat:// / bitfs refs; plain https stays. Anything else (javascript:, data:text…) is dropped. */
export function mediaUrl(ref: string, ordfs = 'https://ordfs.network'): string | null {
  const r = ref.trim();
  if (/^https:\/\//i.test(r)) return r;
  const m = r.match(/^(?:b|1sat|ord):\/\/([0-9a-f]{64})(?:[._](\d+))?/i);
  if (m) return `${ordfs}/${m[1]}_${m[2] ?? '0'}`;
  const f = r.match(/^bitfs:\/\/([0-9a-f]{64})\.out\.(\d+)/i);
  if (f) return `${ordfs}/${f[1]}_${f[2]}`;
  return null;
}

export type Identity = { name: string; avatar: string | null };

/** The schema.org Person JSON a BAP ID record carries (as a string or object). */
export function parseIdentity(raw: unknown): Identity {
  let o: Rec = {};
  if (typeof raw === 'string') {
    try {
      o = asRec(JSON.parse(raw));
    } catch {
      o = {};
    }
  } else o = asRec(raw);
  const name = asStr(o.alternateName) || asStr(o.name) || [asStr(o.givenName), asStr(o.familyName)].filter(Boolean).join(' ');
  const img = asStr(o.image) || asStr(o.logo);
  return { name: name.trim().slice(0, 60), avatar: img ? mediaUrl(img) : null };
}

/** address → identity from a response's `signers` array. */
export function signerIndex(signers: unknown): Map<string, Identity & { bapId: string }> {
  const out = new Map<string, Identity & { bapId: string }>();
  for (const s of asArr(signers)) {
    const r = asRec(s);
    const bapId = asStr(r.idKey);
    if (!bapId) continue;
    const id = parseIdentity(r.identity);
    const addrs = [asStr(r.currentAddress), asStr(r.rootAddress), ...asArr(r.addresses).map((a) => asStr(asRec(a).address))];
    for (const a of addrs) if (a) out.set(a, { ...id, bapId });
  }
  return out;
}

export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a);

/** One bmap transaction document → a post, or null if it is not a readable post. */
export function parseBmapPost(doc: unknown, signers = new Map<string, Identity & { bapId: string }>(), meta?: Rec): FeedPost | null {
  const d = asRec(doc);
  const txid = asStr(asRec(d.tx).h) || asStr(d._id);
  if (!isTxid(txid)) return null;
  const maps = asArr(d.MAP).map(asRec);
  const map = maps.find((m) => asStr(m.type)) ?? maps[0] ?? {};
  const type = asStr(map.type);
  if (type && type !== 'post' && type !== 'reply') return null;
  let text = '';
  const images: FeedImage[] = [];
  for (const b of asArr(d.B).map(asRec)) {
    const mime = (asStr(b['content-type']) || asStr(b.mediaType)).toLowerCase();
    const content = asStr(b.content);
    if (!content) continue;
    if (mime.startsWith('text/')) {
      if (!text) text = content;
    } else if (/^image\/(jpeg|png|gif|webp)$/.test(mime)) {
      if (/^[A-Za-z0-9+/=\s]+$/.test(content) && content.length > 16) images.push({ src: `data:${mime};base64,${content.replace(/\s/g, '')}`, mime });
      else {
        const u = mediaUrl(content);
        if (u) images.push({ src: u, mime });
      }
    }
  }
  if (!text && !images.length) return null;
  const ctx = asStr(map.context);
  const parent = asStr(map.tx) || (ctx === 'tx' ? asStr(map.contextValue) : '');
  const aip = asRec(asArr(d.AIP)[0]);
  const address = asStr(aip.address) || asStr(asRec(asRec(asRec(asArr(d.in)[0]).xput).e).a);
  const signer = address ? signers.get(address) : undefined;
  const bapId = signer?.bapId || asStr(map.bapID) || null;
  const name = signer?.name || asStr(map.username) || asStr(map.paymail) || shortAddress(address || txid);
  const ts = Number(d.timestamp) || Number(asRec(d.blk).t) * 1000 || 0;
  const m = asRec(meta);
  return {
    txid: txid.toLowerCase(),
    text: text.slice(0, MAX_POST_CHARS * 2),
    images,
    app: asStr(map.app),
    replyTo: isTxid(parent) ? parent.toLowerCase() : null,
    author: { address, bapId, name, avatar: signer?.avatar ?? null },
    at: ts > 1e12 ? ts : ts * 1000,
    likes: Number(m.likes) || 0,
    replies: Number(m.replies) || 0,
  };
}

/** A whole bmap list response ({results, signers, meta}) → posts, newest first, deduped. */
export function parseBmapFeed(body: unknown): FeedPost[] {
  const b = asRec(body);
  const signers = signerIndex(b.signers);
  const meta = new Map(asArr(b.meta).map((m) => [asStr(asRec(m).tx), asRec(m)] as const));
  const seen = new Set<string>();
  const out: FeedPost[] = [];
  for (const doc of asArr(b.results)) {
    const p = parseBmapPost(doc, signers);
    if (!p || seen.has(p.txid)) continue;
    const m = meta.get(p.txid);
    if (m) {
      p.likes = Number(m.likes) || 0;
      p.replies = Number(m.replies) || 0;
    }
    seen.add(p.txid);
    out.push(p);
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Like count + whether `myAddresses` already liked, from /social/post/{txid}/like. */
export function parseLikes(body: unknown, myAddresses: string[] = []): { count: number; mine: boolean } {
  const results = asArr(asRec(body).results).map(asRec);
  const mine = results.some((r) => myAddresses.includes(asStr(asRec(asArr(r.AIP)[0]).address)));
  return { count: Number(asRec(body).count) || results.length, mine };
}

export const feedTimeLabel = (ms: number, now = Date.now()): string => {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
