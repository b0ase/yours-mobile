/**
 * The feed-author binding's one request (mobile/feed/authorBinding.ts), and the extension's way of sending it.
 *
 * bChatX's CORS allows the web app and the phone apps (https://web.bwalletx.com, capacitor://localhost,
 * https://localhost), not chrome-extension://. So in the Chrome extension the side panel hands the signed claim to the
 * service worker (background.ts), which sends it under the manifest's host permission for https://www.bchatx.com/*
 * (scripts/build.ts). Web, iOS and Android send it themselves.
 *
 * ⚠ Not a proxy: the worker posts only to this one URL, only a body shaped like a claim, and only for the wallet's
 * own pages (background.ts checks the sender). Pure, no feed imports, so the worker stays small.
 */

export const FEED_AUTHOR_BINDING_API = 'https://www.bchatx.com/api/bitsign/feed/author-binding';
/** Host permission the extension needs to send it from the service worker. */
export const FEED_AUTHOR_BINDING_HOST_PERMISSION = 'https://www.bchatx.com/*';
export const FEED_AUTHOR_RELAY_ACTION = 'bwxFeedAuthorBinding';

/** The server's answer, as far as the wallet reads it. status 0: the request never got an answer. */
export type FeedAuthorAnswer = {
  status: number;
  body: { ok?: unknown; code?: unknown; retryAfter?: unknown } | null;
  /** The Retry-After header, as sent (seconds or an HTTP date), when there was one the caller may read. */
  retryAfter: string | null;
};

const NO_ANSWER: FeedAuthorAnswer = { status: 0, body: null, retryAfter: null };

const STRINGS = ['alias', 'identityKey', 'bapId', 'postingAddress', 'identitySignature', 'postingSignature'] as const;
const FIELDS = new Set<string>([...STRINGS, 'timestamp']);

/** Exactly a claim: the seven fields, short strings and an integer time. Anything else is not sent. */
export const isFeedAuthorBody = (b: unknown): b is Record<string, string | number> => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  const o = b as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== FIELDS.size || !keys.every((k) => FIELDS.has(k))) return false;
  if (!STRINGS.every((k) => typeof o[k] === 'string' && (o[k] as string).length > 0 && (o[k] as string).length <= 256))
    return false;
  return Number.isSafeInteger(o.timestamp);
};

/** POST a claim to bChatX. Never throws: no network, or a body that isn't a claim, is "no answer". */
export async function sendFeedAuthorClaim(body: unknown, f: typeof fetch = fetch): Promise<FeedAuthorAnswer> {
  if (!isFeedAuthorBody(body)) return NO_ANSWER;
  try {
    const res = await f(FEED_AUTHOR_BINDING_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // No cookies, no referrer: the two signatures are the whole authorisation.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => null)) as FeedAuthorAnswer['body'];
    return {
      status: res.status,
      body: json && typeof json === 'object' ? { ok: json.ok, code: json.code, retryAfter: json.retryAfter } : null,
      retryAfter: res.headers.get('retry-after'),
    };
  } catch {
    return NO_ANSWER;
  }
}

type Runtime = { sendMessage: (message: unknown) => Promise<unknown> };

/** From an extension page: ask the service worker to send it. Never throws. */
export async function sendFeedAuthorClaimViaWorker(body: unknown, runtime?: Runtime): Promise<FeedAuthorAnswer> {
  try {
    const rt = runtime ?? (globalThis as { chrome?: { runtime?: Runtime } }).chrome?.runtime;
    if (!rt) return NO_ANSWER;
    const a = (await rt.sendMessage({ action: FEED_AUTHOR_RELAY_ACTION, body })) as Partial<FeedAuthorAnswer> | null;
    if (!a || typeof a.status !== 'number') return NO_ANSWER;
    return {
      status: a.status,
      body: a.body && typeof a.body === 'object' ? a.body : null,
      retryAfter: typeof a.retryAfter === 'string' ? a.retryAfter : null,
    };
  } catch {
    return NO_ANSWER;
  }
}

/** Which way a build sends the claim: the extension through its worker, every other build directly. */
export const feedAuthorTransport = (isExtension: boolean): 'worker' | 'direct' => (isExtension ? 'worker' : 'direct');

/**
 * The service worker's side: answer the panel's message. `fromOwnPage` is background.ts's isExtensionSender (Chrome's
 * own sender id + origin), so a web page or content script can't use the worker to post.
 */
export async function answerFeedAuthorRelay(
  message: { body?: unknown } | null | undefined,
  fromOwnPage: boolean,
  f: typeof fetch = fetch,
): Promise<FeedAuthorAnswer> {
  if (!fromOwnPage) return NO_ANSWER;
  return sendFeedAuthorClaim(message?.body, f);
}

/** Seconds to wait from a Retry-After header (seconds or an HTTP date) or the body's retryAfter; 0 when none. */
export const retryAfterMs = (a: Pick<FeedAuthorAnswer, 'body' | 'retryAfter'>, now: number): number => {
  const fromBody = typeof a.body?.retryAfter === 'number' ? a.body.retryAfter : NaN;
  const h = (a.retryAfter ?? '').trim();
  const secs = /^\d+$/.test(h) ? Number(h) : fromBody;
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs, 24 * 3600) * 1000;
  const date = h ? Date.parse(h) : NaN;
  return Number.isFinite(date) && date > now ? Math.min(date - now, 24 * 3600_000) : 0;
};
