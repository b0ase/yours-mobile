import { useEffect, useMemo, useState } from 'react';
import { isNative } from '../native';
import { loadFollows } from '../feed/store';
import { getFriends, onFriends, refreshFriends } from '../calls/friends';
import { resolveCallee } from '../calls/peer';
import { BchatClient, defaultHttp, loadSession } from './api';
import { mergeContacts, proveLabels, provenLabel, type BchatContact, type FriendLike } from './contacts';

/** label|key → proven, for this session (a name can move, so never kept across launches). */
const proofCache = new Map<string, boolean>();
const keyOf = async (label: string) => (await resolveCallee((u, i) => fetch(u, i), label)).key;

/**
 * The friends' "$name" labels proven for their keys (contacts.ts provenLabel). Until a label is proven it shows as
 * "(not verified)" and is never a handle or paymail (b-Aware row 351).
 */
export const useProvenLabels = (friends: readonly FriendLike[]): ReadonlySet<string> => {
  const cached = () =>
    new Set(friends.map((f) => provenLabel(f.name, f.key)).filter((k) => proofCache.get(k) === true));
  const [proven, setProven] = useState<ReadonlySet<string>>(cached);
  const sig = friends.map((f) => provenLabel(f.name, f.key)).join(',');
  useEffect(() => {
    let live = true;
    const todo = friends.filter((f) => !proofCache.has(provenLabel(f.name, f.key)));
    void proveLabels(todo, keyOf).then((ok) => {
      for (const f of todo) proofCache.set(provenLabel(f.name, f.key), ok.has(provenLabel(f.name, f.key)));
      if (live) setProven(cached());
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return proven;
};

/**
 * The unified contact list outside the DMs page (Calls): Calls friends + Feed follows, plus
 * bChat contacts when a bChat session already exists (never prompts a sign-in here).
 */
export const useContacts = () => {
  const [friends, setFriends] = useState(getFriends());
  const [bchat, setBchat] = useState<BchatContact[]>([]);
  const session = loadSession();
  const proven = useProvenLabels(friends);
  useEffect(() => {
    const off = onFriends(setFriends);
    void refreshFriends().catch(() => undefined);
    return off;
  }, []);
  useEffect(() => {
    if (!session) return;
    void new BchatClient(defaultHttp(isNative), session)
      .contacts()
      .then(setBchat)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.handle]);
  return useMemo(
    () => mergeContacts(bchat, friends, loadFollows(), session?.handle, proven),
    [bchat, friends, session?.handle, proven],
  );
};
