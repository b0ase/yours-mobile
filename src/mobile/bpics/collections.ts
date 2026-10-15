/**
 * bPics › On chain (owner, 15 Oct 2026): picture collections already public on chain, shown in bPics.
 *
 * Safety gate: nothing is shown unless its collection is on ALLOWED_COLLECTIONS below. There is no open
 * firehose of arbitrary inscriptions; until a classifier/hash pipeline exists, a collection only appears
 * here after the owner adds it by hand. Each item must also name an allowlisted collectionId in its own
 * MAP and be a raster image (png/jpeg/gif/webp/avif), shown only through <img>. SVG/HTML never render.
 *
 * Source: GorillaPool's market search (items listed for sale in the collection), which also gives the
 * holder and the listing price. Its plain inscription search times out on very large collections.
 */
import { isSafeImageType } from './bpics';

export type AllowedCollection = {
  /** Collection inscription outpoint (txid_vout): what items name as subTypeData.collectionId. */
  id: string;
  name: string;
  artist: string;
  description: string;
};

/**
 * The live allowlist. Add a collection only after the owner approves it AND a sample (~15 items: cover +
 * random listed items) has been looked at. 15 Oct 2026 check: left out Rizzler Collection (drug and sexual
 * references) and The BSV Kongs (profanity and a middle finger on the art, a Nazi-style uniform image). Artist = the collection's
 * own creator, named by the platform it was minted on; we endorse none of them.
 */
export const ALLOWED_COLLECTIONS: readonly AllowedCollection[] = [
  {
    id: '1611d956f397caa80b56bc148b4bce87b54f39b234aeca4668b4d5a7785eb9fa_0',
    name: 'Pixel Foxes',
    artist: 'Foxes Pixel',
    description: '10,000,000 pixel foxes on chain forever.',
  },
  {
    id: '8c8df50610401e6f92d91c8f26f08e1f69acea0e82b23bca7a30660ce372a2a4_0',
    name: 'Dragon Army',
    artist: 'its creator (takeit)',
    description: '2,024 pixel dragons set in stone on the BSV blockchain.',
  },
  {
    id: '8da38b4c200f8b37adec1a39c8af2ac0666be0be829c8e3c08a3259425692618_0',
    name: 'Hapi Bots',
    artist: 'its creator (RareDropper)',
    description: 'AI Bots invading the Metaverse.',
  },
  {
    id: '4dd3e5cb16a5d14d2c0bdb2b94bd59a4b51c84b385195e56b1233504ff63bde2_0',
    name: 'Strange Town',
    artist: 'its creator (ZoideNFT)',
    description: 'What we arrived at was a strange cyber town.',
  },
  {
    id: '08029fd17c7640fe8e7596db721d46711356ee2e3d77e87c2aebe97cd9ef6989_0',
    name: 'RONIN',
    artist: 'its creator (takeit)',
    description: 'Samurai warriors and legends, a digital homage to the film 47 Ronin.',
  },
  {
    id: '8b065ddf0a21ebdc6e891304c14f8d638930dde706134f6fdb62724957cad728_0',
    name: "Dragon's Bsv",
    artist: 'its creator (takeit)',
    description: 'Armoured dragon portraits.',
  },
  {
    id: '6d6f7b2d646c47fd686e4f625be59c2e9257c01c6993fa9cbb283f326e001722_0',
    name: 'BSV Creations',
    artist: 'its creator (Ord Arena)',
    description: 'Text turned into a vibrant BSV world of stories and pictures.',
  },
  {
    id: 'bb945bc7b07ed24dcf145a1db67ba8d3158d7bb944d8152e05e09d5e20f1d775_0',
    name: 'Pepe Universo',
    artist: 'its creator (ZoideNFT)',
    description:
      'Cyber Pepe pixel art by the collection’s creator. Not made, endorsed or licensed by bWalletX or Matt Furie.',
  },
  {
    id: 'bf14c6f6337c623aaf53db8e20593fbd0934a32b553903e6ddbc9528290a5959_0',
    name: 'Trap Kongs',
    artist: 'its creator (3D Ordi)',
    description: 'Pixel gorillas in hats and shades.',
  },
  {
    id: 'a8826d60175db873b17cf02cf647deab744424095900f0dcf92c1f0c0a63c7f1_0',
    name: 'ScrYpts',
    artist: 'House of Ukiro (3D Ordi)',
    description: 'ScrYpts are crystals that hold Scripts.',
  },
  {
    id: 'b264f5e81f7c74057c691332e477c17f0ddc2f0cc024cb0f07b758533d1d3094_0',
    name: 'OG FROGS',
    artist: 'its creator (RareDropper)',
    description: 'The OG Frog Squad.',
  },
];

