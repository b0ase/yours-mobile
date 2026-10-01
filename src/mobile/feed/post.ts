import { OP, Script, Utils } from '@bsv/sdk';
import { bareName } from '../names/names';

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
export type PostInput = {
  text: string;
  image?: PostImage | null;
  replyTo?: string | null;
  app?: string;
  /** Treechat thread a reply belongs to; written as MAP treechat_thread_id so Treechat can place it. */
  threadId?: string | null;
};

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

/** Treechat thread / message ids are UUIDs. */
export const isThreadId = (t: string | null | undefined): t is string =>
  !!t && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);

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
  if (p.threadId != null && !isThreadId(p.threadId)) return 'That thread id is not valid.';
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
  if (p.replyTo && p.threadId) kv.push(['treechat_thread_id', p.threadId.toLowerCase()]);
  writeMap(s, kv, p.app ?? FEED_APP);
  return s;
}

export function buildLikeScript(txid: string, app = FEED_APP, unlike = false): Script {
  if (!isTxid(txid)) throw new Error('That post id is not valid.');
  const s = opReturn();
  s.writeBin(toArray(MAP_PREFIX, 'utf8'));
  pushStr(s, 'SET');
  for (const [k, v] of [
    ['app', app],
    ['type', unlike ? 'unlike' : 'like'],
    ['tx', txid.toLowerCase()],
  ]) {
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
  for (const [k, v] of [
    ['app', app],
    ['type', unfollow ? 'unfollow' : 'follow'],
    ['bapID', bapId],
  ]) {
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
export type Decoded = {
  B: DecodedB[];
  MAP: Record<string, string>;
  aip: { address: string; signature: number[] } | null;
};

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
/** Where a post was made, from MAP `app`. Everything not ours / Treechat / Twetch is "other". */
export type Source = 'bwallet' | 'treechat' | 'twetch' | 'other';
export const SOURCES: { id: Source | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'bwallet', label: 'bWallet' },
  { id: 'treechat', label: 'Treechat' },
  { id: 'twetch', label: 'Twetch' },
  { id: 'other', label: 'Other' },
];

const APP_LABELS: Record<string, string> = {
  treechat: 'Treechat',
  treechat_staging: 'Treechat',
  twetch: 'Twetch',
  '1satsocial': '1satsocial',
  '1sat.social': '1satsocial',
  bsocial: 'bSocial',
};

export function sourceOf(app: string): Source {
  const a = app.trim().toLowerCase();
  if (a === FEED_APP.toLowerCase()) return 'bwallet';
  if (a === 'treechat' || a.startsWith('treechat_')) return 'treechat';
  if (a === 'twetch') return 'twetch';
  return 'other';
}

/** "Treechat" for the credit line; unknown apps keep their own (trimmed) name; empty → ''. */
export const sourceLabel = (app: string): string => {
  const a = app.trim();
  if (!a || sourceOf(a) === 'bwallet') return '';
  return APP_LABELS[a.toLowerCase()] ?? a.slice(0, 24);
};

/**
 * Link to the original on the source app, where a URL pattern is known:
 * Treechat app.treechat.com/p/<thread id> (verified: redirects to /quest/<thread id>);
 * Twetch twetch.com/t/<txid> (the form Twetch users shared on-chain).
 */
export function sourceUrl(p: Pick<FeedPost, 'source' | 'threadId' | 'txid'>): string | null {
  if (p.source === 'treechat' && p.threadId) return `https://app.treechat.com/p/${p.threadId}`;
  if (p.source === 'twetch') return `https://twetch.com/t/${p.txid}`;
  return null;
}

export type FeedPost = {
  txid: string;
  text: string;
  images: FeedImage[];
  app: string;
  source: Source;
  /** Treechat thread id (MAP treechat_thread_id), else null. */
  threadId: string | null;
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
  const name =
    asStr(o.alternateName) || asStr(o.name) || [asStr(o.givenName), asStr(o.familyName)].filter(Boolean).join(' ');
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
    const addrs = [
      asStr(r.currentAddress),
      asStr(r.rootAddress),
      ...asArr(r.addresses).map((a) => asStr(asRec(a).address)),
    ];
    for (const a of addrs) if (a) out.set(a, { ...id, bapId });
  }
  return out;
}

export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a);

