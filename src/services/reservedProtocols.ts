/**
 * Wallet-internal BRC-43 protocols that no outside site or app may use (security audit 19 Oct 2026, C1).
 *
 * BRC-42 key derivation does not include the calling app: protocol [1, 'btrust'] with keyID 'owner' gives a
 * dApp exactly the key the wallet uses for the user's bTrust lock, so one approval would let a site sign the
 * lock's withdrawal. Level 0 is worse: the permissions manager asks nothing at all, so [0, 'onesat'] (the
 * wallet's funds, ordinals and Locks keys) was open to any connected site.
 *
 * Every protocol the wallet itself derives keys under is listed here, and a call from any originator other
 * than the wallet's own is refused BEFORE any permission prompt, on every method that takes a protocolID.
 * src/services/reservedProtocols.test.ts scans src for protocol constants, so a new internal protocol fails
 * the tests until it is added here (or to EXTERNAL_OK with a reason).
 */

type Protocol = readonly [number, string];

/** Protocols only the wallet itself may use. Default for anything the wallet derives keys under. */
export const RESERVED_PROTOCOLS: readonly Protocol[] = [
  // Funds, ordinals, Locks, vesting, NFT ownership, deposit keys (@1sat ONESAT_PROTOCOL / P1SAT_PROTOCOL).
  [0, 'onesat'],
  // xInvites vault keys (src/mobile/chat/xInvites.ts).
  [0, 'bwx xinvites'],
  // bTrust owner / heir keys (src/mobile/btrust/inheritance.ts).
  [1, 'btrust'],
  // Token registry manifest signer (src/mobile/exchange/registry/manifest.ts).
  [1, 'bsv tokens manifest'],
  // The wallet's identity signatures (chat signer, name proofs, identity map).
  [1, 'message signing'],
  // Pre-signed payments / pots / subscriptions (src/mobile/presign/keys.ts).
  [2, 'bwalletx presign'],
  // bChatX / bit-sign sign-in for the wallet itself (src/mobile/auth/authApi.ts).
  [2, 'bwalletx auth'],
  [2, 'bwalletx business agent'],
  [2, 'bwallet calls'],
  [2, 'bwallet issuer'],
  [2, 'bwallet paymail'],
  [2, 'bwallet agreement'],
  [2, 'bwx partnership'],
  [2, 'bshares director'],
  [2, 'bshares treasury'],
  [2, 'bshares partner'],
  [2, 'bshares lock'],
  [2, 'bitsign kyc certificate'],
  [2, 'bitsign investor self cert'],
  [2, 'bitsign share offer event'],
  [2, 'bitsign account delete'],
  [2, 'bitsign handle claim'],
  [2, 'bmail'],
  [2, 'bmusic session'],
  [2, 'bmusic artist'],
  [2, 'bmusic listen claim'],
  [2, 'bpositive'],
];

/**
 * Protocols the wallet uses that outside apps legitimately need too. Still prompted (never auto-granted),
 * and hashToDirectlySign is refused for the ones in NO_RAW_HASH.
 */
export const EXTERNAL_OK: readonly (readonly [number, string, string])[] = [
  [2, 'bwallet sign in', 'Sign in with bWalletX (bwalletx-connect, bit-sign, bChatX)'],
  [0, 'fwetch identity', 'bit-sign fwetch feed signatures'],
  [2, '3241645161d8', 'BRC-29 payments: every BRC-100 payer derives these keys'],
];

/** Shared protocols whose keys hold the user's money: never sign a raw hash for an outside app. */
const NO_RAW_HASH: readonly Protocol[] = [[2, '3241645161d8']];

const key = (p: Protocol) => `${p[0]}:${p[1].trim().toLowerCase()}`;
const RESERVED = new Set(RESERVED_PROTOCOLS.map(key));
const RAW_HASH_REFUSED = new Set(NO_RAW_HASH.map(key));

const asProtocol = (p: unknown): Protocol | null =>
  Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'string' ? [p[0], p[1]] : null;

export const isReservedProtocol = (protocolID: unknown): boolean => {
  const p = asProtocol(protocolID);
  return !!p && RESERVED.has(key(p));
};

