/**
 * Sign-in signatures are bound to the caller's origin, on every transport (security review of the SSO hub, 2 Nov 2026).
 *
 * BRC-42 keys depend on protocol, key ID and counterparty, never on which site asked. So evil.com could fetch a
 * sign-in challenge from another site's server (id.bwalletx.com, or any b*X site), ask the user's bWalletX to sign it
 * under the shared sign-in protocol, and relay the signature to sign in as the user; with single sign-on, one phish
 * signed them in everywhere. The user saw an ordinary sign-in sheet for evil.com.
 *
 * Now, for createSignature under a sign-in protocol from any outside caller:
 * - the caller's origin comes from the transport (Chrome's sender.origin, the native WebView's frame origin, the
 *   postMessage event origin, the pairing's origin), never from a field the page sends;
 * - the signed text must be EXACTLY the challenge for that origin: bit-sign / @bwalletx/connect `loginMessage` for
 *   [2, 'bwallet sign in'], or the SSO hub's line for [2, 'bwalletx id sign in'];
 * - anything else is refused before any sheet;
 * - [2, 'bwalletx id sign in'] belongs to the hub alone: any protocol method from another origin is refused;
 * - grants for sign-in protocols are never stored, so every sign-in shows its sheet ("never remembered").
 *
 * Pure and dependency-free (no @bsv/sdk) so background.ts, the dApp browser, the pairing path and the permission
 * manager guard all share the one validator.
 */

type Protocol = readonly [number, string];

export const LOGIN_PROTOCOL_NAME = 'bwallet sign in';
/** The SSO hub's own protocol (id.bwalletx.com). */
export const HUB_PROTOCOL_NAME = 'bwalletx id sign in';
export const LOGIN_PROTOCOL: Protocol = [2, LOGIN_PROTOCOL_NAME];
export const HUB_PROTOCOL: Protocol = [2, HUB_PROTOCOL_NAME];

/** The hub's origin. Exact: scheme, host and (default) port. */
export const HUB_ORIGIN = 'https://id.bwalletx.com';
/** The hub on a developer's machine (bwalletx-id `next dev -p 3400`): accepted by dev builds only. */
export const HUB_DEV_ORIGIN = 'http://localhost:3400';

/** Vite sets DEV for `vite` dev servers only; every shipped build (and bun test) has it false. */
const IS_DEV_BUILD = (() => {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
})();

/** Origins allowed to use the hub protocol. */
export const hubOrigins = (dev: boolean = IS_DEV_BUILD): readonly string[] =>
  dev ? [HUB_ORIGIN, HUB_DEV_ORIGIN] : [HUB_ORIGIN];

/** bit-sign issues two-minute nonces; allow a little clock skew, refuse anything further out. */
export const LOGIN_MAX_AHEAD_MS = 10 * 60 * 1000;
/** The hub line carries one time (issued or expiry): it must be within this of now, either way. */
export const HUB_MAX_SKEW_MS = 10 * 60 * 1000;
/** No real challenge is this long; a bound on what the validator reads. */
export const MAX_SIGN_IN_BYTES = 2048;

export const SIGN_IN_REFUSAL = 'This sign-in is not for the site asking';
export const HUB_PROTOCOL_REFUSAL = 'This sign-in protocol belongs to id.bwalletx.com';

export type SignInKind = 'login' | 'hub';

const norm = (name: string) => name.trim().toLowerCase();

/**
 * Which sign-in protocol this protocolID names, or null. Case and outer spaces are ignored because the SDK ignores
 * them when deriving keys (KeyDeriver.computeInvoiceNumber): [2, ' Bwallet Sign In '] signs with the same key.
 */
export const signInKind = (protocolID: unknown): SignInKind | null => {
  if (!Array.isArray(protocolID) || protocolID.length !== 2) return null;
  const [level, name] = protocolID as [unknown, unknown];
  if (level !== 2 || typeof name !== 'string') return null;
  const n = norm(name);
  if (n === LOGIN_PROTOCOL_NAME) return 'login';
  if (n === HUB_PROTOCOL_NAME) return 'hub';
  return null;
};

export const isSignInProtocol = (protocolID: unknown): boolean => signInKind(protocolID) !== null;

/** A createSignature that names a sign-in protocol at all (valid or not). */
export const isSignInCall = (method: string, args: unknown): boolean =>
  method === 'createSignature' && isSignInProtocol(obj(args)?.protocolID);

