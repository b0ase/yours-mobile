/**
 * The identity keys of the servers the wallet itself signs in to over BRC-103 (follow-up review, 13 Nov 2026).
 *
 * The wallet's own clients (StorageClient for remote/backup storage, MessageBoxClient for bMail and Spaces doors)
 * authenticate as the user with BRC-103 signatures: protocol [2, 'auth message signature'], counterparty = that
 * server's identity key. BRC-42 keys don't depend on who asks, so a site granted the same protocol with one of those
 * keys as counterparty gets the same keys, and could open its own BRC-103 session with our storage server or bMail
 * inbox and act there as the user (read or rewrite the backup, read or send mail). The permission sheet only shows
 * 'Sign and encrypt with your "auth message signature" keys, shared with one named person or service', which no one
 * can judge.
 *
 * So every counterparty the wallet itself uses under that protocol is remembered here (persisted, so it holds after a
 * restart before the wallet has talked to the server again), and crossSiteSignGuard refuses that protocol from outside
 * callers for those counterparties. Learning can only add refusals, never remove one, so a key noted by mistake costs
 * a site that one counterparty and nothing else.
 */

export const AUTH_MESSAGE_PROTOCOL = 'auth message signature';
const STORE_KEY = 'bwx-own-backend-keys';
const MAX_KEYS = 256;
const PUBKEY = /^0[23][0-9a-f]{64}$/;

const known = new Set<string>();

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

type ChromeLocal = {
  get: (k: string) => Promise<Record<string, unknown>>;
  set: (v: Record<string, unknown>) => Promise<void>;
};
const chromeLocal = (): ChromeLocal | null => {
  try {
    const l = (globalThis as { chrome?: { storage?: { local?: ChromeLocal } } }).chrome?.storage?.local;
    return l && typeof l.get === 'function' && typeof l.set === 'function' ? l : null;
  } catch {
    return null;
  }
};
const webStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const add = (list: unknown) => {
  if (!Array.isArray(list)) return;
  for (const k of list) if (typeof k === 'string' && PUBKEY.test(k) && known.size < MAX_KEYS) known.add(k);
};

const persist = () => {
  const list = [...known];
  try {
    webStorage()?.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* private mode / no storage: kept in memory */
  }
  try {
    void chromeLocal()
      ?.set({ [STORE_KEY]: list })
      ?.catch?.(() => {});
  } catch {
    /* no chrome.storage */
  }
};

let loading: Promise<void> | null = null;
/** Resolves once the remembered keys are read back (at most once; a failed read counts as read). */
export const ownBackendsReady = (): Promise<void> => {
  if (!loading) {
    try {
      add(JSON.parse(webStorage()?.getItem(STORE_KEY) ?? '[]'));
    } catch {
      /* unreadable: start from what we learn */
    }
    const l = chromeLocal();
    loading = l
      ? Promise.race([
          Promise.resolve()
            .then(() => l.get(STORE_KEY))
            .then((v) => add(v?.[STORE_KEY]))
            .catch(() => {}),
          new Promise<void>((r) => setTimeout(r, 2000)),
        ])
      : Promise.resolve();
  }
  return loading;
};

/** Remember a counterparty the wallet itself signs in to under the BRC-103 protocol. */
export const noteOwnBackend = (counterparty: unknown) => {
  if (typeof counterparty !== 'string') return;
  const k = counterparty.trim().toLowerCase();
  if (!PUBKEY.test(k) || known.has(k) || known.size >= MAX_KEYS) return;
  known.add(k);
  persist();
};

/** Note the counterparty of a BRC-103 call the wallet itself makes (createSignature / verifySignature args). */
export const noteOwnBackendCall = (args: unknown) => {
  if (isAuthMessageArgs(args)) noteOwnBackend((args as { counterparty?: unknown }).counterparty);
};

export const isOwnBackend = (counterparty: unknown): boolean =>
  typeof counterparty === 'string' && known.has(counterparty.trim().toLowerCase());

export const OWN_BACKEND_REFUSAL = "Sites cannot sign in as you to the wallet's own servers (online storage or bMail)";

/** Why an outside caller's call must be refused: BRC-103 signing towards one of the wallet's own servers. */
export const ownBackendRefusal = (args: unknown): string | null =>
  isAuthMessageArgs(args) && isOwnBackend((args as { counterparty?: unknown }).counterparty)
    ? OWN_BACKEND_REFUSAL
    : null;

type SignerProto = {
  createSignature?: (args: unknown, originator?: string) => Promise<unknown>;
  verifySignature?: (args: unknown, originator?: string) => Promise<unknown>;
};
const PATCHED = Symbol.for('bwx.ownBackendLearning');

/**
 * Learn from the wallet's own BRC-103 calls: patch a wallet class (the toolbox Wallet that StorageClient and every
 * manager call end in) so createSignature / verifySignature under the protocol note their counterparty when the
 * caller is the wallet itself (no originator, or the admin originator). Calls a site makes through the permissions
 * manager carry the site's originator and teach nothing.
 */
export const learnOwnBackends = (WalletClass: { prototype: object }, adminOriginator: string) => {
  const proto = WalletClass.prototype as SignerProto & { [PATCHED]?: boolean };
  if (proto[PATCHED]) return;
  for (const method of ['createSignature', 'verifySignature'] as const) {
    const original = proto[method];
    if (typeof original !== 'function') continue;
    proto[method] = function (this: unknown, args: unknown, originator?: string) {
      if (!originator || originator === adminOriginator) noteOwnBackendCall(args);
      return original.call(this, args, originator);
    };
  }
  proto[PATCHED] = true;
};

/** Tests only. */
export const _resetOwnBackends = () => {
  known.clear();
  loading = null;
};
