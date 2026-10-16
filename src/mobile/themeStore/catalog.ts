import { BWALLET_PAYMAIL_API } from '../names/config';
import { saveAccent, saveStorePack } from '../theme/accent';
import { BUNDLED_PACKS, bundledId, parseCatalog, type ThemePack, type ThemeTier } from '../theme/themePack';

/** Read-only catalog (site/api/themes.js). Falls back to the bundled packs offline. */
export const THEMES_URL = BWALLET_PAYMAIL_API ? `${BWALLET_PAYMAIL_API}/api/themes` : '';

export async function fetchCatalog(f: typeof fetch = fetch): Promise<ThemePack[]> {
  try {
    if (!THEMES_URL) return [...BUNDLED_PACKS];
    const r = await f(THEMES_URL);
    if (!r.ok) return [...BUNDLED_PACKS];
    const packs = parseCatalog(await r.json());
    return packs.length ? packs : [...BUNDLED_PACKS];
  } catch {
    return [...BUNDLED_PACKS];
  }
}

export const byTier = (packs: readonly ThemePack[], tier: ThemeTier): ThemePack[] =>
  packs.filter((p) => p.tier === tier);

/** Applies a pack: bundled ones by id (as Theme does), others as the account's saved store pack. */
export function applyPack(account: string, p: ThemePack): void {
  const id = bundledId(p);
  if (id) saveAccent(account, id);
  else saveStorePack(account, p);
}
