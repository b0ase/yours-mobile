import { safety, type SafetyFilter } from '../market/safety';
import type { FeedPost } from './post';

/**
 * Feed per-device state: who you follow (mirrored on-chain by follow txs), who you muted,
 * what you liked (so the heart stays lit before the indexer catches up). localStorage only.
 */
const LS = { follows: 'bwallet.feed.follows', mutes: 'bwallet.feed.mutes', liked: 'bwallet.feed.liked' };

export type Follow = { bapId: string | null; address: string; name: string };

const read = <T>(k: string, fallback: T): T => {
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? 'null') as T | null;
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // storage unavailable
  }
};

export const loadFollows = (): Follow[] =>
  read<Follow[]>(LS.follows, []).filter((f) => f && typeof f.address === 'string');
export const isFollowing = (follows: Follow[], a: { address: string; bapId: string | null }) =>
  follows.some((f) => f.address === a.address || (!!a.bapId && f.bapId === a.bapId));
export const toggleFollow = (follows: Follow[], f: Follow): Follow[] => {
  const next = isFollowing(follows, f)
    ? follows.filter((x) => !(x.address === f.address || (!!f.bapId && x.bapId === f.bapId)))
    : [...follows, f];
  write(LS.follows, next);
  return next;
};

export const loadMutes = (): string[] => read<string[]>(LS.mutes, []).filter((x) => typeof x === 'string');
export const addMute = (mutes: string[], ...keys: (string | null)[]): string[] => {
  const next = [...new Set([...mutes, ...keys.filter((k): k is string => !!k)])];
  write(LS.mutes, next);
  return next;
};

export const loadLiked = (): string[] => read<string[]>(LS.liked, []).filter((x) => typeof x === 'string');
export const addLiked = (liked: string[], txid: string): string[] => {
  const next = [...new Set([...liked, txid])].slice(-2000);
  write(LS.liked, next);
  return next;
};

/** Market safety filter (bundled + remote blocklist + reported) plus this device's mutes. */
export function visiblePosts(posts: FeedPost[], mutes: string[], s: SafetyFilter = safety()): FeedPost[] {
  const muted = new Set(mutes);
  return posts.filter((p) => {
    if (muted.has(p.author.address) || (p.author.bapId && muted.has(p.author.bapId))) return false;
    return !s.check({ ids: [p.txid], texts: [p.text, p.author.name] }).blocked;
  });
}