/** The exact challenge text bit-sign and @bwalletx/connect build (connect src/server.ts loginMessage). */
export const loginMessage = (origin: string, nonce: string, expiresAt: string) =>
  [
    `Sign in to ${new URL(origin).host} with bWallet`,
    '',
    'This proves you hold this wallet. It does not spend anything.',
    '',
    `Origin: ${origin}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt}`,
  ].join('\n');

/** The SSO hub's challenge line: "Sign in to id.bwalletx.com · challenge <nonce> · <iso time>". */
export const hubMessage = (origin: string, nonce: string, time: string) =>
  `Sign in to ${new URL(origin).host} · challenge ${nonce} · ${time}`;

export type LoginRequest = { origin: string; host: string; nonce: string; message: string };
export type SignInRequest = LoginRequest & { kind: SignInKind; protocolID: Protocol; keyID: string };

type Sig = {
  protocolID?: unknown;
  keyID?: unknown;
  counterparty?: unknown;
  data?: unknown;
  hashToDirectlySign?: unknown;
  privileged?: unknown;
};

function obj(p: unknown): Record<string, unknown> | null {
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
}

const NONCE = /^[A-Za-z0-9_-]{8,128}$/;
/** ISO 8601 date-time with optional seconds / fraction and a zone: tolerant of format, the text match stays exact. */
const ISO = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:Z|[+-]\\d{2}:?\\d{2})';
const LOGIN_EXPIRES = new RegExp(`\\nExpires: (${ISO})$`);
const HUB_LINE = new RegExp(`^Sign in to (\\S+) +· +challenge ([A-Za-z0-9_-]{8,128}) +· +(${ISO})$`);

/** The caller's origin in canonical form (scheme://host[:port]), or null when it isn't one. */
export const canonicalOrigin = (origin: string | undefined | null): string | null => {
  if (!origin || typeof origin !== 'string') return null;
  try {
    const u = new URL(origin);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.host || u.origin === 'null') return null;
    return u.origin;
  } catch {
    return null;
  }
};

/** Shape checks shared by both formats; returns the decoded text or the reason it is refused. */
const readText = (p: Sig): string | { error: string } => {
  if (p.counterparty !== 'anyone') return { error: 'sign-in must use counterparty anyone' };
  if (p.hashToDirectlySign !== undefined) return { error: 'sign-in must sign its text, not a hash' };
  if (p.privileged) return { error: 'sign-in is never privileged' };
  if (typeof p.keyID !== 'string' || !NONCE.test(p.keyID)) return { error: 'bad sign-in nonce' };
  const d = p.data;
  if (
    !Array.isArray(d) ||
    d.length === 0 ||
    d.length > MAX_SIGN_IN_BYTES ||
    !d.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  )
    return { error: 'sign-in text missing' };
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(d as number[]));
  } catch {
    return { error: 'sign-in text is not UTF-8' };
  }
};

const parseLoginText = (text: string, origin: string, keyID: string, now: number): string | null => {
  const m = LOGIN_EXPIRES.exec(text);
  if (!m) return 'sign-in text not recognised';
  const exp = Date.parse(m[1]);
  if (!Number.isFinite(exp) || !(exp > now) || exp - now > LOGIN_MAX_AHEAD_MS) return 'sign-in request expired';
  if (text !== loginMessage(origin, keyID, m[1])) return 'sign-in text does not match this site';
  return null;
};

const parseHubText = (text: string, origin: string, now: number): { nonce: string } | string => {
  const m = HUB_LINE.exec(text);
  if (!m) return 'sign-in text not recognised';
  if (m[1] !== new URL(origin).host) return 'sign-in text does not match this site';
  const t = Date.parse(m[3]);
  if (!Number.isFinite(t) || Math.abs(t - now) > HUB_MAX_SKEW_MS) return 'sign-in request expired';
  if (text !== hubMessage(origin, m[2], m[3])) return 'sign-in text does not match this site';
  return { nonce: m[2] };
};

/**
 * The sign-in challenge for `callerOrigin`, or the reason it is refused. `callerOrigin` MUST come from the transport.
 *
 * - [2, 'bwallet sign in']: byte-exact `loginMessage(callerOrigin, keyID, expiresAt)`, expiring within 10 minutes.
 * - [2, 'bwalletx id sign in']: only from the hub's origin (hubOrigins), with the hub line for that origin (or, while
 *   the hub moves over, the loginMessage form for the same origin); the line's time within 10 minutes of now.
 */
