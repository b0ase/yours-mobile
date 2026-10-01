import { CallsClientError, getCallsClient } from './store';
import type { Friend } from './api';

/**
 * Friends (the Calls contact list): stored on bit-sign against the identity key so they
 * follow the wallet across devices, with a per-identity local cache so the list paints
 * instantly and survives being offline. The server is the source of truth: a refresh
 * replaces the cache; local edits are written through and re-fetched.
 */
export type { Friend };

const cacheKey = (identityKey: string) => `bwallet.calls.friends.${identityKey}`;
let friends: Friend[] = [];
let owner: string | null = null;
const listeners = new Set<(f: Friend[]) => void>();

const emit = () => listeners.forEach((l) => l(friends));
const sort = (list: Friend[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));

export const readCache = (identityKey: string): Friend[] => {
  try {
    const v = JSON.parse(localStorage.getItem(cacheKey(identityKey)) || '[]');
    return Array.isArray(v) ? v.filter((f) => f && typeof f.key === 'string' && typeof f.name === 'string') : [];
  } catch {
    return [];
  }
};

const writeCache = () => {
  if (!owner) return;
  try {
    localStorage.setItem(cacheKey(owner), JSON.stringify(friends));
  } catch {
    /* storage unavailable */
  }
};

export const getFriends = () => friends;
export const onFriends = (fn: (f: Friend[]) => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** Load the cache for this identity, then refresh from the server. */
export async function refreshFriends(): Promise<Friend[]> {
  const c = getCallsClient();
  if (!c) return friends;
  const me = c.identityKey ?? (await c.signIn()).identityKey;
  if (owner !== me) {
    owner = me;
    friends = sort(readCache(me));
    emit();
  }
  friends = sort(await c.friends());
  writeCache();
  emit();
  return friends;
}

export const isFriend = (key: string) => friends.some((f) => f.key === key);

/**
 * Add (or rename) a friend. Exported for the Feed: call it with a profile's identity key,
 * display name and avatar URL. Throws CallsClientError when the wallet is locked.
 */
export async function addFriend(f: { key: string; name: string; avatar?: string | null }): Promise<void> {
  const c = getCallsClient();
  if (!c) throw new CallsClientError('Unlock bWallet to add friends');
  const key = f.key.trim().toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(key)) throw new CallsClientError('Not an identity key');
  const friend: Friend = { key, name: f.name.trim().slice(0, 80) || key.slice(0, 10), avatar: f.avatar ?? null };
  friends = sort([...friends.filter((x) => x.key !== key), friend]);
  writeCache();
  emit();
  await c.saveFriend(friend);
  await refreshFriends().catch(() => undefined);
}

export async function removeFriend(key: string): Promise<void> {
  const c = getCallsClient();
  if (!c) throw new CallsClientError('Unlock bWallet to edit friends');
  friends = friends.filter((x) => x.key !== key);
  writeCache();
  emit();
  await c.removeFriend(key);
}
