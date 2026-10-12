/**
 * Posters for video NFTs (owner, 12 Oct 2026: VexVoid clips from $vexvoid showed no preview in Wallet › NFTs,
 * Quarantine or the airdrop viewer on iOS).
 *
 * Why: the 1sat image resizer refuses video ("cannot transform content type video/mp4", 415), and none of the
 * content hosts (api.1sat.app, ordfs.network, ordinals.gorillapool.io) answer byte-range requests. iOS media
 * playback needs ranges, so `<video src=…#t=0.1 preload=metadata>` never paints a frame there, and the viewer can't
 * stream the file either.
 *
 * What: VexVoid's MP4s carry their cover art in the `moov/udta/meta/ilst/covr` atom near the start of the file
 * (faststart). We read only the first part of the response, pull out that JPEG/PNG, and stop the download. The
 * result is a raster image shown with <img> only (magic bytes checked; never SVG or markup). The viewer plays the
 * file from a downloaded blob: URL, which iOS plays without ranges.
 */
import { useEffect, useState } from 'react';
import { contentUrls } from '../market/indexer';

export type Cover = { bytes: Uint8Array; type: 'image/jpeg' | 'image/png' };
/** A cover was found, the file has none (or isn't an MP4 we can read), or more bytes are needed. */
export type CoverScan = Cover | null | 'more';

const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const fourcc = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

type Box = { type: string; start: number; body: number; end: number };

/** Boxes inside [from, to). `end` may run past the buffer for the last one (64-bit sizes too). */
function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let i = from;
  while (i + 8 <= to) {
    let size = u32(b, i);
    const type = fourcc(b, i + 4);
    let body = i + 8;
    if (size === 1) {
      if (i + 16 > to) break;
      const hi = u32(b, i + 8);
      size = hi * 2 ** 32 + u32(b, i + 12);
      body = i + 16;
    } else if (size === 0) size = Number.MAX_SAFE_INTEGER - i; // runs to end of file
    if (size < body - i) return out; // corrupt
    out.push({ type, start: i, body, end: i + size });
    i += size;
  }
  return out;
}

const imageType = (b: Uint8Array): Cover['type'] | null => {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return null;
};

const child = (b: Uint8Array, parent: Box, type: string, skip = 0) =>
  boxes(b, parent.body + skip, Math.min(parent.end, b.length)).find((x) => x.type === type && x.end <= b.length);

/**
 * Find the MP4 cover art (iTunes-style `covr`) in the leading bytes of a file. Returns 'more' while `moov` is not
 * complete yet, null if the file isn't an MP4, `mdat` comes first (moov at the end) or there is no JPEG/PNG cover.
 */
export function findMp4Cover(b: Uint8Array): CoverScan {
  if (b.length < 8) return 'more';
  if (fourcc(b, 4) !== 'ftyp') return null;
  for (const top of boxes(b, 0, b.length)) {
    if (top.type === 'mdat') return null; // moov after the media data: we'd need the whole file
    if (top.type !== 'moov') continue;
    if (top.end > b.length) return 'more';
    const udta = child(b, top, 'udta');
    const meta = udta && child(b, udta, 'meta');
    if (!meta) return null;
    // `meta` is a full box (4 bytes version/flags) in ISO files; QuickTime files omit them.
    const ilst = child(b, meta, 'ilst', 4) ?? child(b, meta, 'ilst');
    const covr = ilst && child(b, ilst, 'covr');
    const data = covr && child(b, covr, 'data');
    if (!data || data.body + 8 > data.end) return null;
    const bytes = b.slice(data.body + 8, data.end); // 4 bytes type indicator + 4 bytes locale
    const type = imageType(bytes);
    return type ? { bytes, type } : null;
  }
  return 'more';
}

/** Most we read looking for a cover (VexVoid's moov is 20–55 KB). */
export const COVER_MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 20_000;
const MAX_CONCURRENT = 3;
const CACHE_NAME = 'bwallet-video-posters-v1';
const cacheKey = (outpoint: string) => `https://bwallet.invalid/poster/${outpoint}`;

