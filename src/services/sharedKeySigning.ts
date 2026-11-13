/**
 * Signatures other services accept as you: one approval per signature (b-Aware, Limenelo, 13 Nov 2026, HIGH).
 *
 * BRC-42 keys depend on protocol, keyID and counterparty, never on the app that asks. A signature with counterparty
 * 'anyone' can be checked by anybody holding the user's public identity key, so a signature a site gets under a
 * sign-in protocol works as a bearer token at EVERY service that accepts that protocol. BitPlan's documented token is
 * exactly that: protocol 'bitcoin auth' at level 1, keyID = a timestamp, counterparty 'anyone', and it can change the
 * account and spend its credits. Before this, one tap on a pre-ticked line stored a standing grant (level 1 ignores the
 * counterparty, so it covered 'anyone' too), and the site could mint fresh tokens with no sheet.
 *
 * 'anyone' has three spellings (review of ae664e79): the word, a missing counterparty on createSignature (the SDK
 * signs with `counterparty ?? 'anyone'` while the manager checks the permission as 'self'), and the 'anyone' public
 * key itself (the point 1·G) written out in any hex form. Every protocol call from a site is rewritten to the one
 * spelling 'anyone' first (canonicalCounterparty), so the manager, the sheet and this check all see what is signed.
 *
 * The rule, for a site's createSignature:
 *  - level 1, any counterparty but 'self': ALWAYS one approval per signature, whatever the name or keyID (consent
 *    polish, 13 Nov 2026: a named counterparty too, so a standing level-1 grant only ever signs as 'self'). A level-1
 *    grant can't be limited to a counterparty, so no stored grant (sheet, manifest, or from before this fix) may answer
 *    it. The one exception, LEVEL1_ANYONE_OK, holds only for the hosts listed with it.
 *  - level 2 with counterparty 'anyone': one approval per signature when it looks like a token: a sign-in name (auth,
 *    login, sign in...), BRC-77 'message signing', or a time in the keyID. Our own one-tap sign-ins
 *    (ONE_TAP_SIGN_INS) keep their grant.
 *  - level 0 signing is refused for sites already (reservedProtocols.ts).
 *
 * How: the request goes straight to the manager's prompt queue (enqueueAndFireEvent) under a key of its own
 * ("once:..."), so no stored or grouped (manifest) grant can answer it and two signatures never share one answer.
 * Answering a "once:" request never stores anything (guarded grantPermission below, whatever expiry a caller passes):
 * the waiting signature is released and any standing grant for that protocol is left as it was. Then the signature is
 * made on the base wallet, because the manager's own check would otherwise ask a second time.
 *
 * Pure apart from the manager it wraps, so it can be unit tested with the real LocalWalletPermissionsManager.
 */
import { PublicKey } from '@bsv/sdk';

/** Request IDs of one-signature requests start with this (the manager's own keys start "proto:"). */
export const ONE_USE_REQUEST_PREFIX = 'once:';

export const isOneUseRequestID = (requestID: unknown): boolean =>
  typeof requestID === 'string' && requestID.startsWith(ONE_USE_REQUEST_PREFIX);

/** The same words permissionBundle.ts reads as a sign-in protocol. */
export const SIGN_IN_NAME = /\b(auth|authentication|sign[- ]?in|login|log[- ]?in)\b/i;

/** The 'anyone' public key (private key 1, the generator point), compressed: what 'anyone' means to the SDK. */
export const ANYONE_PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

/** True for 'anyone' or the 'anyone' key in any hex spelling (compressed or not, any case). */
export const isAnyoneCounterparty = (cp: unknown): boolean => {
  if (cp === 'anyone') return true;
  if (typeof cp !== 'string' || !/^[0-9a-fA-F]{66}$|^[0-9a-fA-F]{130}$/.test(cp.trim())) return false;
  const hex = cp.trim().toLowerCase();
  if (hex === ANYONE_PUBLIC_KEY) return true;
  try {
    return PublicKey.fromString(hex).toString() === ANYONE_PUBLIC_KEY;
  } catch {
    return false;
  }
};

/**
 * The counterparty a call really uses, in one spelling: 'anyone' for the word, the written-out 'anyone' key, and (on
 * createSignature only, where the SDK defaults to it) a missing one. Anything else is returned as given.
 */
export const canonicalCounterparty = (method: string, cp: unknown): unknown => {
  if (method === 'createSignature' && (cp === undefined || cp === null)) return 'anyone';
  return isAnyoneCounterparty(cp) ? 'anyone' : cp;
};

