import { getProfile, listOpns, resolveBapId, type OneSatContext } from '@1sat/actions';
import { PublicKey, type WalletOutput } from '@bsv/sdk';
import { getMyName, setMyName } from './myName';
import { collectPaymailInbox, lookupPaymail, paymailEnabled } from './paymail';
import { syncBchatHandle } from './bchatHandle';

/**
 * Per-account naming. One identity key per account; each account has:
 *   displayName — the published BAP profile name (Settings → Identity), else the account name
 *   handle      — the OpNS name this identity owns / has bound (from the wallet's opns basket)
 *   paymail     — the bWallet paymail registered to this identity key (server lookup)
 *
 * The chain (and the paymail server) are the source of truth. localStorage is only a cache so
 * the top bar paints instantly; syncAccountNames() refreshes it.
 */

const K = {
  profile: (id: string) => `bwallet.profile.${id}`,
  opns: (id: string) => `bwallet.opns.${id}`,
  paymail: (id: string) => `bwallet.paymail.${id}`,
};
const EVENT = 'bwallet-name-changed';

const read = (k: string) => {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
};
const write = (k: string, v: string) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
};
const changed = () => window.dispatchEvent(new Event(EVENT));

export type OwnedName = { name: string; id: string; published: boolean };

export const getCachedProfileName = (id?: string) => (id ? read(K.profile(id)) : '');
export const setCachedProfileName = (id: string, name: string) => {
  if (read(K.profile(id)) === name) return;
  write(K.profile(id), name);
  changed();
};
export const getOwnedNames = (id?: string): OwnedName[] => {
  if (!id) return [];
  try {
    return JSON.parse(read(K.opns(id)) || '[]');
  } catch {
    return [];
  }
};
export const getPaymail = (id?: string) => (id && paymailEnabled() ? read(K.paymail(id)) : '');
export const setPaymail = (id: string, p: string) => {
  write(K.paymail(id), p);
  changed();
};

/**
 * Which OpNS name to show. Keep the cached choice if this identity still owns it; else the
 * single bound (published) name; else the only name owned; else nothing (the user picks).
 */
export const pickName = (owned: OwnedName[], cached: string): string => {
  const names = owned.map((o) => o.name);
  if (cached && names.includes(cached)) return cached;
  const published = owned.filter((o) => o.published);
  if (published.length === 1) return published[0].name;
  if (owned.length === 1) return owned[0].name;
  return '';
};

const nameOf = (o: WalletOutput) => o.tags?.find((t) => t.startsWith('name:'))?.slice(5);
const idOf = (o: WalletOutput) => o.tags?.find((t) => t.startsWith('id:'))?.slice(3) ?? o.outpoint;

export const ownedFromOutputs = (outputs: WalletOutput[]): OwnedName[] => {
  const byName = new Map<string, OwnedName>();
  for (const o of outputs) {
    const name = nameOf(o);
    if (!name) continue;
    const published = !!o.tags?.includes('opns:published');
    const prev = byName.get(name);
    if (!prev || (published && !prev.published)) byName.set(name, { name, id: idOf(o), published });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/** Label for the top bar / Receive: "Testytester · testytester@domain". */
export const payableLabel = (displayName: string, handle: string, paymail: string) => {
  const payable = paymail || handle;
  if (!payable) return displayName;
  if (!displayName || displayName.toLowerCase() === payable.toLowerCase()) return payable;
  return `${displayName} · ${payable}`;
};

const lastSync = new Map<string, number>();

/**
 * The identity address the wallet context actually signs as. Right after Add account / a switch, the
 * top bar already shows the new account while `apiContext` can still be the previous account's wallet;
 * syncing then cached the OTHER account's profile name / paymail / OpNS names under the new id
 * (owner, 6 Oct 2026: a new agent account showed the first account's name). Null if unknown.
 */
export const ctxIdentityAddress = async (ctx: OneSatContext): Promise<string | null> => {
  try {
    const { publicKey } = await ctx.wallet.getPublicKey({ identityKey: true });
    return PublicKey.fromString(publicKey).toAddress();
  } catch {
    return null;
  }
};

/**
 * Refresh profile name, OpNS names and paymail for the current account; collect paymail inbox.
 * Resolves true only when every lookup answered (false: skipped or something failed), so callers can
 * tell "has no name" from "couldn't check yet".
 */
export const syncAccountNames = async (
  ctx: OneSatContext,
  identityAddress: string,
  opts: { force?: boolean; minIntervalMs?: number } = {},
): Promise<boolean> => {
  if (!identityAddress) return false;
  const now = Date.now();
  if (!opts.force && now - (lastSync.get(identityAddress) ?? 0) < (opts.minIntervalMs ?? 120_000)) return false;
  // Only write this account's caches from this account's own wallet (see ctxIdentityAddress).
  if ((await ctxIdentityAddress(ctx)) !== identityAddress) return false;
  lastSync.set(identityAddress, now);
  const f = (u: string, i?: RequestInit) => fetch(u, i);

  const results = await Promise.allSettled([
    (async () => {
      // Unpublished: no profile name (also clears a name cached here by mistake for another account).
      if ((await resolveBapId(ctx)) === null) return setCachedProfileName(identityAddress, '');
      const res = await getProfile.execute(ctx, {});
      const name = typeof res.profile?.name === 'string' ? res.profile.name.trim() : '';
      if (name) setCachedProfileName(identityAddress, name);
    })(),
    (async () => {
      const r = await listOpns.execute(ctx, { includeTags: true, limit: 100 });
      const owned = ownedFromOutputs(r.outputs);
      write(K.opns(identityAddress), JSON.stringify(owned));
      const pick = pickName(owned, getMyName(identityAddress));
      if (pick !== getMyName(identityAddress)) setMyName(identityAddress, pick);
      else changed();
    })(),
    (async () => {
      if (!paymailEnabled()) return;
      const { publicKey } = await ctx.wallet.getPublicKey({ identityKey: true });
      const p = await lookupPaymail(f, publicKey);
      if ((p ?? '') !== read(K.paymail(identityAddress))) setPaymail(identityAddress, p ?? '');
      if (p) {
        // One identity: a bChat session still on its `yours-*` default takes the paymail name.
        void syncBchatHandle(ctx, p);
        await collectPaymailInbox(f, ctx.wallet, async (txid) =>
          ctx.services ? (await ctx.services.getBeefForTxid(txid)).toBinary() : undefined,
        );
      }
    })(),
  ]);
  return results.every((r) => r.status === 'fulfilled');
};

export const onAccountNamesChange = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};
