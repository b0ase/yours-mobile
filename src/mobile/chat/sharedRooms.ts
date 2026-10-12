/**
 * One bChat client and one rooms() call shared by Chatrooms and DMs (chat snappy, wave 1).
 *
 * - `sharedChatClient()`: one BchatClient per wallet account, so both segments use the same session.
 * - `fetchRooms()`: concurrent calls share one request; a result younger than `maxAgeMs` is reused.
 *   Every result goes to `onRooms` subscribers (both lists update from either fetch) and to the
 *   list caches: the whole list under chat:rooms:<identity>, the 1:1s under chat:dms:<identity>.
 */
import { BchatClient, defaultHttp, loadSession } from './api';
import { getChatAccount } from './chatAccount';
import { dmRooms } from './contacts';
import type { ChatRoom } from './messages';
import { isNative } from '../native';
import { writeListCache } from '../ui/listCache';

let client: { account: string | null; c: BchatClient } | null = null;

export const sharedChatClient = (): BchatClient => {
  const account = getChatAccount();
  if (!client || client.account !== account)
    client = { account, c: new BchatClient(defaultHttp(isNative), loadSession()) };
  return client.c;
};

export const roomsCacheKey = (identity: string) => `chat:rooms:${identity}`;
export const dmsCacheKey = (identity: string) => `chat:dms:${identity}`;

let inflight: Promise<ChatRoom[]> | null = null;
let last: { at: number; rooms: ChatRoom[]; client: BchatClient } | null = null;
const subs = new Set<(rooms: ChatRoom[]) => void>();

/** Hand a fresh list to every subscriber and the caches (also used after openDirect etc.). */
export const publishRooms = (c: BchatClient, rooms: ChatRoom[], identity: string) => {
  last = { at: Date.now(), rooms, client: c };
  if (identity) {
    writeListCache(roomsCacheKey(identity), rooms, 100);
    writeListCache(dmsCacheKey(identity), dmRooms(rooms), 100);
  }
  subs.forEach((f) => f(rooms));
};

export const fetchRooms = (c: BchatClient, identity: string, maxAgeMs = 2_000): Promise<ChatRoom[]> => {
  if (last && last.client === c && Date.now() - last.at < maxAgeMs) return Promise.resolve(last.rooms);
  if (inflight) return inflight;
  const p = c
    .rooms()
    .then((r) => {
      publishRooms(c, r, identity);
      return r;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
};

export const onRooms = (f: (rooms: ChatRoom[]) => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