export const RESERVED_REFUSAL = 'This protocol is reserved for bWalletX itself';
export const RAW_HASH_REFUSAL =
  'Signing a raw hash with these keys could move your money; bWalletX refuses it for apps';

/** Wallet methods whose args carry a protocolID that selects a derived key. */
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
 * Why an outside caller's wallet call must be refused, or null when it may go on to the normal permission
 * checks. Callers decide "outside": anything but the wallet's own admin originator.
 */
export const reservedProtocolRefusal = (method: string, args: unknown): string | null => {
  if (!PROTOCOL_METHODS.has(method) || !args || typeof args !== 'object') return null;
  const a = args as { protocolID?: unknown; hashToDirectlySign?: unknown };
  if (a.protocolID === undefined || a.protocolID === null) return null;
  const p = asProtocol(a.protocolID);
  if (!p) return 'Invalid protocolID';
  if (RESERVED.has(key(p))) return `${RESERVED_REFUSAL}: "${p[1]}"`;
  if (method === 'createSignature' && a.hashToDirectlySign !== undefined && a.hashToDirectlySign !== null) {
    // Level-0 keys are shared by every app and the wallet; BRC-29 keys receive the user's payments.
    if (p[0] === 0 || RAW_HASH_REFUSED.has(key(p))) return RAW_HASH_REFUSAL;
  }
  return null;
};

/** Grouped (BRC-73) protocol entries an outside app may be granted: reserved ones are dropped. */
export const withoutReservedProtocols = <T extends { protocolID?: unknown }>(items: T[] | undefined): T[] =>
  (items ?? []).filter((p) => !isReservedProtocol(p.protocolID));

type ProtocolGrantStore = {
  listGrants(filter?: {
    type?: 'protocol';
  }): Promise<{ key: { type: string; originator: string; protocolLevel?: number; protocolName?: string } }[]>;
  deleteGrant(key: never): Promise<void>;
};

/**
 * Remove every stored grant an outside originator holds for a reserved protocol (upgrade migration; safe to
 * run on every unlock). Returns how many were removed.
 */
export const revokeReservedProtocolGrants = async (store: ProtocolGrantStore, adminOriginator: string) => {
  const grants = await store.listGrants({ type: 'protocol' });
  let removed = 0;
  for (const g of grants) {
    const k = g.key;
    if (k.type !== 'protocol' || k.originator === adminOriginator) continue;
    if (!isReservedProtocol([k.protocolLevel, k.protocolName])) continue;
    await store.deleteGrant(k as never);
    removed++;
  }
  return removed;
};

/**
 * Defence in depth inside the permissions manager: refuse reserved protocols for outside originators before
 * ensureProtocolPermission can prompt, and on every protocol method, whatever path reached the manager.
 */
export function guardReservedProtocols<T extends object>(manager: T, adminOriginator: string): T {
  const m = manager as Record<string, unknown>;
  const isOutside = (originator: unknown) => originator !== adminOriginator;
  for (const method of PROTOCOL_METHODS) {
    const original = m[method];
    if (typeof original !== 'function') continue;
    m[method] = async (args: unknown, originator?: string) => {
      if (isOutside(originator)) {
        const refusal = reservedProtocolRefusal(method, args);
        if (refusal) throw new Error(refusal);
      }
      return (original as (a: unknown, o?: string) => Promise<unknown>).call(manager, args, originator);
    };
  }
  const ensure = m.ensureProtocolPermission;
  if (typeof ensure === 'function') {
    m.ensureProtocolPermission = async (args: { originator?: string; protocolID?: unknown }) => {
      if (isOutside(args?.originator) && isReservedProtocol(args?.protocolID))
        throw new Error(`${RESERVED_REFUSAL}: "${String((args.protocolID as Protocol)[1])}"`);
      return (ensure as (a: unknown) => Promise<boolean>).call(manager, args);
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
            protocolPermissions: withoutReservedProtocols(params.granted.protocolPermissions),
          },
        };
      return (grouped as (p: unknown) => Promise<void>).call(manager, params);
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
              (p) => !isReservedProtocol(p.protocolID ?? [2, String(p.protocolName ?? '')]),
            ),
          },
        };
      return (pact as (p: unknown) => Promise<void>).call(manager, params);
    };
  }
  return manager;
}