/**
 * Our own sign-ins that keep their one tap (a standing grant, as before), by "level:name" (name lower-cased and
 * trimmed, as the SDK derives keys from it):
 *  - 'bwallet sign in' (bChatX, bit-sign): its text names the site it is for, and the cross-site guard
 *    (crossSiteSignGuard.ts) refuses one naming another site, so it can't be replayed at a different service.
 *  - 'bads session' (badvertisingx.com): the same, its challenge text carries "Origin: <site>".
 *  - 'auth message signature': BRC-103/104 mutual auth. Its counterparty is the server's key, never 'anyone', so it
 *    never reaches this check; listed so a later change can't make it one-use by accident.
 */
const ONE_TAP_SIGN_INS = new Set(['2:bwallet sign in', '2:bads session', '2:auth message signature']);

/**
 * Level-1 'anyone' signatures that may be remembered, by name, and only for the hosts listed (and their subdomains).
 * Found by reading what apps really sign (13 Nov 2026): @1sat/actions signs level 1 only under 'sigma' with
 * counterparty 'self' and under the wallet-reserved 'message signing'; @bsv/sdk's level-1 names (kvstore, protomap,
 * basketmap, certmap, identity...) are not signed as 'anyone' by sites; bit-sign (bChatX) signs a scheduled Space's
 * calendar record under 'bcal record' as 'anyone' (src/lib/bcal-anchor-client.ts, keyID = the event id), and bit-sign
 * and bCalX treat that signature as the record's authority. So it is pinned to the hosts that publish those records
 * (the bChat app: bchatx.com, chat.bwalletx.com, bit-sign.online; and bcalx.com): from any other site, a 'bcal record'
 * signature asks every time (review of 1020b69c: otherwise any site could publish fake Spaces as the user).
 */
const LEVEL1_ANYONE_OK = new Map<string, readonly string[]>([
  ['bcal record', ['bchatx.com', 'chat.bwalletx.com', 'bit-sign.online', 'bcalx.com']],
]);

/** The host is one of `hosts` or a dot-boundary subdomain of one (never a parent, never a sibling). */
const hostIn = (host: string | undefined, hosts: readonly string[]) =>
  !!host && hosts.some((h) => host === h || host.endsWith(`.${h}`));

const protoKey = (p: readonly [number, string]) => `${p[0]}:${p[1].trim().toLowerCase()}`;

/** A one-tap sign-in of ours (see ONE_TAP_SIGN_INS). */
export const isOneTapSignIn = (protocolID: unknown): boolean => {
  const p = asProtocol(protocolID);
  return !!p && ONE_TAP_SIGN_INS.has(protoKey(p));
};

/** A level-1 name whose 'anyone' signatures this host may have remembered (see LEVEL1_ANYONE_OK). */
export const isLevel1AnyoneOk = (protocolID: unknown, host: string | undefined): boolean => {
  const p = asProtocol(protocolID);
  if (!p || p[0] !== 1) return false;
  const hosts = LEVEL1_ANYONE_OK.get(p[1].trim().toLowerCase());
  return !!hosts && hostIn(host?.toLowerCase(), hosts);
};

/**
 * A keyID that carries a time: unix seconds or milliseconds (9 to 13 digits) standing alone or between separators
 * ("1763040000", "ts-1763040000-nonce"), or a date (ISO "2026-11-13T10:00" or compact "20261113T100000Z").
 * Digits inside a hex nonce don't count, so a random nonce isn't taken for a time.
 */
export const isTimeKeyID = (keyID: unknown): boolean => {
  if (typeof keyID !== 'string') return false;
  const k = keyID.trim();
  return (
    /(?:^|[^0-9a-zA-Z])\d{9,13}(?:\.\d+)?(?:[^0-9a-zA-Z]|$)/.test(k) ||
    /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/.test(k) ||
    /\d{8}T\d{4,6}/i.test(k)
  );
};

type SignArgs = {
  protocolID?: unknown;
  keyID?: unknown;
  counterparty?: unknown;
  privileged?: unknown;
  privilegedReason?: unknown;
};

function asProtocol(p: unknown): [number, string] | null {
  return Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'string'
    ? [p[0], p[1]]
    : null;
}

/**
 * True for a site's createSignature that needs its own approval every time (the rule above). Reads the counterparty
 * the signature really uses: missing, 'anyone' and the written-out 'anyone' key all count as 'anyone'. `host` is the
 * calling site's hostname (the manager's site key); without it no host-pinned exception applies.
 */
