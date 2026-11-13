/**
 * The identity keys of the servers the wallet itself signs in to over BRC-103 (follow-up reviews, 13 Nov 2026).
 *
 * The wallet's own clients authenticate as the user with BRC-103 signatures: protocol [2, 'auth message signature'],
 * counterparty = that server's identity key. StorageClient does it for online storage (wallet.1sat.app), the
 * MessageBoxClient for bMail and Spaces doors (messagebox.bwalletx.com) and syncMessages for 1Sat's message box. BRC-42
 * keys don't depend on who asks, so a site granted the same protocol with one of those keys as counterparty would get
 * the same keys, open its own session with that server and act there as the user (read or rewrite the backup, read or
 * send mail). crossSiteSignGuard refuses that protocol from outside callers for these keys.
 *
 * The keys are NOT learned from signing calls (review A1: a site can make the wallet sign in to a server of its choice,
 * e.g. an acquireCertificate issuance certifier, which then picks the key the wallet would remember). They are:
 * - seeded: the first-party servers' keys below, read from their own BRC-103 handshakes;
 * - read at runtime from the wallet's own clients for the hosts it is configured with (the storage stores in use, a
 *   bMail host override), never from a host a site names.
 * Before one of those configured clients has connected, its key isn't known yet, so the protocol is refused for sites
 * until it has (fails closed).
 */

export const AUTH_MESSAGE_PROTOCOL = 'auth message signature';
const PUBKEY = /^0[23][0-9a-f]{64}$/;

/**
 * First-party server identity keys, read 13 Nov 2026 from each host's BRC-103 handshake (an AuthFetch with a throwaway
 * key; the key is what the server signs its initialResponse with). Public keys. If a server rotates its key, the
 * runtime sources below still cover it once the wallet has connected, and this list should be updated.
 */
export const FIRST_PARTY_SERVER_KEYS: Readonly<Record<string, string>> = {
  // messagebox.bwalletx.com: bMail and Spaces doors (src/mobile/bmail/client.ts BMAIL_DEFAULT_HOST).
  '021a8c3e9649e43fbc981aaf9cc366ccf0955df11bd79ef97b86c27387c5ca6723': 'messagebox.bwalletx.com',
  // 1Sat: one key for wallet.1sat.app (online storage, DEFAULT_STORAGE_REMOTE_URL), messagebox.1sat.app
  // (MESSAGEBOX_URL, syncMessages) and accounts.1sat.app.
  '0326a9865e5ec9809b72c92b82c86e5a39ca00c2fd215920e96f42477721425d4b': '1Sat (wallet / messagebox / accounts)',
};

