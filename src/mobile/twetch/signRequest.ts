/**
 * twetch.signRequest guard rails (pure apart from the in-memory "last built post" per origin).
 *
 * Twetch's login refuses BITCOIN_ECDSA, so a BSV Twetch account has no session; each API write carries
 * x-twetch-user, x-twetch-ts and x-twetch-sig, where the signature is a BSM (compact, base64) by the account key over
 *
 *   `${METHOD}\n${path}\n${userId}\n${ts}\n${body}`
 *
 * The wallet builds that string itself from checked fields and signs nothing else. The only request it signs is
 * POST /v1/posts registering the post this origin just built (and the user approved) with twetch.buildPost:
 * the body must be exactly { userId, content, txHex, replyPostId? } with that txHex and that text. No paidSats /
 * payParams or any other key, so the signature can never authorise a payment or a different post.
 */

export const SIGN_METHOD = 'POST';
export const SIGN_PATH = '/v1/posts';
export const SIGN_TS_SKEW_MS = 5 * 60 * 1000;
/** How long a built post may be registered after buildPost handed it over. */
export const BUILT_TTL_MS = 10 * 60 * 1000;
const BODY_KEYS = new Set(['userId', 'content', 'txHex', 'replyPostId']);
const PARAM_KEYS = new Set(['method', 'path', 'userId', 'ts', 'body', 'message']);
const BODY_MAX = 200_000;

type Built = { txHex: string; text: string; reply: boolean; at: number };
const built = new Map<string, Built>();

/** buildPost calls this when it hands txHex to `origin`. Kept in memory only (never stored). */
export const rememberBuilt = (origin: string, b: Omit<Built, 'at'>, now = Date.now()) => {
  for (const [o, v] of built) if (now - v.at > BUILT_TTL_MS) built.delete(o);
  built.set(origin, { ...b, at: now });
};
/** Tests only. */
export const forgetBuilt = () => built.clear();

export type SignRequest = { method: string; path: string; userId: string; ts: number; body: string };

const normId = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return String(Number(v));
  return null;
};

/** The exact string Twetch verifies. */
export const signRequestString = (r: SignRequest) => `${r.method}\n${r.path}\n${r.userId}\n${r.ts}\n${r.body}`;

/** Check twetch.signRequest params against the linked account and this origin's last build. A string = refused. */
export const validateSignRequest = (
  params: unknown,
  origin: string,
  linkedUserId: string,
  now = Date.now(),
): SignRequest | string => {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'params must be an object';
  const p = params as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!PARAM_KEYS.has(k)) return `unknown field ${k}`;
  const { method, path, userId, ts, body } = p;
  if (method !== SIGN_METHOD) return 'only POST is signed';
  if (path !== SIGN_PATH) return 'only /v1/posts is signed';
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || Math.abs(ts - now) > SIGN_TS_SKEW_MS)
    return 'ts must be now, in ms';
  const linked = normId(linkedUserId);
  const uid = normId(userId);
  if (!linked || uid !== linked) return 'userId is not the linked Twetch account';
  if (typeof body !== 'string' || body.length > BODY_MAX) return 'body must be a JSON string';
  const out: SignRequest = { method, path, userId: String(userId), ts, body };
  // A caller's own message is never signed; one that differs from the string we build is refused outright.
  if (p.message !== undefined && p.message !== signRequestString(out)) return 'message does not match the request';
  let b: unknown;
  try {
    b = JSON.parse(body);
  } catch {
    return 'body must be a JSON string';
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be a JSON object';
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!BODY_KEYS.has(k)) return `body field ${k} is not allowed`;
  if (normId(o.userId) !== linked) return 'body userId is not the linked Twetch account';
  const last = built.get(origin);
  if (!last || now - last.at > BUILT_TTL_MS || now < last.at) {
    built.delete(origin);
    return 'no recent twetch.buildPost from this site';
  }
  if (typeof o.txHex !== 'string' || o.txHex !== last.txHex) return 'txHex is not the post this wallet built';
  if (typeof o.content !== 'string' || (o.content !== last.text && o.content !== last.text.trim()))
    return 'content is not the text of the post';
  if (o.replyPostId !== undefined && (!last.reply || normId(o.replyPostId) === null))
    return 'replyPostId only goes with a reply';
  return out;
};