export const isBearerSignature = (args: unknown, host?: string): boolean => {
  if (!args || typeof args !== 'object') return false;
  const a = args as SignArgs;
  const p = asProtocol(a.protocolID);
  if (!p || (p[0] !== 1 && p[0] !== 2)) return false;
  const cp = canonicalCounterparty('createSignature', a.counterparty);
  const name = p[1].trim().toLowerCase();
  // A module's keys ("p <scheme>") are the asset modules' business (reservedProtocols.ts).
  if (name.startsWith('p ')) return false;
  // Level 1: every signature not made as 'self' (a level-1 grant covers every counterparty).
  if (p[0] === 1) return cp !== 'self' && !(cp === 'anyone' && isLevel1AnyoneOk(p, host));
  if (cp !== 'anyone') return false;
  if (ONE_TAP_SIGN_INS.has(protoKey(p))) return false;
  return SIGN_IN_NAME.test(name) || name === 'message signing' || isTimeKeyID(a.keyID);
};

export const BEARER_SIGN_DENIED = 'Permission denied.';

/** Wallet methods whose args carry a counterparty that selects a derived key. */
const COUNTERPARTY_METHODS = [
  'getPublicKey',
  'createSignature',
  'verifySignature',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'revealSpecificKeyLinkage',
] as const;

type Fn = (args: unknown, originator?: string) => Promise<unknown>;
type Manager = Partial<Record<(typeof COUNTERPARTY_METHODS)[number], Fn>> & {
  grantPermission?: (params: { requestID: string; ephemeral?: boolean; expiry?: number }) => Promise<void>;
  enqueueAndFireEvent?: (request: Record<string, unknown>, key: string) => Promise<boolean>;
  underlying?: { createSignature: Fn };
  isAdminProtocol?: (p: [number, string]) => boolean;
  prepareOriginator?: (originator: string) => { normalized: string };
  pendingSingle?: Map<string, unknown>;
};

/**
 * Install on the permissions manager, inside the refusal guards (reserved protocols, cross-site), so a refused call
 * never raises a sheet:
 *  - every protocol call from a site has its counterparty rewritten to the one spelling it really uses;
 *  - a site's createSignature that isBearerSignature asks every time, under a "once:" request;
 *  - answering a "once:" request never stores a grant.
 */
export function guardSharedKeySigning<T extends object>(manager: T, deps: { adminOriginator: string }): T {
  const m = manager as T & Manager;
  // Same loud-fail rule as LocalWalletPermissionsManager's reach-ins: a renamed upstream member must never turn this
  // into a silent pass-through.
  if (
    typeof m.createSignature !== 'function' ||
    typeof m.grantPermission !== 'function' ||
    typeof m.enqueueAndFireEvent !== 'function' ||
    typeof m.isAdminProtocol !== 'function' ||
    typeof m.prepareOriginator !== 'function' ||
    !(m.pendingSingle instanceof Map)
  )
    throw new Error(
      'guardSharedKeySigning: permissions manager is missing createSignature/grantPermission/enqueueAndFireEvent/' +
        'isAdminProtocol/prepareOriginator/pendingSingle',
    );
  const outside = (originator: unknown) => !!originator && originator !== deps.adminOriginator;

  // 1. One spelling of the counterparty, for every method, before the manager checks the permission.
  for (const method of COUNTERPARTY_METHODS) {
    const original = m[method];
    if (typeof original !== 'function') continue;
    m[method] = async (args: unknown, originator?: string) => {
      if (outside(originator) && args && typeof args === 'object' && !Array.isArray(args)) {
        const a = args as SignArgs;
        const cp = canonicalCounterparty(method, a.counterparty);
        if (cp !== a.counterparty) args = { ...a, counterparty: cp };
      }
      return original.call(manager, args, originator);
    };
  }

  // 2. Answering a "once:" request releases that one call and stores nothing (the manager stores a grant for every
  //    request still in its pendingSingle map; taking it out first leaves only the release).
  const grant = m.grantPermission;
  m.grantPermission = async (params) => {
    if (!isOneUseRequestID(params?.requestID)) return grant.call(manager, params);
    m.pendingSingle!.delete(params.requestID);
    return grant.call(manager, { requestID: params.requestID, ephemeral: true, expiry: 1 });
  };

  // 3. Tokens: their own request, every time.
  const sign = m.createSignature as Fn;
  let seq = 0;
  m.createSignature = async (args: unknown, originator?: string) => {
    if (!outside(originator)) return sign.call(manager, args, originator);
    // The manager's own originator rules (no scheme, no IP, a DNS name) and its site key (hostname only), as every
    // other request from this site is keyed. An originator it refuses goes on to the manager, which refuses it.
    let site = '';
    try {
      site = m.prepareOriginator!.call(manager, originator as string).normalized;
    } catch {
      return sign.call(manager, args, originator);
    }
    if (!site || !isBearerSignature(args, site)) return sign.call(manager, args, originator);
    const a = args as SignArgs;
    const protocolID = asProtocol(a.protocolID) as [number, string];
    // Admin-only names still get the manager's own refusal.
    if (m.isAdminProtocol!.call(manager, protocolID)) return sign.call(manager, args, originator);
    const underlying = m.underlying;
    if (!underlying || typeof underlying.createSignature !== 'function')
      throw new Error('guardSharedKeySigning: permissions manager has no underlying wallet');
    seq = (seq + 1) % Number.MAX_SAFE_INTEGER;
    const key = `${ONE_USE_REQUEST_PREFIX}${site}:${protocolID[0]},${protocolID[1]}:${Date.now().toString(36)}.${seq}`;
    const granted = await m.enqueueAndFireEvent!.call(
      manager,
      {
        type: 'protocol',
        originator: site,
        displayOriginator: originator,
        privileged: a.privileged === true,
        protocolID,
        // Level 1 has no counterparty in a request (the manager's own convention).
        counterparty: protocolID[0] === 1 ? '' : 'anyone',
        usageType: 'signing',
        ...(typeof a.privilegedReason === 'string' ? { reason: a.privilegedReason } : {}),
        renewal: false,
        oneUse: true,
      },
      key,
    );
    if (granted !== true) throw Object.assign(new Error(BEARER_SIGN_DENIED), { code: 'ERR_PERMISSION_DENIED' });
    // Signed exactly as asked, in the one spelling of its counterparty (a missing one is 'anyone', as the SDK signs it).
    return underlying.createSignature(
      { ...a, counterparty: canonicalCounterparty('createSignature', a.counterparty) },
      originator,
    );
  };
  return manager;
}