export const parseSignInRequest = (
  params: unknown,
  callerOrigin: string | undefined | null,
  now = Date.now(),
  opts: { dev?: boolean } = {},
): SignInRequest | string => {
  const p = obj(params) as Sig | null;
  const kind = p ? signInKind(p.protocolID) : null;
  if (!p || !kind) return 'not a sign-in request';
  const origin = canonicalOrigin(callerOrigin);
  if (!origin) return 'sign-in needs the calling site’s origin';
  if (kind === 'hub' && !hubOrigins(opts.dev).includes(origin)) return HUB_PROTOCOL_REFUSAL;
  const text = readText(p);
  if (typeof text !== 'string') return text.error;
  const keyID = p.keyID as string;
  const host = new URL(origin).host;
  const protocolID: Protocol = kind === 'hub' ? HUB_PROTOCOL : LOGIN_PROTOCOL;
  // The hub's line is taken from the hub's own origin only (under either protocol while the hub moves over).
  if (hubOrigins(opts.dev).includes(origin) && text.startsWith(`Sign in to ${host} ·`)) {
    const hub = parseHubText(text, origin, now);
    if (typeof hub === 'string') return hub;
    return { kind, protocolID, keyID, origin, host, nonce: hub.nonce, message: text };
  }
  const bad = parseLoginText(text, origin, keyID, now);
  if (bad) return bad;
  return { kind, protocolID, keyID, origin, host, nonce: keyID, message: text };
};

/** [2, 'bwallet sign in'] only, in the shape pairLogin.ts has always returned. */
export const parseLoginRequest = (params: unknown, sessionOrigin: string, now = Date.now()): LoginRequest | string => {
  if (signInKind(obj(params)?.protocolID) !== 'login') return 'not a sign-in request';
  const r = parseSignInRequest(params, sessionOrigin, now);
  if (typeof r === 'string') return r;
  return { origin: r.origin, host: r.host, nonce: r.nonce, message: r.message };
};

/** Wallet methods whose args carry a protocolID (same set as reservedProtocols.ts). */
const PROTOCOL_METHODS = new Set([
  'getPublicKey',
  'createSignature',
  'verifySignature',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'revealSpecificKeyLinkage',
]);

/**
 * Why an outside caller's call must be refused, or null. For the transports that know the caller's full origin
 * (background.ts sender.origin, the dApp browser, framed bApps). Admin calls never reach here.
 */
export const signInBindingRefusal = (
  method: string,
  args: unknown,
  callerOrigin: string | undefined | null,
  now = Date.now(),
  opts: { dev?: boolean } = {},
): string | null => {
  if (!PROTOCOL_METHODS.has(method)) return null;
  const kind = signInKind(obj(args)?.protocolID);
  if (!kind) return null;
  if (method !== 'createSignature') {
    // The hub protocol is pinned to the hub for every method; the shared one stays open for the others.
    if (kind !== 'hub') return null;
    const o = canonicalOrigin(callerOrigin);
    return o && hubOrigins(opts.dev).includes(o)
      ? null
      : `${HUB_PROTOCOL_REFUSAL} (asked by ${o ?? 'an unknown site'})`;
  }
  const r = parseSignInRequest(args, callerOrigin, now, opts);
  return typeof r === 'string' ? `${SIGN_IN_REFUSAL}: ${r}` : null;
};

/* ---------- inside the permissions manager (defence in depth) ---------- */

const isLoopbackHost = (hostname: string) =>
  hostname === 'localhost' ||
  hostname.endsWith('.localhost') ||
  hostname === '[::1]' ||
  /^127(\.\d{1,3}){3}$/.test(hostname);

/**
 * The origins an originator string can stand for. background.ts passes "host[:port]" (originKey.ts: https implied;
 * http only for loopback), so a loopback host may be either scheme. A full origin stands for itself.
 */
