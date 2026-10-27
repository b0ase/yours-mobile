/**
 * Live video for game rooms (TERRORNODE first): which rooms get the compact player, what it plays, and the
 * "one player at a time" handshake with an open bChatX room tab. PURE (no React, no chrome, no network) so the
 * content script, the background and the panel share it and gameRoomLive.test.ts drives it.
 *
 * Mirrors bit-sign's lib/golive-rules.ts (PRs #493, #498): the same public endpoints, idle commercial and
 * 45 s preview. The wallet never holds a LiveKit secret: a watch-only token comes from
 * POST /api/bitsign/rooms/<ticker>/golive with the bChat Bearer session, exactly as the web room asks.
 */
import { BCHAT_ORIGINS } from '../../services/bchatOrigin';

export type GameRoomVideo = {
  ticker: string;
  /** Idle loop when nobody is live (muted, playsinline, loop). */
  idleUrl: string;
  poster: string;
  /** Where "Play to earn" sends a viewer whose preview ran out. */
  earnUrl: string;
};

const GAME_ROOMS: Record<string, GameRoomVideo> = {
  TERRORNODE: {
    ticker: 'TERRORNODE',
    idleUrl: 'https://terrornode.com/media/terrornode-live-30s.mp4',
    poster: 'https://terrornode.com/media/poster-v2.jpg',
    earnUrl: 'https://www.tokenblaster.lol/arcade/terrornode',
  },
};

/** Seconds of live (or, signed out, idle) video a viewer who is not playing sees per visit. Same as the web. */
export const PREVIEW_SECONDS = 45;
/** How often the closed player re-reads the live count (the web polls every 15 s). */
export const LIVE_POLL_MS = 15_000;
/** A tab that said nothing for this long no longer counts as playing. */
export const TAB_STALE_MS = 25_000;

export function normaliseRoom(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/^\$/, '').toUpperCase();
  return /^[A-Z0-9]{1,32}$/.test(t) ? t : null;
}

/** The game room's video setup, or null for every other room. */
export function gameRoomVideo(ticker: string | null | undefined): GameRoomVideo | null {
  const t = normaliseRoom(ticker ?? '');
  return (t && GAME_ROOMS[t]) || null;
}

/** API paths (bit-sign). The count is public (no auth, numbers only); the POST mints a watch-only token. */
export const golivePath = (ticker: string) => `/api/bitsign/rooms/${encodeURIComponent(ticker)}/golive`;
export const goliveCountPath = (ticker: string) => `${golivePath(ticker)}/count`;

/** A viewer gets the 45 s preview (then the earn card) in play-to-earn rooms unless they are live themselves. */
export function previewLimited(o: { playToEarn: boolean; playing: boolean }): boolean {
  return o.playToEarn && !o.playing;
}

export type PlayerSource = 'live' | 'idle' | 'ad' | 'tab';

/**
 * What the compact player shows, in the order the brief asks: a tab already playing this room wins (one player
 * at a time) unless the user chose "play here"; then live video; then the idle loop. A preview that ran out shows
 * the earn card. Signed-out viewers can't get a watch token (the web gates it too), so they get the idle loop
 * as their 45 s preview.
 */
export function playerSource(o: {
  signedIn: boolean;
  live: number;
  tabWatching: boolean;
  playHere: boolean;
  previewOver: boolean;
}): PlayerSource {
  if (o.tabWatching && !o.playHere) return 'tab';
  if (o.previewOver) return 'ad';
  if (o.signedIn && o.live > 0) return 'live';
  return 'idle';
}

// ── Collapsed / expanded, remembered per room ─────────────────────────────────

export const collapseKey = (ticker: string) => `bwallet:room-player:${normaliseRoom(ticker) ?? ticker}`;

export function readCollapsed(
  ticker: string,
  store: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): boolean {
  try {
    return store?.getItem(collapseKey(ticker)) === '1';
  } catch {
    return false;
  }
}

export function writeCollapsed(
  ticker: string,
  collapsed: boolean,
  store: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
) {
  try {
    store?.setItem(collapseKey(ticker), collapsed ? '1' : '0');
  } catch {
    /* private mode / blocked storage: the choice lasts this visit only */
  }
}

// ── Tab handshake (web room ↔ extension side panel) ───────────────────────────

/** Page → wallet: `window.postMessage({ type: 'bwx:room-playing', room, playing, visible }, location.origin)`. */
export const ROOM_PLAYING_TYPE = 'bwx:room-playing';
/** Wallet → page: `window.postMessage({ type: 'bwx:room-query' })` asks open room tabs to re-announce. */
export const ROOM_QUERY_TYPE = 'bwx:room-query';
/** chrome.runtime actions: content → background, panel → background, background → content. */
export const ROOM_PLAYING_ACTION = 'bwxRoomPlaying';
export const ROOM_QUERY_ACTION = 'bwxRoomQuery';
/** Background → panel port message, and the window event the panel re-dispatches it as. */
export const ROOM_TAB_ACTION = 'ROOM_TAB';
export const ROOM_TAB_EVENT = 'bwallet:room-tab';

export type RoomPlaying = { room: string; playing: boolean; visible: boolean };

/** bChatX and its family origins only (exact match), so no other site can silence the panel's player. */
export function roomTabOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  return origin === 'https://bchatx.com' || (BCHAT_ORIGINS as readonly string[]).includes(origin);
}

/** The page's message, checked field by field; anything else is dropped. Extra fields are not passed on. */
export function parseRoomPlaying(data: unknown): RoomPlaying | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type !== undefined && d.type !== ROOM_PLAYING_TYPE) return null;
  const room = normaliseRoom(d.room);
  if (!room || typeof d.playing !== 'boolean' || typeof d.visible !== 'boolean') return null;
  return { room, playing: d.playing, visible: d.visible };
}

export type TabSeen = { playing: boolean; visible: boolean; at: number };
/** Keyed by `${tabId}:${room}` so two tabs on the same room are tracked apart. */
export type TabState = Record<string, TabSeen & { room: string }>;

export function noteTab(state: TabState, tabId: number | string, msg: RoomPlaying, now: number): TabState {
  const key = `${tabId}:${msg.room}`;
  const next: TabState = {};
  // A tab moved to another room: forget its old one.
  for (const [k, v] of Object.entries(state)) if (!k.startsWith(`${tabId}:`)) next[k] = v;
  if (msg.playing && msg.visible) next[key] = { room: msg.room, playing: true, visible: true, at: now };
  return next;
}

export function dropTab(state: TabState, tabId: number | string): TabState {
  const next: TabState = {};
  for (const [k, v] of Object.entries(state)) if (!k.startsWith(`${tabId}:`)) next[k] = v;
  return next;
}

/** Is a visible tab playing this room now (heard within 25 s)? */
export function tabWatching(state: TabState, room: string, now: number): boolean {
  const r = normaliseRoom(room);
  if (!r) return false;
  return Object.values(state).some((v) => v.room === r && v.playing && v.visible && now - v.at < TAB_STALE_MS);
}
