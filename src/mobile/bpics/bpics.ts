/**
 * bPics (owner, 12 Oct 2026): mint a photo as a 1Sat image ordinal, optionally shared in the bPics library.
 *
 * Sharing is opt-in: only a mint with "Share in bPics" ticked carries the bPics MAP tag (app=bpics, type=pic).
 * The library reads every bPics-tagged inscription from GorillaPool's MAP search, newest first, and keeps only
 * raster images (shown with <img>; SVG and HTML are dropped, never rendered). Reported/hidden pictures and
 * hidden minters drop out on this device. No likes, funding or sales here (store-safe in both editions).
 */
import type { CreateActionArgs } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { buildMap, MINT_APP, type MintForm } from '../mint/mint';
import { RepeatGuard, repeatRefusal, requestFingerprint } from '../../services/repeatGuard';

export const BPICS_APP = 'bpics';
export const BPICS_TYPE = 'pic';
/** "Share in bPics" starts unticked: a picture is private unless the person chooses to share it. */
export const SHARE_DEFAULT = false;
/** Longest side of a minted picture (px) and its JPEG quality: ~150-400 KB, a few cents to mint. */
export const PIC_MAX_EDGE = 1600;
export const PIC_QUALITY = 0.85;

export const GP_API = 'https://ordinals.gorillapool.io/api';
export const PAGE_SIZE = 30;

/** MAP for a picture mint. Shared → the bPics tag (and the wallet named in `client`); else the plain mint MAP. */
export function buildPicMap(f: { title: string; description: string; share: boolean }): Record<string, string> {
  const form: MintForm = { title: f.title, description: f.description, collection: { kind: 'none' } };
  const base = buildMap(form);
  if (!f.share) return base;
  return { ...base, app: BPICS_APP, type: BPICS_TYPE, client: MINT_APP };
}

/** GorillaPool inscription search by MAP fields (q = base64 JSON), newest first. */
export function feedUrl(offset = 0, limit = PAGE_SIZE, api = GP_API): string {
  const q = btoa(JSON.stringify({ map: { app: BPICS_APP, type: BPICS_TYPE } }));
  return `${api}/inscriptions/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}&dir=desc`;
}

/** Raster images only. SVG (script-capable markup) and everything else are never shown. */
const SAFE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif)$/i;
export const isSafeImageType = (t: unknown): boolean => typeof t === 'string' && SAFE_IMAGE.test(t.trim());

export type Pic = {
  outpoint: string;
  /** Inscription origin: the picture's id (content URL, report target, issuer check). */
  origin: string;
  /** Current holder's address (the minter until it is sent on). */
  owner: string;
  name: string;
  description: string;
  contentType: string;
  height: number;
  idx: number;
};

type Raw = {
  outpoint?: unknown;
  owner?: unknown;
  height?: unknown;
  idx?: unknown;
  origin?: { outpoint?: unknown; data?: RawData };
  data?: RawData;
};
type RawData = { map?: Record<string, unknown>; insc?: { file?: { type?: unknown } } };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const OUTPOINT = /^[0-9a-f]{64}_\d{1,6}$/i;

/** Indexer rows → pictures: bPics-tagged, a safe image type, a well-formed origin. Anything else is dropped. */
export function parseFeed(json: unknown): Pic[] {
  if (!Array.isArray(json)) return [];
  const out: Pic[] = [];
  for (const r of json as Raw[]) {
    const data = r?.origin?.data ?? r?.data;
    const map = data?.map ?? {};
    if (str(map.app) !== BPICS_APP || str(map.type) !== BPICS_TYPE) continue;
    const contentType = str(data?.insc?.file?.type);
    if (!isSafeImageType(contentType)) continue;
    const origin = str(r?.origin?.outpoint) || str(r?.outpoint);
    if (!OUTPOINT.test(origin)) continue;
    out.push({
      outpoint: str(r.outpoint) || origin,
      origin,
      owner: str(r.owner),
      name: str(map.name).slice(0, 100) || 'Picture',
      description: str(map.description).slice(0, 1000),
      contentType,
      height: num(r.height),
      idx: num(r.idx),
    });
  }
  return out;
}

/** Newest first; not yet mined (height 0) on top. */
export const newestFirst = (a: Pic, b: Pic) =>
  (b.height || Infinity) - (a.height || Infinity) || b.idx - a.idx || (a.origin < b.origin ? 1 : -1);

export type Hidden = { pics: string[]; minters: string[] };

/**
 * The feed as shown: no duplicates, no hidden pictures, nothing from a hidden or blocked minter.
 * `minterOf` gives a picture's minter keys (verified identity key and/or holder address); `blocked` tests a $handle.
 */
export function visibleFeed(
  pics: Pic[],
  hidden: Hidden,
  minterOf: (p: Pic) => { keys: string[]; handle?: string | null } = (p) => ({ keys: [p.owner] }),
  blocked: (handle: string) => boolean = () => false,
): Pic[] {
  const hp = new Set(hidden.pics.map((x) => x.toLowerCase()));
  const hm = new Set(hidden.minters.map((x) => x.toLowerCase()));
  const seen = new Set<string>();
  return pics
    .filter((p) => {
      const id = p.origin.toLowerCase();
      if (seen.has(id) || hp.has(id)) return false;
      seen.add(id);
      const m = minterOf(p);
      if (m.keys.some((k) => k && hm.has(k.toLowerCase()))) return false;
      if (m.handle && (hm.has(m.handle.toLowerCase()) || blocked(m.handle))) return false;
      return true;
    })
    .sort(newestFirst);
}

// ── Hidden (this device) ──

const HIDDEN_KEY = 'bwallet.bpics.hidden';
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function loadHidden(): Hidden {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '{}') as Partial<Hidden>;
    return { pics: strings(v.pics), minters: strings(v.minters) };
  } catch {
    return { pics: [], minters: [] };
  }
}
export function saveHidden(h: Hidden): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ pics: [...new Set(h.pics)], minters: [...new Set(h.minters)] }));
  } catch {
    /* storage unavailable */
  }
}
export const hidePic = (h: Hidden, origin: string): Hidden => ({ ...h, pics: [...h.pics, origin.toLowerCase()] });
export const hideMinter = (h: Hidden, keys: (string | null | undefined)[]): Hidden => ({
  ...h,
  minters: [...h.minters, ...keys.filter((k): k is string => !!k).map((k) => k.toLowerCase())],
});

// ── Never pay twice for the same picture (services/repeatGuard.ts) ──

const guard = new RepeatGuard();

/** A context whose createAction refuses an identical inscription made within the repeat window. */
export function withRepeatGuard(ctx: OneSatContext, g: RepeatGuard = guard): OneSatContext {
  const wallet = new Proxy(ctx.wallet, {
    get(target, prop, receiver) {
      if (prop === 'createAction') {
        return async (args: CreateActionArgs, originator?: string) => {
          const fp = await requestFingerprint(args);
          const earlier = g.check(fp);
          if (earlier) throw new Error(repeatRefusal(earlier));
          const r = await target.createAction(args, originator);
          g.record(fp, { txid: r.txid });
          return r;
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...ctx, wallet } as OneSatContext;
}

/** "data:image/jpeg;base64,AAAA" → { contentType, base64 }. */
export function splitDataUri(uri: string): { contentType: string; base64: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
  if (!m) throw new Error('That picture couldn’t be read.');
  return { contentType: m[1], base64: m[2] };
}
export const base64Bytes = (b64: string) =>
  Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
