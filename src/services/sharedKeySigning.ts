/**
 * Sign-in tokens other services accept: one approval per signature (b-Aware, Limenelo, 13 Nov 2026, HIGH).
 *
 * BRC-42 keys depend on protocol, keyID and counterparty, never on the app that asks. A signature with counterparty
 * 'anyone' can be checked by anybody holding the user's public identity key, so a signature a site gets under a
 * sign-in protocol works as a bearer token at EVERY service that accepts that protocol. BitPlan's documented token is
 * exactly that: protocol 'bitcoin auth' at level 1, keyID = a timestamp, counterparty 'anyone', and it can change the
 * account and spend its credits. Before this, one tap on a pre-ticked "Prove it's you" line stored a standing grant
 * (level 1 ignores the counterparty, so it covered 'anyone' too), and the site could mint fresh tokens with no sheet.
 *
 * Now a site's createSignature that has that shape always asks, and the answer covers that one signature only:
 *  - counterparty 'anyone', level 1 or 2 (level 0 signing is refused for sites already: reservedProtocols.ts), and
 *  - a sign-in protocol name (auth, login, sign in...), BRC-77's level-2 'message signing', or a timestamp keyID, and
 *  - not one of the sign-ins whose signature cannot be replayed elsewhere (ONE_TAP_SIGN_INS below).
 *
 * How: the request goes straight to the manager's own prompt queue (enqueueAndFireEvent) under a key of its own
 * ("once:..."), so a stored or grouped (manifest) grant can't answer it and two signatures never share one answer.
 * The background answers a "once:" request with oneUseGrant (stored already expired, oneShotGrant.ts), exactly as
 * the one Seal sheet does; then the signature is made on the base wallet, because the manager's own check would find
 * that expired grant and ask a second time. Everything else goes on to the manager unchanged.
 *
 * Pure apart from the manager it wraps, so it can be unit tested with the real LocalWalletPermissionsManager.
 */

/** Request IDs of one-signature requests start with this (the manager's own keys start "proto:"). */
export const ONE_USE_REQUEST_PREFIX = 'once:';

export const isOneUseRequestID = (requestID: unknown): boolean =>
  typeof requestID === 'string' && requestID.startsWith(ONE_USE_REQUEST_PREFIX);

/** The same words permissionBundle.ts reads as a sign-in protocol. */
export const SIGN_IN_NAME = /\b(auth|authentication|sign[- ]?in|login|log[- ]?in)\b/i;

/**
 * Sign-ins that keep their one tap (a standing grant, as before):
 *  - [2, 'bwallet sign in']: our own (bChatX, bit-sign). Its text names the site it is for, and the cross-site guard
 *    (crossSiteSignGuard.ts) refuses one naming another site, so it can't be replayed at a different service.
 *  - level-2 'auth message signature': BRC-103/104 mutual auth. Its counterparty is the server's key, never 'anyone',
 *    so it never reaches this check; listed so a future change can't make it one-use by accident.
 *  - [1, 'sigma']: post signatures, asked for with a site's first post (permissionBundle.ts POST_PROTOCOL).
 */
const ONE_TAP_SIGN_INS = new Set(['2:bwallet sign in', '2:auth message signature', '1:sigma']);

/** A keyID that is a time: unix seconds or milliseconds, or an ISO date (BitPlan's token uses the time as keyID). */
export const isTimeKeyID = (keyID: unknown): boolean => {
  if (typeof keyID !== 'string') return false;
  const k = keyID.trim();
  return /^\d{10}(?:\d{3})?(?:\.\d+)?$/.test(k) || /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(k);
};

type SignArgs = { protocolID?: unknown; keyID?: unknown; counterparty?: unknown; privileged?: unknown };

const asProtocol = (p: unknown): [number, string] | null =>
  Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'string' ? [p[0], p[1]] : null;

/**
 * True for a site's signature that can work as a sign-in token at other services, so it needs its own approval each
 * time. Only createSignature arguments are judged here.
 */
export const isBearerSignature = (args: unknown): boolean => {
  if (!args || typeof args !== 'object') return false;
  const a = args as SignArgs;
  const p = asProtocol(a.protocolID);
  if (!p || (p[0] !== 1 && p[0] !== 2) || a.counterparty !== 'anyone') return false;
  const name = p[1].trim().toLowerCase();
  if (ONE_TAP_SIGN_INS.has(`${p[0]}:${name}`)) return false;
  // A module's keys ("p <scheme>") are the asset modules' business (reservedProtocols.ts).
  if (name.startsWith('p ')) return false;
  return SIGN_IN_NAME.test(name) || name === 'message signing' || isTimeKeyID(a.keyID);
};

export const BEARER_SIGN_DENIED = 'Permission denied.';

type Manager = {
  createSignature?: (args: unknown, originator?: string) => Promise<unknown>;
  enqueueAndFireEvent?: (request: Record<string, unknown>, key: string) => Promise<boolean>;
  underlying?: { createSignature: (args: unknown, originator?: string) => Promise<unknown> };
  isAdminProtocol?: (p: [number, string]) => boolean;
  prepareOriginator?: (originator: string) => { normalized: string };
};

/**
 * Wrap the manager's createSignature so a site's sign-in-token signature always asks, once per signature. Install it
 * inside the refusal guards (reserved protocols, cross-site), so a refused call never raises a sheet.
 */
export function guardSharedKeySigning<T extends object>(manager: T, deps: { adminOriginator: string }): T {
  const m = manager as T & Manager;
  const original = m.createSignature;
  // Same loud-fail rule as LocalWalletPermissionsManager's reach-ins: a renamed upstream member must never turn this
  // into a silent pass-through.
  if (
    typeof original !== 'function' ||
    typeof m.enqueueAndFireEvent !== 'function' ||
    typeof m.isAdminProtocol !== 'function' ||
    typeof m.prepareOriginator !== 'function'
  )
    throw new Error(
      'guardSharedKeySigning: permissions manager is missing createSignature/enqueueAndFireEvent/isAdminProtocol/prepareOriginator',
    );
  let seq = 0;
  m.createSignature = async (args: unknown, originator?: string) => {
    if (!originator || originator === deps.adminOriginator || !isBearerSignature(args))
      return original.call(manager, args, originator);
    const a = args as SignArgs;
    const protocolID = asProtocol(a.protocolID) as [number, string];
    // Admin-only names still get the manager's own refusal.
    if (m.isAdminProtocol!.call(manager, protocolID)) return original.call(manager, args, originator);
    // The manager's own originator rules (no scheme, no IP, a DNS name) and its site key (hostname only), as every
    // other request from this site is keyed; throws for an originator the manager would refuse.
    const site = m.prepareOriginator!.call(manager, originator).normalized;
    if (!site) throw new Error('Originator is required for permission checks.');
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
        // Level 1 has no counterparty in a request (the manager's own convention); the sheet knows it is 'anyone'.
        counterparty: protocolID[0] === 1 ? '' : 'anyone',
        usageType: 'signing',
        renewal: false,
        oneUse: true,
        ...(isTimeKeyID(a.keyID) ? { timeKeyID: true } : {}),
      },
      key,
    );
    if (granted !== true) throw Object.assign(new Error(BEARER_SIGN_DENIED), { code: 'ERR_PERMISSION_DENIED' });
    return underlying.createSignature(args, originator);
  };
  return manager;
}
