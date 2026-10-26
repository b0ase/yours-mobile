// Owner-only private music library (client: src/mobile/media/library/library.ts, PR #353).
//   POST /api/library/session  (site/api/library.js, routed by site/vercel.json)
// The wallet signs { identityKey, timestamp, fields: {} } with signRequest(wallet, 'library-session', {}): the
// paymail canonical string bwallet-paymail|v1|library-session|identityKey=<k>|timestamp=<t>, BRC-43 protocol
// [2,'bwallet paymail'], keyID '1', counterparty anyone (verified by paymail.verifySigned).
// Checks, in order: IP rate limit, shape, |now - timestamp| <= 120 s, signature, replay cache, per-key rate limit,
// then the key must be the one CURRENTLY bound to alias b0asex (re-read every request), else 403. Only then is
// owner-library/manifest.json read from the private bucket and each path signed for at most an hour.
// Env (Vercel only, never in git): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. LIBRARY_OWNER_ALIAS (default b0asex).
// Signed URLs are never logged: errors log a fixed code only.
'use strict';
const { verifySigned } = require('./paymail');

const ACTION = 'library-session';
const BUCKET = 'owner-library';
const MANIFEST = 'manifest.json';
const SIG_WINDOW_MS = 120 * 1000;
const URL_TTL_S = 3600;
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const PATH_RE = /^(?:covers|audio)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const PALETTE = ['bg', 'surface', 'accent', 'accent2', 'text', 'muted'];
const MAX_ALBUMS = 50;
const MAX_TRACKS = 200;

/** Sliding-window limiter, per serverless instance (best effort, like the other routes). */
function limiter(max, windowMs = 60_000) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return list.length > max;
  };
}

/** Signatures seen inside the time window; a repeat is refused. */
function replayCache(ttlMs = 2 * SIG_WINDOW_MS + 10_000) {
  const seen = new Map();
  return (sig, now = Date.now()) => {
    for (const [k, t] of seen) if (now - t > ttlMs) seen.delete(k);
    if (seen.has(sig)) return true;
    if (seen.size > 10_000) seen.clear();
    seen.set(sig, now);
    return false;
  };
}

const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[<>]/.test(v);
const safePath = (p) => typeof p === 'string' && PATH_RE.test(p) && !p.includes('..') && !p.includes('//');

/**
 * The manifest, checked so nothing odd ever reaches the client. A malformed album (or track) is skipped, never the
 * whole library: one bad entry must not hide the others. null only when the file itself is not a manifest.
 * Optional per album: thumb (a small cover, e.g. covers/<id>-400.jpg) that the shelf prefers.
 */
function parseAlbum(a) {
  if (!a || !ID_RE.test(String(a.id)) || !text(a.title, 80) || !safePath(a.cover)) return null;
  if (a.artist !== undefined && !text(a.artist, 80)) return null;
  const t = a.theme || {};
  if (!PALETTE.every((k) => typeof t[k] === 'string' && HEX_RE.test(t[k]))) return null;
  if (!Array.isArray(a.tracks)) return null;
  const tracks = [];
  for (const tr of a.tracks.slice(0, MAX_TRACKS)) {
    if (!tr || !ID_RE.test(String(tr.id)) || !text(tr.title, 120) || !safePath(tr.path)) continue;
    const d = Number(tr.duration);
    tracks.push({ id: tr.id, title: tr.title, path: tr.path, ...(d > 0 && d < 86400 ? { duration: d } : {}) });
  }
  return {
    id: a.id,
    title: a.title,
    ...(typeof a.artist === 'string' ? { artist: a.artist } : {}),
    cover: a.cover,
    ...(safePath(a.thumb) ? { thumb: a.thumb } : {}),
    theme: Object.fromEntries(PALETTE.map((k) => [k, t[k].toUpperCase()])),
    tracks,
  };
}

function parseManifest(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.albums)) return null;
  const all = m.albums.slice(0, MAX_ALBUMS);
  const albums = all.map(parseAlbum).filter(Boolean);
  return all.length && !albums.length ? null : albums;
}