export const GP_API = 'https://ordinals.gorillapool.io/api';
export const COLLECTION_PAGE = 30;
export const CACHE_MS = 60_000;

const OUTPOINT = /^[0-9a-f]{64}_\d{1,6}$/i;
const norm = (id: string) => id.trim().toLowerCase().replace('.', '_');

/** The allowlisted collection for an id, or null. The single gate every displayed item passes. */
export function allowedCollection(
  id: unknown,
  list: readonly AllowedCollection[] = ALLOWED_COLLECTIONS,
): AllowedCollection | null {
  if (typeof id !== 'string' || !OUTPOINT.test(norm(id))) return null;
  const n = norm(id);
  return list.find((c) => norm(c.id) === n) ?? null;
}

/** GorillaPool market listings for one collection (q = base64 MAP filter). */
export function collectionUrl(id: string, offset = 0, limit = COLLECTION_PAGE, api = GP_API): string {
  const q = btoa(JSON.stringify({ map: { subTypeData: { collectionId: id } } }));
  return `${api}/market?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`;
}

export type ChainPic = {
  origin: string;
  outpoint: string;
  collectionId: string;
  name: string;
  /** Item number from the name ("#123") or subTypeData.mintNumber; '' if none. */
  number: string;
  contentType: string;
  owner: string;
  /** Listing price in sats; 0 = not listed. */
  price: number;
  height: number;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});

/** subTypeData may arrive as an object or as a JSON string. */
function subTypeData(map: Rec): Rec {
  const s = map.subTypeData;
  if (typeof s === 'string') {
    try {
      return rec(JSON.parse(s));
    } catch {
      return {};
    }
  }
  return rec(s);
}

/** Indexer rows → pictures that pass the gate: allowlisted collection, safe image type, valid origin. */
export function parseCollection(json: unknown, list: readonly AllowedCollection[] = ALLOWED_COLLECTIONS): ChainPic[] {
  if (!Array.isArray(json)) return [];
  const out: ChainPic[] = [];
  const seen = new Set<string>();
  for (const raw of json) {
    const r = rec(raw);
    const originRec = rec(r.origin);
    const data = rec(originRec.data ?? r.data);
    const map = rec(data.map);
    const sub = subTypeData(map);
    const coll = allowedCollection(sub.collectionId, list);
    if (!coll) continue;
    const contentType = str(rec(rec(data.insc).file).type);
    if (!isSafeImageType(contentType)) continue;
    const origin = norm(str(originRec.outpoint) || str(r.outpoint));
    if (!OUTPOINT.test(origin) || seen.has(origin)) continue;
    seen.add(origin);
    const name = (str(map.name) || str(sub.name)).slice(0, 100) || coll.name;
    const number = /#\s*(\d+)/.exec(name)?.[1] ?? str(sub.mintNumber).slice(0, 12);
    out.push({
      origin,
      outpoint: norm(str(r.outpoint)) || origin,
      collectionId: norm(coll.id),
      name,
      number,
      contentType,
      owner: str(r.owner),
      price: Math.max(0, num(rec(rec(r.data).list).price)),
      height: num(r.height),
    });
  }
  return out;
}

/** Public link to the picture's bytes on chain (ordfs). */
export const ordfsUrl = (origin: string) => `https://ordfs.network/${origin}`;

// ── brief in-memory cache ──

const cache = new Map<string, { at: number; value: unknown }>();

/** Fetch one page of a collection; cached for CACHE_MS. Throws on network or HTTP errors. */
export async function fetchCollectionPage(
  id: string,
  offset: number,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<{ pics: ChainPic[]; rawCount: number }> {
  if (!allowedCollection(id)) return { pics: [], rawCount: 0 };
  const url = collectionUrl(norm(id), offset);
  const hit = cache.get(url);
  let raw: unknown;
  if (hit && now() - hit.at < CACHE_MS) raw = hit.value;
  else {
    const r = await fetcher(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(String(r.status));
    raw = await r.json();
    cache.set(url, { at: now(), value: raw });
  }
  return { pics: parseCollection(raw), rawCount: Array.isArray(raw) ? raw.length : 0 };
}
export const clearCollectionCache = () => cache.clear();