/** One bmap transaction document → a post, or null if it is not a readable post. */
export function parseBmapPost(
  doc: unknown,
  signers = new Map<string, Identity & { bapId: string }>(),
  meta?: Rec,
): FeedPost | null {
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
      if (/^[A-Za-z0-9+/=\s]+$/.test(content) && content.length > 16)
        images.push({ src: `data:${mime};base64,${content.replace(/\s/g, '')}`, mime });
      else {
        const u = mediaUrl(content);
        if (u) images.push({ src: u, mime });
      }
    }
  }
  if (!text && !images.length) return null;
  const ctx = asStr(map.context);
  const app = asStr(map.app);
  const source = sourceOf(app);
  // Twetch put the parent in MAP `reply` (literal "null" when none).
  const parent =
    asStr(map.tx) || (ctx === 'tx' ? asStr(map.contextValue) : '') || (source === 'twetch' ? asStr(map.reply) : '');
  const aip = asRec(asArr(d.AIP)[0]);
  const address = asStr(aip.address) || asStr(asRec(asRec(asRec(asArr(d.in)[0]).xput).e).a);
  const signer = address ? signers.get(address) : undefined;
  const bapId = signer?.bapId || asStr(map.bapID) || null;
  const twetchUser = source === 'twetch' && /^\d+$/.test(asStr(map.mb_user)) ? `Twetch user ${asStr(map.mb_user)}` : '';
  const name =
    signer?.name ||
    asStr(map.username).slice(0, 60) ||
    bareName(asStr(map.paymail)) ||
    twetchUser ||
    shortAddress(address || txid);
  // Treechat's own creation time beats bmap's index time (often months later).
  const created = Date.parse(asStr(map.treechat_created_at));
  const ts = created || Number(d.timestamp) || Number(asRec(d.blk).t) * 1000 || 0;
  const threadId = asStr(map.treechat_thread_id);
  const m = asRec(meta);
  return {
    txid: txid.toLowerCase(),
    text: text.slice(0, MAX_POST_CHARS * 2),
    images,
    app,
    source,
    threadId: isThreadId(threadId) ? threadId.toLowerCase() : null,
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

/** Merge lists, newest first, dropping repeats. */
export function mergePosts(...lists: FeedPost[][]): FeedPost[] {
  const seen = new Set<string>();
  return lists
    .flat()
    .filter((p) => !seen.has(p.txid) && !!seen.add(p.txid))
    .sort((a, b) => b.at - a.at);
}

/** Root txid of a post's thread: Treechat replies all point MAP tx at the thread's first post. */
export const threadRoot = (p: FeedPost): string => (p.source === 'treechat' && p.replyTo ? p.replyTo : p.txid);

/**
 * Every post of `post`'s thread from `candidates` (which may include unrelated search hits):
 * same treechat_thread_id, or the root itself, or replies to the root. Oldest first.
 */
export function groupThread(post: FeedPost, candidates: FeedPost[]): FeedPost[] {
  const root = threadRoot(post);
  const inThread = (p: FeedPost) =>
    post.threadId ? p.threadId === post.threadId || p.txid === root : p.txid === root || p.replyTo === root;
  return mergePosts([post], candidates.filter(inThread)).sort((a, b) => a.at - b.at);
}

/** Source filter; "following first" ranks posts by followed authors above the rest, each newest first. */
export function filterFeed(
  posts: FeedPost[],
  source: Source | 'all',
  isFollowed: (a: Author) => boolean = () => false,
): FeedPost[] {
  const kept = source === 'all' ? posts : posts.filter((p) => p.source === source);
  const rank = (p: FeedPost) => (isFollowed(p.author) ? 0 : 1);
  return [...kept].sort((a, b) => rank(a) - rank(b) || b.at - a.at);
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

// ── Twetch API parsing ───────────────────────────────────────────────────────
/**
 * Twetch's public read API (api.twetch.com, unauthenticated GET, CORS *). Since the 2026
 * relaunch posts are still B + MAP app=twetch on-chain, but bmap stopped indexing them, so the
 * API is the practical read path. Its media proxy serves b:// refs and post images.
 */
export const TWETCH_API = 'https://api.twetch.com';

/** b://<txid>[@n] or a bare txid → Twetch's media proxy; https stays; anything else null. */
export function twetchMediaUrl(ref: string): string | null {
  const r = ref.trim();
  if (/^https:\/\//i.test(r)) return r;
  const m = r.match(/^(?:b:\/\/)?([0-9a-f]{64})(?:@(\d+))?$/i);
  if (!m) return null;
  return `${TWETCH_API}/v1/media/${m[1].toLowerCase()}${m[2] ? `-o${m[2]}` : ''}.jpg?v=4`;
}

/**
 * /v1/feed/latest ({data, users, replyPosts, …}) → posts, newest first. Only `post` items with
 * text or an image; marketplace `system` events and bare `branch` reposts are skipped.
 * `addressOf` maps a Twetch public key to an address (for mute / follow keys).
 */
export function parseTwetchFeed(body: unknown, addressOf: (pubKey: string) => string = () => ''): FeedPost[] {
  const b = asRec(body);
  const users = asRec(b.users);
  const replyPosts = asRec(b.replyPosts);
  const seen = new Set<string>();
  const out: FeedPost[] = [];
  for (const item of asArr(b.data)) {
    const p = asRec(item);
    const txid = asStr(p.txid).toLowerCase();
    if (asStr(p.type) !== 'post' || !isTxid(txid) || seen.has(txid)) continue;
    const text = asStr(p.content).trim();
    let files: unknown[] = [];
    try {
      files = asArr(typeof p.files === 'string' ? JSON.parse(p.files) : p.files);
    } catch {
      files = [];
    }
    const images: FeedImage[] = files
      .map((f) => twetchMediaUrl(asStr(f)))
      .filter((u): u is string => !!u)
      .slice(0, 4)
      .map((src) => ({ src, mime: 'image/jpeg' }));
    if (!text && !images.length) continue;
    const uid = asStr(p.userId);
    const u = asRec(users[uid]);
    let address = '';
    try {
      address = asStr(u.publicKey) ? addressOf(asStr(u.publicKey)) : '';
    } catch {
      address = '';
    }
    const icon = asStr(u.icon);
    const parent = asStr(asRec(replyPosts[asStr(p.replyPostId)]).txid);
    out.push({
      txid,
      text: text.slice(0, MAX_POST_CHARS * 2),
      images,
      app: 'twetch',
      source: 'twetch',
      threadId: null,
      replyTo: isTxid(parent) ? parent.toLowerCase() : null,
      author: {
        address: address || `twetch:${uid}`,
        bapId: null,
        name: asStr(u.name).trim().slice(0, 60) || `Twetch user ${uid}`,
        avatar: icon ? twetchMediaUrl(icon) : null,
      },
      at: Number(p.postedAtMs) || Number(p.createdAtMs) || 0,
      likes: Number(p.numLikes) || 0,
      replies: Number(p.numReplies) || 0,
    });
    seen.add(txid);
  }
  return out.sort((a, b) => b.at - a.at);
}
