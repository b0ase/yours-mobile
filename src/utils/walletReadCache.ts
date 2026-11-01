/**
 * Page-side cache for the two wallet reads the home screen repeats most (owner's iPhone, 1 Nov 2026: about 550
 * getPublicKey and up to 400 listOutputs a minute while idle, until iOS killed the WebView at ~1.5 GB).
 *
 * - getPublicKey: public keys are deterministic per account and exact arguments, so a result is kept for the rest
 *   of the session. Identical calls in flight share one request.
 * - listOutputs: identical read-only calls in flight share one request, and an answer is reused for a short TTL.
 *   Any other wallet method (createAction, signAction, relinquishOutput, internalizeAction, abortAction, …) clears
 *   the list cache before and after it runs, so a spend never reads a list from before it.
 *
 * Nothing private is cached: no signatures, HMACs, ciphertext, linkage or certificates (those methods pass through).
 *
 * Account safety: everything is scoped to the account the page's storage says is selected, and only cached once the
 * wallet itself has answered with that account's identity key. Right after Add account / a switch the background can
 * still be the previous account's wallet; its answers are passed through and never cached. A lock clears everything
 * (see sessionCaches.ts).
 */
import { onSessionReset } from './sessionCaches';

/** How long an identical listOutputs answer is reused. */
export const LIST_OUTPUTS_TTL_MS = 10_000;

/** listOutputs arguments that only shape a read. A call with any other key is passed through uncached. */
const READ_ONLY_LIST_KEYS = new Set([
  'basket',
  'tags',
  'tagQueryMode',
  'include',
  'includeCustomInstructions',
  'includeTags',
  'includeLabels',
  'limit',
  'offset',
  'seekPermission',
]);

/**
 * Wallet methods that never change the wallet's outputs: passed straight through (uncached; the crypto ones are
 * private). Every other method (createAction, signAction, abortAction, internalizeAction, relinquishOutput,
 * acquire/relinquishCertificate, anything unknown) invalidates the list cache.
 */
const NO_OUTPUT_CHANGE = new Set([
  'getPublicKey',
  'listOutputs',
  'listActions',
  'listCertificates',
  'discoverByIdentityKey',
  'discoverByAttributes',
  'isAuthenticated',
  'waitForAuthentication',
  'getHeight',
  'getHeaderForHeight',
  'getNetwork',
  'getVersion',
  'verifySignature',
  'verifyHmac',
  'createSignature',
  'createHmac',
  'encrypt',
  'decrypt',
  'revealCounterpartyKeyLinkage',
  'revealSpecificKeyLinkage',
  'proveCertificate',
]);

type Args = Record<string, unknown>;
type ListEntry = { at: number; value?: unknown; pending?: Promise<unknown> };
type Fn = (...a: unknown[]) => Promise<unknown>;

export type WalletReadCacheOptions = {
  /** The selected account's id (identity address), or '' while locked / no account: then nothing is cached. */
  scope: () => string;
  /** True when `publicKey` (the wallet's identity key, hex) belongs to the account `scope`. */
  identityMatches: (publicKey: string, scope: string) => boolean;
  listTtlMs?: number;
  now?: () => number;
};

export type WalletReadCacheStats = { keyHits: number; keyMisses: number; listHits: number; listMisses: number };

export type WalletReadCacheControl = {
  /** Drop everything (lock, account switch). */
  clear: () => void;
  /** Drop cached lists only (the wallet's storage changed, e.g. a finished sync). */
  invalidateLists: () => void;
  stats: () => WalletReadCacheStats;
};

/** Stable JSON: object keys sorted, so `{a,b}` and `{b,a}` are one cache key. */
export const stableKey = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableKey(o[k])}`)
    .join(',')}}`;
};

/** The arguments that decide which public key comes back. */
const publicKeyCacheKey = (args: Args, originator: unknown) =>
  stableKey({
    identityKey: args.identityKey === true,
    protocolID: args.protocolID,
    keyID: args.keyID,
    counterparty: args.counterparty,
    forSelf: args.forSelf === true,
    privileged: args.privileged === true,
    originator,
  });

const isReadOnlyList = (args: unknown): args is Args =>
  !!args && typeof args === 'object' && Object.keys(args as Args).every((k) => READ_ONLY_LIST_KEYS.has(k));

/** A fresh outer object and outputs array per caller, so one caller sorting or filtering in place can't affect another. */
const copyList = (v: unknown): unknown => {
  if (!v || typeof v !== 'object') return v;
  const r = v as { outputs?: unknown };
  return Array.isArray(r.outputs) ? { ...r, outputs: r.outputs.slice() } : { ...r };
};

const controls = new Set<WalletReadCacheControl>();

/** Drop cached lists in every wallet read cache on this page (after a finished sync / manual refresh). */
export const invalidateWalletLists = () => {
  for (const c of controls) c.invalidateLists();
};

/** Drop everything in every wallet read cache on this page. */
export const clearWalletReadCaches = () => {
  for (const c of controls) c.clear();
};

