import { ProtoWallet, PublicKey, Transaction, Utils } from '@bsv/sdk';
import { chainMedia, mediaFromText, refToOutpoint } from './media';
import { isTxid, MAX_POST_CHARS, mediaUrl, shortAddress, type FeedPost } from './post';
import { isP2pkhAddress } from './tip';

/**
 * Fwetch (fwetch.lol, the Vulpine network) — read through its public API.
 *
 * On chain a Fwetch post is NOT Bitcoin Schema, so neither bmap nor overlay.peck.to index it:
 *   OP_FALSE OP_RETURN "Vulpine" "fwetch-post" <JSON {p,b,t,app,scope?,img?,reply?,board?,flag?,anon?,pub,sig}>
 * `sig` is a BRC-100 wallet signature (protocolID [0,'fwetch identity'], keyID '1',
 * counterparty 'anyone') by identity key `pub` over JSON.stringify(payload minus pub/sig, top-level
 * keys sorted). Many posts are paid for by Fwetch's sponsor wallet ("the house"), so the tx's
 * funding address is a shared relay and is never the author.
 *
 * Read: GET https://api.vulpinenetwork.com/api/feed?app=fwetch&board=all&sort=new&limit=N&offset=M
 *   (CORS *) → { posts: [{ txid, body, image, reply_to, ts, author_name, author_pfp,
 *   signer_addr, anon, hidden, scope, board, likes, replies, … }] }
 *   GET /api/post/<txid> → { post, replies }   GET /api/rawtx/<txid> → { txid, hex }
 *
 * The owner's call (2026-10-06): `scope:'local'` posts are syndicated like any on-chain post;
 * posts Fwetch marks `hidden` (its moderation / takedown) are never shown.
 *
 * Payability: ONLY the address of `pub` after we fetched the raw tx, checked it hashes to the
 * txid, and verified `sig` ourselves (`verifyFwetchTx`). The API's signer_addr is never trusted
 * on its own; anonymous posts are never payable. Everything else gets a `fwetch:` key.
 */
export const FWETCH_API = 'https://api.vulpinenetwork.com';
export const FWETCH_HOME = 'https://fwetch.lol';

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const asStr = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** txid → verified author address (from the post's own signature). */
export type VerifiedAuthors = ReadonlyMap<string, string>;

/** An API item → FeedPost, or null (hidden, malformed, empty). */
export function parseFwetchItem(item: unknown, verified: VerifiedAuthors = new Map()): FeedPost | null {
  const p = asRec(item);
  const txid = asStr(p.txid).toLowerCase();
  if (!isTxid(txid)) return null;
  if (p.hidden) return null; // Fwetch's takedown — respected
  const fromText = mediaFromText(asStr(p.body).trim());
  const media = [...fromText.media];
  const op = refToOutpoint(asStr(p.image));
  if (op && !media.some((m) => m.ref === op)) {
    const m = chainMedia(op, 'image/webp', true); // the API carries no type; most are images
    if (m) media.unshift(m);
  }
  if (!fromText.text && !media.length) return null;
  const anon = Number(p.anon) === 1;
  const v = anon ? undefined : verified.get(txid);
  const payable = !!v && isP2pkhAddress(v);
  const claimed = asStr(p.signer_addr) || asStr(p.author_addr);
  const parent = asStr(p.reply_to).toLowerCase();
  const pfp = asStr(p.author_pfp);
  const name = asStr(p.author_name).trim().slice(0, 60);
  return {
    txid,
    text: fromText.text.slice(0, MAX_POST_CHARS * 2),
    images: [],
    media,
    links: fromText.links,
    app: 'fwetch',
    source: 'fwetch',
    threadId: null,
    replyTo: isTxid(parent) ? parent : null,
    author: {
      address: payable ? v! : `fwetch:${anon ? 'anon' : claimed.slice(0, 80) || 'unknown'}`,
      bapId: null,
      name: anon ? 'Anonymous' : name || (claimed ? shortAddress(claimed) : 'Fwetch user'),
      avatar: !anon && pfp ? mediaUrl(pfp) : null,
    },
    at: (Number(p.ts) || 0) * 1000,
    likes: Number(p.likes) || 0,
    replies: Number(p.replies) || 0,
  };
}

/** An /api/feed body (or { posts }) → posts, deduped by txid. */
export function parseFwetchFeed(body: unknown, verified: VerifiedAuthors = new Map()): FeedPost[] {
  const posts = asRec(body).posts;
  if (!Array.isArray(posts)) return [];
  const seen = new Set<string>();
  const out: FeedPost[] = [];
  for (const item of posts) {
    const p = parseFwetchItem(item, verified);
    if (p && !seen.has(p.txid)) { seen.add(p.txid); out.push(p); }
  }
  return out;
}

/** OP_FALSE OP_RETURN pushes of one locking script, or null when it is not a data output. */
function opReturnPushes(b: number[]): number[][] | null {
  if (b[0] !== 0x00 || b[1] !== 0x6a) return null;
  const out: number[][] = [];
  let i = 2;
  while (i < b.length) {
    const op = b[i++];
    let n: number;
    if (op >= 0x01 && op <= 0x4b) n = op;
    else if (op === 0x4c) n = b[i++];
    else if (op === 0x4d) { n = b[i] | (b[i + 1] << 8); i += 2; }
    else if (op === 0x4e) { n = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000; i += 4; }
    else { out.push([]); continue; }
    if (i + n > b.length) return null;
    out.push(b.slice(i, i + n));
    i += n;
  }
  return out;
}

/** The fwetch-post payload in a raw tx, after checking the tx really is `txid`. */
export function fwetchPayload(hex: string, txid: string): Rec | null {
  try {
    const tx = Transaction.fromHex(hex);
    if (tx.id('hex') !== txid.toLowerCase()) return null;
    for (const o of tx.outputs) {
      const d = opReturnPushes(o.lockingScript.toBinary());
      if (!d || d.length < 3) continue;
      if (Utils.toUTF8(d[0]) !== 'Vulpine' || Utils.toUTF8(d[1]) !== 'fwetch-post') continue;
      const j = JSON.parse(Utils.toUTF8(d[2])) as unknown;
      return j && typeof j === 'object' && !Array.isArray(j) ? (j as Rec) : null;
    }
  } catch { /* not a tx */ }
  return null;
}

const anyone = new ProtoWallet('anyone');

/** The author's address when `payload.sig` verifies against `payload.pub`, else null. */
export async function verifyFwetchPayload(payload: Rec): Promise<string | null> {
  const pub = asStr(payload.pub), sig = asStr(payload.sig);
  if (!/^0[23][0-9a-f]{64}$/i.test(pub) || !/^[0-9a-f]{16,200}$/i.test(sig)) return null;
  if (Number(payload.anon) === 1) return null;
  const clean: Rec = {};
  for (const k of Object.keys(payload).sort()) if (k !== 'pub' && k !== 'sig') clean[k] = payload[k];
  try {
    const { valid } = await anyone.verifySignature({
      data: Utils.toArray(JSON.stringify(clean), 'utf8'),
      signature: Utils.toArray(sig, 'hex'),
      protocolID: [0, 'fwetch identity'],
      keyID: '1',
      counterparty: pub,
    });
    return valid ? PublicKey.fromString(pub).toAddress() : null;
  } catch { return null; }
}

/** Raw tx hex → verified author address, or null. */
export async function verifyFwetchTx(hex: string, txid: string): Promise<string | null> {
  const p = fwetchPayload(hex, txid);
  return p ? verifyFwetchPayload(p) : null;
}