export const originsForOriginator = (originator: string | undefined | null): string[] => {
  if (!originator || typeof originator !== 'string') return [];
  const o = originator.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(o)) {
    const c = canonicalOrigin(o);
    return c ? [c] : [];
  }
  const https = canonicalOrigin(`https://${o}`);
  if (!https) return [];
  const host = new URL(https).hostname.toLowerCase();
  if (!isLoopbackHost(host)) return [https];
  const http = canonicalOrigin(`http://${o}`);
  return http ? [http, https] : [https];
};

/** signInBindingRefusal for a caller known only by its originator string. */
export const signInRefusalForOriginator = (
  method: string,
  args: unknown,
  originator: string | undefined,
  now = Date.now(),
  opts: { dev?: boolean } = {},
): string | null => {
  if (!PROTOCOL_METHODS.has(method) || !isSignInProtocol(obj(args)?.protocolID)) return null;
  const candidates = originsForOriginator(originator);
  if (candidates.length === 0) return signInBindingRefusal(method, args, undefined, now, opts);
  let refusal: string | null = null;
  for (const c of candidates) {
    refusal = signInBindingRefusal(method, args, c, now, opts);
    if (!refusal) return null;
  }
  return refusal;
};

type StoredKey = { type: string; originator: string; protocolLevel?: number; protocolName?: string };
type GrantStore = {
  listGrants(filter?: { type?: 'protocol' }): Promise<{ key: StoredKey }[]>;
  deleteGrant(key: never): Promise<void>;
};

/**
 * Remove every stored grant an outside originator holds for a sign-in protocol (upgrade migration, and before each
 * sign-in check so nothing stored can make a sign-in silent). Returns how many were removed.
 */
export const revokeSignInGrants = async (store: GrantStore, adminOriginator: string) => {
  const grants = await store.listGrants({ type: 'protocol' });
  let removed = 0;
  for (const g of grants) {
    const k = g.key;
    if (k.type !== 'protocol' || k.originator === adminOriginator) continue;
    if (!isSignInProtocol([k.protocolLevel, k.protocolName])) continue;
    await store.deleteGrant(k as never);
    removed++;
  }
  return removed;
};

type Fn = (...a: unknown[]) => Promise<unknown>;
type EnsureArgs = {
  originator?: string;
  protocolID?: unknown;
  privileged?: boolean;
  counterparty?: string;
  usageType?: string;
  reason?: string;
  seekPermission?: boolean;
};

export const SIGN_IN_PENDING_REFUSAL =
  'A sign-in from this site is already waiting for your answer; each sign-in gets its own sheet';

/**
 * Wrap the permissions manager (initWallet.ts) so that, whatever path reached it:
 * - createSignature under a sign-in protocol from an outside originator must be bound to that originator's origin;
 * - the hub protocol is refused for any other originator, on every protocol method and before any sheet;
 * - a sign-in grant is never stored: the approval covers the call in flight only (no "don't ask again", no grant that
 *   makes the next sign-in silent), and grouped (manifest) and counterparty grants drop sign-in protocols;
 * - no stored grant, cached grant, recent-grant cover or on-chain permission token ever answers a sign-in protocol:
 *   every call asks on its own sheet, never coalesced with another call, and a second sign-in from the same site
 *   while one is waiting is refused (one sheet per signature).
 */
