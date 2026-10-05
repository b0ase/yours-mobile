/**
 * 1Sat Ordnance (tokenblaster.lol): game guns sold as 1Sat ordinals, shown in bWalletX as 3D models
 * (owner, 6 Oct 2026; handoff: tokenblaster.lol/docs/handoff-bwalletx-3d-cabinet.md).
 * The catalogue and the list of genuine issues come from tokenblaster.lol (CORS open). Only origins in
 * `issued` paid the house: look-alikes with the same MAP are treated as ordinary images, never as 3D guns.
 */
export const ORDNANCE_API = 'https://www.tokenblaster.lol/api/ordnance';
export const ORDNANCE_STORE = 'https://www.tokenblaster.lol/1satordnance/store';

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

export type Weapon = {
  id: string;
  name: string;
  rarity: Rarity;
  tagline: string;
  description: string;
  edition: number;
  priceSats: number;
  model: string;
  modelBase: string;
  tint: string;
  image: string;
  /** Per-model display hints from the manifest (tokenblaster.lol 47e1089); older manifests omit them. */
  tintAmount?: number;
  flip?: boolean;
  roll?: number;
  spin?: string | null;
};

/** Rim light / glow per rarity, as in the games. */
export const RARITY_COLOR: Record<Rarity, string> = {
  common: '#c9b37a',
  rare: '#6ae0ff',
  epic: '#c070ff',
  legendary: '#ffd700',
};

export const storeUrl = (weaponId: string) => `${ORDNANCE_STORE}#${weaponId}`;

let manifest: Promise<Weapon[]> | null = null;
/** The 22 guns. Cached for the session; a failed fetch is retried on the next call. */
export const loadWeapons = (): Promise<Weapon[]> =>
  (manifest ??= fetch(`${ORDNANCE_API}/manifest`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`manifest ${r.status}`))))
    .then((d: { weapons: Weapon[] }) => d.weapons)
    .catch((e) => {
      manifest = null;
      throw e;
    }));

let issued: Promise<Map<string, string>> | null = null;
/** origin outpoint → weapon id, for every genuine (paid) issue. Refreshed at most once a minute. */
let issuedAt = 0;
export const loadIssued = (): Promise<Map<string, string>> => {
  if (!issued || Date.now() - issuedAt > 60_000) {
    issuedAt = Date.now();
    issued = fetch(`${ORDNANCE_API}/issued`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`issued ${r.status}`))))
      .then((d: { issued: Record<string, string[]> }) => {
        const m = new Map<string, string>();
        Object.entries(d.issued).forEach(([w, origins]) => origins.forEach((o) => m.set(normOutpoint(o), w)));
        return m;
      })
      .catch((e) => {
        issued = null;
        throw e;
      });
  }
  return issued;
};

/** "txid_0" and "txid.0" are the same outpoint. */
export const normOutpoint = (o: string) => o.replace('.', '_');