/** Hosts whose keys are seeded above: their clients are never "pending". */
export const FIRST_PARTY_HOSTS: ReadonlySet<string> = new Set([
  'messagebox.bwalletx.com',
  'wallet.1sat.app',
  'messagebox.1sat.app',
  'accounts.1sat.app',
]);
export const isFirstPartyHost = (url: string | undefined) => {
  try {
    return !!url && FIRST_PARTY_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

/**
 * How long a configured server that hasn't connected (and whose key was never saved) keeps sites' BRC-103 signing
 * refused (polish, 13 Nov 2026). Past it the guard stops waiting: a custom backup that never connects must not block
 * every site for the whole session. The small risk this leaves: a server the wallet itself has never reached, on this
 * device or any earlier session, isn't protected after the first two minutes; once the wallet reaches it, its key is
 * saved and protected for good.
 */
export const OWN_SERVER_PENDING_MS = 2 * 60_000;

// Keys the wallet's own clients verified for configured hosts this session (origin -> key). Covers the moment the SDK
// drops a stale session (its peer entry goes, the key mustn't) and each new bMail client before it reconnects.
const verified = new Map<string, string>();
const validKey = (k: unknown): string | null =>
  typeof k === 'string' && PUBKEY.test(k.trim().toLowerCase()) ? k.trim().toLowerCase() : null;

/** One configured host: the live key if its client has one, else this session's, else the saved one, else pending. */
const configuredServer = (
  url: string,
  authFetch: unknown,
  opts: { saved?: string | null; onLearn?: (origin: string, key: string) => void; pendingUntil?: number },
): OwnServer[] => {
  const origin = originOf(url);
  const live = validKey(peerKeyOf(authFetch, url));
  const saved = validKey(opts.saved);
  if (origin && live) {
    if (verified.get(origin) !== live) verified.set(origin, live);
    if (live !== saved) opts.onLearn?.(origin, live);
  }
  const keys = [...new Set([live, origin ? verified.get(origin) : undefined, saved].filter((k): k is string => !!k))];
  if (keys.length) return keys.map((key) => ({ key }));
  const waiting = opts.pendingUntil === undefined || Date.now() < opts.pendingUntil;
  return [{ key: null, pending: waiting && !isFirstPartyHost(url) }];
};

/**
 * The storage stores a WalletStorageManager has in use: each remote store's server key once its StorageClient has
 * connected (AuthFetch verified it), or the key saved when it first did (`saved`, origin -> key, kept in the account's
 * storage config; `onLearn` saves a new one). A remote on a host not seeded above, with neither, is pending until
 * `pendingUntil`.
 */
export const storageServers = (
  storage: unknown,
  opts: { saved?: Record<string, string>; onLearn?: (origin: string, key: string) => void; pendingUntil?: number } = {},
): OwnServer[] =>
  ((storage as { _stores?: { storage?: { endpointUrl?: string; authClient?: unknown } }[] } | null)?._stores ?? [])
    .map((m) => m.storage)
    .filter((c): c is { endpointUrl: string; authClient?: unknown } => !!c && typeof c.endpointUrl === 'string')
    .flatMap((c) => {
      const origin = originOf(c.endpointUrl);
      return configuredServer(c.endpointUrl, c.authClient, {
        saved: origin ? opts.saved?.[origin] : undefined,
        onLearn: opts.onLearn,
        pendingUntil: opts.pendingUntil,
      });
    });

/** Protocol [2, 'auth message signature']: every @bsv/sdk Peer (BRC-103) signature. */
export const isAuthMessageArgs = (args: unknown): boolean => {
  const p = (args as { protocolID?: unknown } | null)?.protocolID;
  return (
    Array.isArray(p) &&
    p[0] === 2 &&
    typeof p[1] === 'string' &&
    p[1].trim().toLowerCase().replace(/\s+/g, ' ') === AUTH_MESSAGE_PROTOCOL
  );
};

/** One configured server: its key once the wallet's own client has connected; `pending` until then. */
export type OwnServer = { key?: string | null; pending?: boolean };
const sources = new Map<string, () => OwnServer[]>();

/** Register (or replace) a runtime source of first-party server keys, read on every check. */
export const setOwnServerSource = (name: string, source: (() => OwnServer[]) | null) => {
  if (source) sources.set(name, source);
  else sources.delete(name);
};

type PeerHolder = { peers?: Record<string, { identityKey?: string } | undefined> };
const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
/** The identity key an AuthFetch learned from `url`'s origin (verified in its handshake), or null. */
export const peerKeyOf = (authFetch: unknown, url: string | undefined): string | null => {
  const origin = url ? originOf(url) : null;
  const key = origin ? (authFetch as PeerHolder | null)?.peers?.[origin]?.identityKey : undefined;
  return typeof key === 'string' ? key : null;
};

// A bMail host override's key, saved once its client has connected (origin -> key), so later sessions and each new
// client aren't pending. Written only from the wallet's own client for the configured host.
const SAVED_HOST_KEYS = 'bwx.own-server-keys';
const savedHostKeys = (): Record<string, string> => {
  try {
    const v = JSON.parse(typeof localStorage === 'undefined' ? '{}' : (localStorage.getItem(SAVED_HOST_KEYS) ?? '{}'));
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
};
const saveHostKey = (origin: string, key: string) => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SAVED_HOST_KEYS, JSON.stringify({ ...savedHostKeys(), [origin]: key }));
  } catch {
    /* kept for this session only */
  }
};