onSessionReset(clearWalletReadCaches);

/**
 * Wrap a BRC-100 wallet client with the read cache. Returns the wrapped wallet and its control handle.
 */
export const withWalletReadCache = <T extends object>(
  wallet: T,
  opts: WalletReadCacheOptions,
): { wallet: T; control: WalletReadCacheControl } => {
  const ttl = opts.listTtlMs ?? LIST_OUTPUTS_TTL_MS;
  const now = opts.now ?? Date.now;

  let scope = '';
  /** Bumped on every clear: an answer that arrives after a clear is never stored. */
  let epoch = 0;
  /** The wallet answered with `scope`'s identity key in this epoch. */
  let verified = false;
  let keys = new Map<string, Promise<unknown>>();
  /** Bumped on every write and list invalidation. */
  let listGen = 0;
  let lists = new Map<string, ListEntry>();
  const stats: WalletReadCacheStats = { keyHits: 0, keyMisses: 0, listHits: 0, listMisses: 0 };

  const invalidateLists = () => {
    listGen++;
    lists = new Map();
  };
  const clear = () => {
    epoch++;
    verified = false;
    keys = new Map();
    invalidateLists();
  };
  /** Follow the selected account: a different one (or a lock) starts from empty. */
  const syncScope = () => {
    const s = opts.scope() || '';
    if (s !== scope) {
      clear();
      scope = s;
    }
    return scope;
  };

  const call = (name: string, args: unknown[]) =>
    (Reflect.get(wallet, name) as Fn).apply(wallet, args) as Promise<unknown>;

  const getPublicKey = (args: Args = {}, originator?: unknown): Promise<unknown> => {
    if (!syncScope()) return call('getPublicKey', [args, originator]);
    const k = publicKeyCacheKey(args, originator);
    const hit = keys.get(k);
    if (hit) {
      stats.keyHits++;
      return hit;
    }
    stats.keyMisses++;
    const e = epoch;
    const isIdentity = args.identityKey === true;
    const p = (async () => {
      // Derived keys are cached only once the wallet has proved it is this account's wallet.
      if (!isIdentity && !verified) await ensureVerified(originator);
      const trusted = isIdentity || (verified && e === epoch);
      const result = await call('getPublicKey', [args, originator]);
      const pk = (result as { publicKey?: unknown } | undefined)?.publicKey;
      if (e !== epoch) return result;
      if (isIdentity) {
        if (typeof pk === 'string' && opts.identityMatches(pk, scope)) verified = true;
        else {
          // Another account's wallet answered: drop everything (lists in flight too) and cache nothing until it
          // answers as this account again.
          clear();
          return result;
        }
      }
      if (!trusted || typeof pk !== 'string') keys.delete(k);
      return result;
    })();
    keys.set(k, p);
    p.catch(() => {
      if (keys.get(k) === p) keys.delete(k);
    });
    return p;
  };

  const ensureVerified = async (originator?: unknown) => {
    try {
      await getPublicKey({ identityKey: true }, originator);
    } catch {
      /* unverified: the caller's answer just isn't cached */
    }
  };

  const listOutputs = (args: unknown, originator?: unknown): Promise<unknown> => {
    if (!syncScope() || !isReadOnlyList(args)) return call('listOutputs', [args, originator]);
    const k = stableKey({ args, originator });
    const hit = lists.get(k);
    if (hit?.pending) {
      stats.listHits++;
      return hit.pending.then(copyList);
    }
    if (hit && 'value' in hit && now() - hit.at < ttl) {
      stats.listHits++;
      return Promise.resolve(copyList(hit.value));
    }
    stats.listMisses++;
    const gen = listGen;
    const e = epoch;
    const slot: ListEntry = { at: now() };
    const pending = (async () => {
      if (!verified) await ensureVerified(originator);
      const trusted = verified && e === epoch;
      const value = await call('listOutputs', [args, originator]);
      if (lists.get(k) === slot) {
        if (trusted && gen === listGen && e === epoch) lists.set(k, { at: now(), value });
        else lists.delete(k);
      }
      return value;
    })();
    slot.pending = pending;
    lists.set(k, slot);
    pending.catch(() => {
      if (lists.get(k) === slot) lists.delete(k);
    });
    return pending.then(copyList);
  };

  const control: WalletReadCacheControl = { clear, invalidateLists, stats: () => ({ ...stats }) };
  controls.add(control);

  const proxy = new Proxy(wallet, {
    get(target, prop, receiver) {
      if (prop === 'getPublicKey') return getPublicKey;
      if (prop === 'listOutputs') return listOutputs;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || NO_OUTPUT_CHANGE.has(String(prop))) return value;
      // Anything that may change outputs: no list read from before it is reused during or after it.
      return async (...a: unknown[]) => {
        invalidateLists();
        try {
          return await (value as Fn).apply(target, a);
        } finally {
          invalidateLists();
        }
      };
    },
  });
  return { wallet: proxy, control };
};
