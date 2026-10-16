/**
 * Synced Space video (bit-sign rooms/[ticker]/space-video). The server keeps one item and a clock;
 * every phone works out the same position from it, so the whole room watches the same frame.
 * Pure helpers here (tested in spaceVideo.test.ts); the player is SpaceVideoPlayer.tsx.
 */

export type SpaceVideoItem = {
  kind: 'url' | 'ordinal';
  src: string;
  outpoint?: string;
  title?: string;
  durationMs?: number;
  poster?: string;
};

export type SpaceVideoState = 'playing' | 'paused' | 'stopped';

export type SpaceVideo = {
  item: SpaceVideoItem | null;
  state: SpaceVideoState;
  startedAt: number;
  pausedAtMs: number;
  loop: boolean;
  version: number;
  serverNow: number;
  /** server_now − local clock when this copy arrived (ms). Add to Date.now() to get server time. */
  skew: number;
};

export const SPACE_VIDEO_TOPIC = 'space-video';
export const MESH_POLL_MS = 10_000;
export const DRIFT_RESEEK_MS = 1_500;

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|ogg|m3u8)$/i;
const VIDEO_HOSTS = ['ordfs.network', '1sat.app', 'gorillapool.io', 'bitsign.it', 'bchatx.com'];

/** https only, and a video file or one of our known content hosts (and their subdomains). */
export const isAllowedVideoSrc = (src: unknown): src is string => {
  if (typeof src !== 'string' || !src) return false;
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  return VIDEO_EXT.test(u.pathname);
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

const parseItem = (raw: unknown): SpaceVideoItem | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'url' && o.kind !== 'ordinal') return null;
  if (!isAllowedVideoSrc(o.src)) return null;
  const d = num(o.duration_ms);
  const poster = str(o.poster);
  return {
    kind: o.kind,
    src: o.src,
    ...(str(o.outpoint) ? { outpoint: str(o.outpoint) } : {}),
    ...(str(o.title) ? { title: str(o.title) } : {}),
    ...(d && d > 0 ? { durationMs: d } : {}),
    ...(poster && isAllowedPoster(poster) ? { poster } : {}),
  };
};

const isAllowedPoster = (p: string) => {
  try {
    return new URL(p).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * A GET body or a data packet ({type:'space-video', ...}) → SpaceVideo, or null when unreadable.
 * `receivedAt` is the local clock when it arrived. A disallowed src reads as no item.
 */
export const parseSpaceVideo = (raw: unknown, receivedAt: number): SpaceVideo | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const v = (o.video && typeof o.video === 'object' ? o.video : o) as Record<string, unknown>;
  const version = num(v.version);
  if (version === undefined) return null;
  const state: SpaceVideoState = v.state === 'playing' || v.state === 'paused' ? v.state : 'stopped';
  const serverNow = num(v.server_now) ?? receivedAt;
  return {
    item: parseItem(v.item),
    state,
    startedAt: num(v.started_at) ?? serverNow,
    pausedAtMs: Math.max(0, num(v.paused_at_ms) ?? 0),
    loop: v.loop === true,
    version,
    serverNow,
    skew: serverNow - receivedAt,
  };
};

/** Keep the newer copy: only a strictly higher version replaces what we have. */
export const newerVideo = (have: SpaceVideo | null, next: SpaceVideo | null): SpaceVideo | null => {
  if (!next) return have;
  if (!have) return next;
  return next.version > have.version ? next : have;
};

export type Position = { ms: number; ended: boolean };

/**
 * Where the room is now (ms into the item). `localNow` is Date.now(); `mediaDurationMs` is the
 * element's own duration, used for looping when the server sent no duration_ms.
 */
export const positionOf = (v: SpaceVideo, localNow: number, mediaDurationMs?: number): Position => {
  if (!v.item || v.state === 'stopped') return { ms: 0, ended: false };
  if (v.state === 'paused') return { ms: v.pausedAtMs, ended: false };
  const e = Math.max(0, localNow + v.skew - v.startedAt);
  const d =
    v.item.durationMs ??
    (mediaDurationMs && Number.isFinite(mediaDurationMs) && mediaDurationMs > 0 ? mediaDurationMs : undefined);
  if (!d) return { ms: e, ended: false };
  if (v.loop) return { ms: e % d, ended: false };
  return e >= d ? { ms: d, ended: true } : { ms: e, ended: false };
};

/** Seek when the element is more than 1.5 s from where the room is. */
export const needsReseek = (currentMs: number, targetMs: number, threshold = DRIFT_RESEEK_MS) =>
  Math.abs(currentMs - targetMs) > threshold;

/** A data packet on LiveKit: keep only the space-video topic. */
export const parseVideoPacket = (topic: string | undefined, payload: Uint8Array, receivedAt: number) => {
  if (topic !== SPACE_VIDEO_TOPIC) return null;
  try {
    const raw = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    if (raw?.type !== undefined && raw.type !== SPACE_VIDEO_TOPIC) return null;
    return parseSpaceVideo(raw, receivedAt);
  } catch {
    return null;
  }
};

export type VideoAction =
  | {
      action: 'play';
      item: { kind: 'url' | 'ordinal'; src: string; outpoint?: string; title?: string };
      loop?: boolean;
    }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'seek'; position_ms: number }
  | { action: 'stop' }
  | { action: 'set_loop'; loop: boolean };

/** ORDFS content URL for an owned ordinal (origin `<txid>_<n>` or `.n`). */
export const ordinalSrc = (origin: string) => `https://ordfs.network/content/${origin.replace('.', '_')}`;