/**
 * Track the wallet's own client for a configured host (bMail, Spaces doors): its server key counts once connected, and
 * is saved for later sessions. A host other than the seeded first-party ones with no key yet is pending, for at most
 * OWN_SERVER_PENDING_MS from the first time it is tracked.
 */
const trackedSince = new Map<string, number>();
export const trackOwnAuthFetch = (name: string, authFetch: unknown, url: string) => {
  const origin = originOf(url);
  if (origin && !trackedSince.has(origin)) trackedSince.set(origin, Date.now());
  const pendingUntil = (origin ? (trackedSince.get(origin) ?? Date.now()) : Date.now()) + OWN_SERVER_PENDING_MS;
  setOwnServerSource(name, () =>
    configuredServer(url, authFetch, {
      saved: origin ? savedHostKeys()[origin] : undefined,
      onLearn: saveHostKey,
      pendingUntil,
    }),
  );
};

const ownKeys = (): { keys: Set<string>; pending: boolean } => {
  const keys = new Set(Object.keys(FIRST_PARTY_SERVER_KEYS));
  let pending = false;
  for (const source of sources.values()) {
    let list: OwnServer[] = [];
    try {
      list = source();
    } catch {
      pending = true; // a source that can't answer can't say a key isn't ours
    }
    for (const s of list) {
      if (typeof s.key === 'string' && PUBKEY.test(s.key.toLowerCase())) keys.add(s.key.toLowerCase());
      else if (s.pending) pending = true;
    }
  }
  return { keys, pending };
};

export const isOwnBackend = (counterparty: unknown): boolean =>
  typeof counterparty === 'string' && ownKeys().keys.has(counterparty.trim().toLowerCase());

export const OWN_BACKEND_REFUSAL = "Sites cannot sign in as you to the wallet's own servers (online storage or bMail)";
export const OWN_BACKEND_PENDING =
  'The wallet is still connecting to its own servers, so it cannot check this sign-in yet. Try again in a moment';

/**
 * Why an outside caller's call must be refused: BRC-103 signing towards one of the wallet's own servers, or towards
 * any server while a configured one hasn't connected yet (its key unknown).
 */
export const ownBackendRefusal = (args: unknown): string | null => {
  if (!isAuthMessageArgs(args)) return null;
  const cp = (args as { counterparty?: unknown }).counterparty;
  if (typeof cp !== 'string' || !PUBKEY.test(cp.trim().toLowerCase())) return null;
  const { keys, pending } = ownKeys();
  if (keys.has(cp.trim().toLowerCase())) return OWN_BACKEND_REFUSAL;
  return pending ? OWN_BACKEND_PENDING : null;
};

/**
 * 5.2.56 candidate builds (46be94c9) learned keys from signing calls and saved them; some may be a certifier's or a
 * site's own server (review A1b). Drop that saved list once, so none of them stays refused.
 */
export const LEGACY_STORE_KEY = 'bwx-own-backend-keys';
export const clearLearnedOwnBackends = () => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_STORE_KEY);
  } catch {
    /* no storage */
  }
  try {
    const local = (globalThis as { chrome?: { storage?: { local?: { remove?: (k: string) => unknown } } } }).chrome
      ?.storage?.local;
    const r = local?.remove?.(LEGACY_STORE_KEY);
    void (r as Promise<unknown> | undefined)?.catch?.(() => {});
  } catch {
    /* no chrome.storage */
  }
};

/** Tests only. */
export const _resetOwnBackends = () => {
  sources.clear();
  verified.clear();
  trackedSince.clear();
};