export function guardSignInProtocols<T extends object>(
  manager: T,
  adminOriginator: string,
  opts: { now?: () => number; dev?: boolean } = {},
): T {
  const m = manager as Record<string, unknown>;
  const now = opts.now ?? Date.now;
  const isOutside = (originator: unknown) => originator !== adminOriginator;
  const store = () => m.permissionStore as GrantStore | undefined;
  // Every outside originator's stored sign-in grants (a small scan): whatever key form a grant was stored under.
  const forget = async () => {
    const s = store();
    if (s) await revokeSignInGrants(s, adminOriginator).catch(() => 0);
  };

  for (const method of PROTOCOL_METHODS) {
    const original = m[method];
    if (typeof original !== 'function') continue;
    m[method] = async (args: unknown, originator?: string) => {
      if (isOutside(originator)) {
        const refusal = signInRefusalForOriginator(method, args, originator, now(), { dev: opts.dev });
        if (refusal) throw new Error(refusal);
      }
      return (original as Fn).call(manager, args, originator);
    };
  }

  /**
   * One fresh approval for one sign-in call. The manager's own ensureProtocolPermission is never used for a sign-in
   * protocol: it would answer from its store, its in-memory cache, its 15 s "recent grant" cover or an on-chain
   * permission token without a sheet, and it coalesces identical requests in flight into one sheet. Here each call
   * gets its own request ID (so nothing coalesces), and a second sign-in from the same site while one is waiting is
   * refused: one sheet per signature.
   */
  const inFlight = new Set<string>();
  let seq = 0;
  const freshApproval = async (args: EnsureArgs): Promise<boolean> => {
    const normalize = m.normalizeOriginator;
    const enqueue = m.enqueueAndFireEvent;
    if (typeof normalize !== 'function' || typeof enqueue !== 'function')
      throw new Error(`${SIGN_IN_REFUSAL}: the wallet cannot ask for this sign-in on its own sheet`);
    const site = String((normalize as (o: unknown) => string).call(manager, args.originator) || args.originator || '');
    if (inFlight.has(site)) throw new Error(SIGN_IN_PENDING_REFUSAL);
    inFlight.add(site);
    try {
      const request = {
        type: 'protocol' as const,
        originator: site,
        displayOriginator: args.originator,
        privileged: !!args.privileged,
        protocolID: args.protocolID,
        counterparty: args.counterparty ?? 'self',
        usageType: args.usageType,
        reason: args.reason,
        renewal: false,
      };
      seq += 1;
      return (await (enqueue as Fn).call(manager, request, `signin-${seq}-${now()}`)) === true;
    } finally {
      inFlight.delete(site);
    }
  };

  const ensure = m.ensureProtocolPermission;
  if (typeof ensure === 'function') {
    m.ensureProtocolPermission = async (args: EnsureArgs) => {
      const kind = signInKind(args?.protocolID);
      if (kind && isOutside(args?.originator)) {
        if (kind === 'hub') {
          const ok = originsForOriginator(args.originator).some((o) => hubOrigins(opts.dev).includes(o));
          if (!ok) throw new Error(HUB_PROTOCOL_REFUSAL);
        }
        // Old stored grants are removed too, so no other path can ever find one.
        await forget();
        if (args.seekPermission === false) throw new Error(`${SIGN_IN_REFUSAL}: a sign-in always asks`);
        if (!(await freshApproval(args))) throw new Error(`${SIGN_IN_REFUSAL}: not approved`);
        return true;
      }
      return (ensure as Fn).call(manager, args);
    };
  }

  const grant = m.grantPermission;
  if (typeof grant === 'function') {
    m.grantPermission = async (params: { requestID?: string; ephemeral?: boolean; expiry?: number }) => {
      const pending = m.pendingSingle as Map<string, { type?: string; originator?: string; protocolID?: unknown }>;
      const req = pending instanceof Map && params?.requestID ? pending.get(params.requestID) : undefined;
      if (req?.type === 'protocol' && isSignInProtocol(req.protocolID) && isOutside(req.originator)) {
        // LocalWalletPermissionsManager writes the grant only for a request it still holds: drop it, so the approval
        // resolves the call in flight (super.grantPermission ephemeral) and nothing is stored.
        pending.delete(params.requestID!);
        const r = await (grant as Fn).call(manager, { ...params, ephemeral: true });
        await forget();
        return r;
      }
      return (grant as Fn).call(manager, params);
    };
  }

  const grouped = m.grantGroupedPermission;
  if (typeof grouped === 'function') {
    m.grantGroupedPermission = async (params: { granted?: { protocolPermissions?: { protocolID?: unknown }[] } }) => {
      if (params?.granted?.protocolPermissions)
        params = {
          ...params,
          granted: {
            ...params.granted,
            protocolPermissions: params.granted.protocolPermissions.filter((p) => !isSignInProtocol(p.protocolID)),
          },
        };
      return (grouped as Fn).call(manager, params);
    };
  }

  const pact = m.grantCounterpartyPermission;
  if (typeof pact === 'function') {
    m.grantCounterpartyPermission = async (params: {
      granted?: { protocols?: { protocolID?: unknown; protocolName?: string }[] };
    }) => {
      if (params?.granted?.protocols)
        params = {
          ...params,
          granted: {
            ...params.granted,
            protocols: params.granted.protocols.filter(
              (p) => !isSignInProtocol(p.protocolID ?? [2, String(p.protocolName ?? '')]),
            ),
          },
        };
      return (pact as Fn).call(manager, params);
    };
  }
  return manager;
}