/** Supabase Storage reader for the private bucket. null when not configured. */
function libraryStorage(env = process.env, f = fetch) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  return {
    readManifest: async () => {
      const r = await f(`${url}/storage/v1/object/authenticated/${BUCKET}/${MANIFEST}`, { headers: h });
      if (!r.ok) throw new Error('manifest');
      return r.json();
    },
    /** Signs many paths in one call. Returns { path: signedUrl }. */
    signMany: async (paths, expiresIn) => {
      const r = await f(`${url}/storage/v1/object/sign/${BUCKET}`, {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn, paths }),
      });
      if (!r.ok) throw new Error('sign');
      const list = await r.json();
      const out = {};
      for (const it of Array.isArray(list) ? list : []) {
        const s = it && (it.signedURL || it.signedUrl);
        if (it && !it.error && typeof s === 'string')
          out[it.path] = `${url}/storage/v1${s.startsWith('/') ? '' : '/'}${s}`;
      }
      return out;
    },
  };
}

/**
 * The session handler. Deps injected so tests run without a network:
 *   aliases.getAlias(alias) → row with identity_key (the paymail store), storage (libraryStorage), now().
 * Returns [status, body].
 */
function makeLibraryHandler({
  aliases,
  storage,
  ownerAlias = 'b0asex',
  ttl = URL_TTL_S,
  now = () => Date.now(),
  ipLimit = limiter(20),
  keyLimit = limiter(10),
  replay = replayCache(),
}) {
  const expiresIn = Math.min(Math.max(60, Number(ttl) || URL_TTL_S), URL_TTL_S);
  return async function session(body, ip = 'unknown') {
    const t = now();
    if (ipLimit(`ip:${ip}`, t)) return [429, { error: 'rate-limited' }];
    if (!body || typeof body !== 'object') return [400, { error: 'invalid-request' }];
    if (body.fields && (typeof body.fields !== 'object' || Object.keys(body.fields).length > 0))
      return [400, { error: 'invalid-request' }];
    const identityKey = String(body.identityKey || '').toLowerCase();
    if (!PUBKEY_RE.test(identityKey)) return [401, { error: 'unauthorized' }];
    const ts = Number(body.timestamp);
    if (!Number.isFinite(ts) || Math.abs(t - ts) > SIG_WINDOW_MS) return [401, { error: 'expired' }];
    const err = await verifySigned({ identityKey, timestamp: ts, fields: {}, signature: body.signature }, ACTION, t);
    if (err) return [401, { error: 'unauthorized' }];
    if (replay(String(body.signature).toLowerCase(), t)) return [401, { error: 'replayed' }];
    if (keyLimit(`key:${identityKey}`, t)) return [429, { error: 'rate-limited' }];
    if (!aliases || !storage) return [503, { error: 'not_configured' }];

    // The owner check and the manifest read run side by side (one round trip, not two); the manifest is only
    // used once the key is known to be the owner's.
    const manifest = storage.readManifest().catch(() => null);
    const row = await aliases.getAlias(ownerAlias);
    if (!row || String(row.identity_key || '').toLowerCase() !== identityKey) return [403, { error: 'forbidden' }];

    const albums = parseManifest(await manifest);
    if (!albums) return [503, { error: 'not_configured' }];
    // Covers, thumbnails and audio are signed in ONE batch call. Signing is a URL only: no audio is read here.
    const paths = [
      ...new Set(albums.flatMap((a) => [a.cover, ...(a.thumb ? [a.thumb] : []), ...a.tracks.map((tr) => tr.path)])),
    ];
    const signed = paths.length ? await storage.signMany(paths, expiresIn) : {};
    const out = [];
    for (const a of albums) {
      const cover = signed[a.cover];
      if (!cover) continue;
      const { thumb: thumbPath, ...rest } = a;
      const thumb = thumbPath ? signed[thumbPath] : undefined;
      const tracks = a.tracks.filter((tr) => signed[tr.path]).map(({ path, ...tr }) => ({ ...tr, url: signed[path] }));
      out.push({ ...rest, cover, ...(thumb ? { thumb } : {}), tracks });
    }
    // A little under the real expiry, so the client asks again before links die.
    return [200, { expiresAt: t + expiresIn * 1000 - 30_000, albums: out }];
  };
}

module.exports = {
  ACTION,
  BUCKET,
  SIG_WINDOW_MS,
  URL_TTL_S,
  limiter,
  replayCache,
  parseManifest,
  libraryStorage,
  makeLibraryHandler,
};