type GrantStore = {
  listGrants(filter?: { type?: 'protocol' }): Promise<
    {
      key: {
        type: string;
        originator: string;
        protocolLevel?: number;
        protocolName?: string;
        counterparty?: string;
      };
    }[]
  >;
  deleteGrant(key: never): Promise<void>;
};

/**
 * Whether the upgrade removes a stored protocol grant:
 *  - level 1: only sign-in-shaped names (auth, login, sign in..., 'message signing'). Those were granted as a
 *    pre-ticked "sign in". Other level-1 grants stay (consent polish, 13 Nov 2026): every level-1 signature not made
 *    as 'self' now asks on its own whatever is stored, so they can't make a signature anyone can check.
 *  - level 2: every grant for 'anyone' (any spelling) except our one-tap sign-ins.
 *  - when unsure (no level, no name): removed.
 */
export const isSharedKeyGrant = (key: {
  protocolLevel?: number;
  protocolName?: string;
  counterparty?: string;
}): boolean => {
  const name = typeof key.protocolName === 'string' ? key.protocolName.trim().toLowerCase() : '';
  if (!name || (key.protocolLevel !== 1 && key.protocolLevel !== 2)) return true;
  if (key.protocolLevel === 1) return SIGN_IN_NAME.test(name) || name === 'message signing';
  return isAnyoneCounterparty(key.counterparty) && !ONE_TAP_SIGN_INS.has(`2:${name}`);
};

/**
 * Upgrade migration (review of ae664e79): remove every stored grant a site holds that isSharedKeyGrant, whether it
 * came from a sheet or a manifest (both are stored the same way). They were given by a pre-ticked line before this
 * fix. Returns how many were removed. Run once per account (see revokeSharedKeyGrantsOnce): a grant the user gives
 * after the upgrade, knowingly on an unticked line, is kept.
 */
export const revokeSharedKeyGrants = async (store: GrantStore, adminOriginator: string): Promise<number> => {
  const grants = await store.listGrants({ type: 'protocol' });
  let removed = 0;
  for (const g of grants) {
    const k = g.key;
    if (k.type !== 'protocol' || k.originator === adminOriginator || !isSharedKeyGrant(k)) continue;
    await store.deleteGrant(k as never);
    removed++;
  }
  return removed;
};

export const SHARED_KEY_MIGRATION_KEY = (accountId: string) => `bwx-shared-key-grants-revoked-v1:${accountId}`;

/**
 * revokeSharedKeyGrants, once per account. The done-flag is written only after the revocation succeeded; if it can't
 * be read, the revocation runs (fails closed: removing a grant only means the site asks again).
 */
export const revokeSharedKeyGrantsOnce = async (
  store: GrantStore,
  adminOriginator: string,
  kv: { get: (k: string) => Promise<Record<string, unknown>>; set: (items: Record<string, unknown>) => Promise<void> },
  accountId: string,
): Promise<number> => {
  const flag = SHARED_KEY_MIGRATION_KEY(accountId || 'no-account');
  let done = false;
  try {
    done = (await kv.get(flag))?.[flag] === true;
  } catch {
    done = false;
  }
  if (done) return 0;
  const n = await revokeSharedKeyGrants(store, adminOriginator);
  await kv.set({ [flag]: true });
  return n;
};