/** Read a response body until the scan settles or the byte cap is hit, then stop the download. */
async function scanBody(res: Response, max = COVER_MAX_BYTES): Promise<Cover | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  let buf = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value?.length) {
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
      }
      const r = findMp4Cover(buf);
      if (r !== 'more') return r;
      if (done || buf.length >= max) return null;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

const memory = new Map<string, string | null>(); // outpoint → object URL (null: no cover)
const inflight = new Map<string, Promise<string | null>>();
let active = 0;
const waiting: (() => void)[] = [];
const slot = async () => {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
};
const release = () => {
  active--;
  waiting.shift()?.();
};

const openCache = async (): Promise<Cache | null> => {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
};

/** Synchronous hit (undefined = not looked up yet, null = no cover). */
export const cachedPoster = (outpoint: string) => memory.get(outpoint);

/** The video NFT's embedded cover as an object URL, or null. Cached in memory and the Cache API. */
export function loadVideoPoster(outpoint: string): Promise<string | null> {
  if (memory.has(outpoint)) return Promise.resolve(memory.get(outpoint) ?? null);
  const running = inflight.get(outpoint);
  if (running) return running;
  const p = (async () => {
    const cache = await openCache();
    try {
      const hit = await cache?.match(cacheKey(outpoint));
      if (hit) {
        const blob = await hit.blob();
        const type = imageType(new Uint8Array(await blob.slice(0, 8).arrayBuffer()));
        if (type) return URL.createObjectURL(new Blob([blob], { type }));
      }
    } catch {
      // cache read failed: go to network
    }
    await slot();
    try {
      for (const url of contentUrls(outpoint)) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (!res.ok) continue;
          const cover = await scanBody(res);
          if (!cover) return null; // the file answered: it simply has no cover
          const blob = new Blob([cover.bytes as BlobPart], { type: cover.type });
          void cache
            ?.put(cacheKey(outpoint), new Response(blob, { headers: { 'content-type': cover.type } }))
            .catch(() => undefined);
          return URL.createObjectURL(blob);
        } catch {
          // next host
        }
      }
      return null;
    } finally {
      release();
    }
  })()
    .then((u) => {
      memory.set(outpoint, u);
      return u;
    })
    .finally(() => inflight.delete(outpoint));
  inflight.set(outpoint, p);
  return p;
}

/** Biggest video we download whole for the viewer (iOS can't stream from these hosts: no byte ranges). */
export const VIDEO_BLOB_MAX = 150_000_000;

/**
 * Download a video for playback as a blob: URL typed with its video/* type (only ever given to <video>). Null if
 * it is too large or every host fails; the caller then tries the remote URL directly.
 */
export async function loadVideoBlobUrl(outpoint: string, type: string, signal?: AbortSignal): Promise<string | null> {
  if (!/^video\//i.test(type)) return null;
  for (const url of contentUrls(outpoint)) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) continue;
      if (Number(res.headers.get('content-length') ?? 0) > VIDEO_BLOB_MAX) return null;
      const blob = await res.blob();
      if (!blob.size || blob.size > VIDEO_BLOB_MAX) return null;
      return URL.createObjectURL(new Blob([blob], { type }));
    } catch {
      if (signal?.aborted) return null;
    }
  }
  return null;
}

/** The cover embedded in the video (object URL), null when it has none, undefined while looking. */
export const useVideoPoster = (outpoint: string | null | undefined) => {
  const [src, setSrc] = useState<string | null | undefined>(() => (outpoint ? cachedPoster(outpoint) : null));
  useEffect(() => {
    if (!outpoint) return setSrc(null);
    const hit = cachedPoster(outpoint);
    if (hit !== undefined) return setSrc(hit);
    let live = true;
    setSrc(undefined);
    void loadVideoPoster(outpoint).then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
  }, [outpoint]);
  return src;
};
