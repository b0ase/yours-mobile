import { parseSiteTheme, siteThemePack, siteThemeReadable } from './siteTheme';
import type { ThemePack } from './themePack';
import { familySite, type ThemeSite } from './themeSites';

/**
 * `window.CWI.theme.offer` (docs/SITE-THEMES.md "Offer from the page", owner 29 Oct 2026: "when a bWalletX is
 * connected on bchatx.com/fwuit the wallet should be able to take on a FWUIT theme"). A family site (themeSites.ts)
 * hands the wallet a campaign look from the page; the wallet shows one sheet (Use / Not now / Never for this site)
 * and saves an accepted look as an ordinary site theme (Settings › Theme › From sites), so switching back is the
 * usual Theme page. Colours and short plain text only: the same checks as the site's theme file (siteTheme.ts),
 * no images, SVG, URLs, CSS or fonts. Pure: the background owns the storage (services/themeOfferSite.ts).
 */
export const THEME_OFFER_MAX_BYTES = 4096;
const CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;

export type ThemeOfferResult = 'used' | 'declined' | 'never' | 'skipped';

/** The family site for a page origin (https, exact host or www., no port); null for anyone else. */
export const offerSite = (origin: string | undefined | null): ThemeSite | null =>
  typeof origin === 'string' && /^https:\/\/[^/]+$/.test(origin) ? familySite(origin) : null;

/** The pack id a campaign look is saved under: `site-<site>` for the site's own id, else `site-<site>-<campaign>`. */
export const offerPackId = (site: Pick<ThemeSite, 'id'>, id: string): string =>
  id === site.id ? `site-${site.id}` : `site-${site.id}-${id}`;

/**
 * Validates an offer from `site`'s page. Same fields and rules as a v1 theme file (`v` optional, `livery` and `badge`
 * not allowed), `id` is the campaign (1-24 of a-z 0-9 -), and the look must pass the wallet's contrast checks. Null
 * for anything else, so a bad offer never reaches a sheet.
 */
export function parseThemeOffer(v: unknown, site: Pick<ThemeSite, 'id'>): ThemePack | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  let size: number;
  try {
    size = JSON.stringify(v).length;
  } catch {
    return null;
  }
  if (size > THEME_OFFER_MAX_BYTES) return null;
  const o = v as Record<string, unknown>;
  if ('livery' in o || 'badge' in o) return null;
  if (o.v !== undefined && o.v !== 1) return null;
  if (typeof o.id !== 'string' || !CAMPAIGN_ID.test(o.id)) return null;
  // parseSiteTheme checks every key against the v1 list and the id against the site it is given.
  const t = parseSiteTheme({ ...o, v: 1 }, { id: o.id });
  if (!t || !siteThemeReadable(t)) return null;
  const pack = siteThemePack(t);
  if (!pack) return null;
  return { ...pack, id: offerPackId(site, o.id) };
}

/** What the background remembers (chrome.storage): offers shown this session, "Never" sites, looks already worn. */
export interface OfferMemory {
  /** `<origin>|<pack id>` shown this browser session. */
  shown: string[];
  /** Origins the user said "Never for this site" to. */
  never: string[];
  /** `<origin>|<pack id>` → the JSON of the pack the user took. */
  used: Record<string, string>;
}

export const EMPTY_MEMORY: OfferMemory = { shown: [], never: [], used: {} };

/** Why an offer gets no sheet, or null when it may show one. Once per site and look per session; "Never" sticks. */
export function offerBlocked(memory: OfferMemory, origin: string, pack: ThemePack): string | null {
  if (memory.never.includes(origin)) return 'never';
  const key = `${origin}|${pack.id}`;
  if (memory.used[key] === JSON.stringify(pack)) return 'worn';
  if (memory.shown.includes(key)) return 'asked';
  return null;
}

/** The memory after the user answered. */
export function afterAnswer(
  memory: OfferMemory,
  origin: string,
  pack: ThemePack,
  answer: ThemeOfferResult,
): OfferMemory {
  const key = `${origin}|${pack.id}`;
  const shown = memory.shown.includes(key) ? memory.shown : [...memory.shown, key].slice(-100);
  if (answer === 'never')
    return { ...memory, shown, never: [...memory.never.filter((o) => o !== origin), origin].slice(-200) };
  if (answer === 'used') {
    const used = Object.entries({ ...memory.used, [key]: JSON.stringify(pack) }).slice(-50);
    return { ...memory, shown, used: Object.fromEntries(used) };
  }
  return { ...memory, shown };
}
