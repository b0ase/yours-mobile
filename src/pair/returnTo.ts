/**
 * Return-to-site after a phone pairing (docs/PAIRING-ORIGIN-PROOF.md, "Return to the site (v2)").
 *
 * A v2 pairing link may carry `ret` (where to send the user after Allow), `rid` (a one-time request id) and `b` (the
 * browser that opened it). The wallet sends the user back only when ALL of these hold, else it shows the usual
 * "switch back" screen:
 *   - the v2 proof `s2` verifies against the origin's well-known keys (it binds c, k, o, e, ret, rid and b);
 *   - `ret` is https, has no userinfo, no explicit port, and its host is the proven origin's host or a subdomain;
 *   - `rid` has not been used on this device in the last 24 hours.
 * The user always lands on an https URL on the proven site, so there is no open redirect.
 *
 * Pure apart from the default nonce store (localStorage), so every rule is unit-tested in returnTo.test.ts.
 */
import { RET_MAX_BYTES, RID_RE, type BrowserHint, type PairLink, type SealedFrame } from './protocol';

/**
 * True when `ret` may be used as the return for a pairing from `origin`: https, no userinfo, and EXACTLY that origin
 * (scheme, host and port). Review 22 Nov 2026: no subdomains. The relay's origin is the WebSocket Origin header, which
 * any non-browser client can set (relay.mjs), so "a subdomain of the claimed origin" could be one the claimant runs.
 */
export function isAllowedReturn(ret: string, origin: string): boolean {
  if (!ret || ret.length > RET_MAX_BYTES) return false;
  try {
    const o = new URL(origin);
    const r = new URL(ret);
    if (o.protocol !== 'https:' || r.protocol !== 'https:') return false;
    if (r.username || r.password || r.port) return false;
    if (o.port) return false; // proven origins with a port are dev setups; no automatic return there
    return r.origin === o.origin;
  } catch {
    return false;
  }
}

/** One-time request ids, remembered for a day (a small LRU). */
export const RID_TTL_MS = 24 * 60 * 60 * 1000;
const RID_MAX = 200;
const RID_KEY = 'bwalletxPairRids';

export type KV = { get(k: string): string | null; set(k: string, v: string): void };
const localKv: KV = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable: the rid is then single use only in memory */
    }
  },
};
const memory = new Map<string, number>();

/**
 * Marks `rid` as used. True the first time, false when it was already used in the last 24 h (a replayed link).
 * If storage can't be read the in-memory copy still refuses a reuse in this run.
 */
export function claimRid(rid: string, now = Date.now(), kv: KV = localKv): boolean {
  if (!RID_RE.test(rid)) return false;
  let seen: Record<string, number> = {};
  try {
    const raw = kv.get(RID_KEY);
    if (raw) seen = JSON.parse(raw) as Record<string, number>;
  } catch {
    seen = {};
  }
  for (const [k, t] of memory) if (!(k in seen)) seen[k] = t;
  const fresh = Object.entries(seen).filter(([, t]) => typeof t === 'number' && now - t < RID_TTL_MS);
  if (fresh.some(([k]) => k === rid)) return false;
  fresh.push([rid, now]);
  const kept = fresh.sort((a, b) => a[1] - b[1]).slice(-RID_MAX);
  memory.set(rid, now);
  kv.set(RID_KEY, JSON.stringify(Object.fromEntries(kept)));
  return true;
}
/** Tests only. */
export const resetRidMemory = () => memory.clear();

/** The decision taken when the pairing is checked: return to `ret` (still subject to the rid) or not at all. */
export type ReturnPlan = { ret: string; rid: string; b?: BrowserHint } | null;
/**
 * Where to send the user after Connect, or null. Review 3 (22 Nov 2026): always the ROOT of the exact origin the relay
 * saw, and only when the link asks for a return (`ret` on that origin, and a one-time `rid`). Origin proofs (`s`, `s2`)
 * are ignored, so no link chooses a path; the site keeps the page it started on and goes back to it itself
 * (@bwalletx/connect 0.9.0). The fragment's frame is sealed to the site's pairing key; `rid` stays one-time.
 */
export function planReturn(link: PairLink, origin: string): ReturnPlan {
  if (!link.ret || !link.rid) return null;
  if (origin !== link.o) return null;
  if (!isAllowedReturn(link.ret, link.o)) return null;
  return { ret: `${new URL(link.o).origin}/`, rid: link.rid, ...(link.b && { b: link.b }) };
}

/**
 * What a same-phone return may carry besides the rid (@bwalletx/connect 0.9.0): the wallet's pairing public key and
 * its sealed `ready` (which holds the folded sign-in). Only the tab with the site's pairing key can open the frame. On a
 * phone the site's tab was asleep, its relay socket may have swallowed hello and ready, and iOS/Android usually open
 * the return in a NEW tab, so this is how that tab finishes without the relay.
 */
export type ReturnExtra = { wk: string; frame: SealedFrame };

const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** `ret` with the result in the fragment (never sent to the server): `#bwx=ok&rid=<rid>[&wk=<key>&f=<frame>]`. */
export const returnTarget = (ret: string, rid: string, extra?: ReturnExtra) => {
  const u = new URL(ret);
  const q = new URLSearchParams({ bwx: 'ok', rid });
  if (extra) {
    q.set('wk', extra.wk);
    q.set('f', b64url(new TextEncoder().encode(JSON.stringify(extra.frame))));
  }
  u.hash = q.toString();
  return u.toString();
};

/** Android browser packages for each hint; anything else returns through the https fallback (default browser). */
export const ANDROID_BROWSERS: Partial<Record<BrowserHint, string>> = {
  chrome: 'com.android.chrome',
  samsung: 'com.sec.android.app.sbrowser',
  firefox: 'org.mozilla.firefox',
  edge: 'com.microsoft.emmx',
  brave: 'com.brave.browser',
  opera: 'com.opera.browser',
};

/**
 * May this return URL carry a folded sign-in (review 4 L3, CTO 22 Nov 2026)? Only when it can reach nothing but the
 * site, in the browser the user came from:
 * - a plain https URL on exactly the return's origin;
 * - an Android `intent://` with scheme=https, an exact package from ANDROID_BROWSERS (our table, never the link's), the
 *   same origin as its target, and, if present, a browser_fallback_url on that same origin root. Android delivers an
 *   explicit-package intent only to that installed package, and package names are unique on the device.
 * Never an iOS custom scheme (googlechromes://, firefox://): any app may register those.
 */
export function isFoldableReturnUrl(url: string, ret: string): boolean {
  let root: URL;
  try {
    root = new URL(ret);
  } catch {
    return false;
  }
  if (root.protocol !== 'https:' || root.pathname !== '/') return false;
  const sameRoot = (u: string) => {
    try {
      const x = new URL(u);
      return x.protocol === 'https:' && x.origin === root.origin;
    } catch {
      return false;
    }
  };
  if (url.startsWith('https://')) return sameRoot(url);
  if (!url.startsWith('intent://')) return false;
  const at = url.lastIndexOf('#Intent;');
  if (at < 0 || !url.endsWith(';end')) return false;
  if (!sameRoot(`https://${url.slice('intent://'.length, at)}`)) return false;
  const params = new Map<string, string>();
  for (const part of url.slice(at + '#Intent;'.length, -';end'.length).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) params.set(part.slice(0, eq), part.slice(eq + 1));
  }
  if (params.get('scheme') !== 'https') return false;
  if (!(Object.values(ANDROID_BROWSERS) as string[]).includes(params.get('package') ?? '')) return false;
  const fallback = params.get('S.browser_fallback_url');
  if (fallback !== undefined) {
    let f: URL;
    try {
      f = new URL(decodeURIComponent(fallback));
    } catch {
      return false;
    }
    if (f.protocol !== 'https:' || f.origin !== root.origin || f.pathname !== '/') return false;
  }
  return true;
}

/** Whether this plan's return, as this shell would open it, may carry a folded sign-in (isFoldableReturnUrl). */
export const returnIsFoldable = (plan: NonNullable<ReturnPlan>, platform: ReturnPlatform) =>
  isFoldableReturnUrl(returnUrlFor(returnTarget(plan.ret, plan.rid), plan.b, platform), plan.ret);

export type ReturnPlatform = 'ios' | 'android' | 'web';

/**
 * The URL the wallet opens to send the user back, for the browser they came from:
 * - iOS: Safari (and unknown) get the https URL; Chrome gets googlechromes://; Firefox gets firefox://open-url.
 * - Android: intent://… naming the browser package, with the https URL as S.browser_fallback_url.
 * - web wallet: the https URL (it is already in that browser).
 */
export function returnUrlFor(target: string, b: BrowserHint | undefined, platform: ReturnPlatform): string {
  const u = new URL(target);
  if (u.protocol !== 'https:') throw new Error('return must be https');
  const rest = target.slice('https://'.length);
  if (platform === 'ios') {
    if (b === 'chrome') return `googlechromes://${rest}`;
    if (b === 'firefox') return `firefox://open-url?url=${encodeURIComponent(target)}`;
    return target;
  }
  if (platform === 'android') {
    const pkg = b ? ANDROID_BROWSERS[b] : undefined;
    if (!pkg) return target;
    // Intent.parseUri splits at the LAST '#', so the target's own #bwx=… fragment stays in the data URI.
    return `intent://${rest}#Intent;scheme=https;package=${pkg};S.browser_fallback_url=${encodeURIComponent(target)};end`;
  }
  return target;
}
