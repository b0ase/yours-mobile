import { contrast, luminance } from './colour';
import { THEMES, type Accent, type AccentId } from './accents';
import { atLeast, type Holding } from '../chat/tokenRooms';

/**
 * Theme packs as JSON (docs/THEME-STORE-PLAN.md step 1). A pack is the `Accent` look (accents.ts) plus who made
 * it and how it is had: `free` (apply now), `premium` (priced, not on sale yet), `holder` (unlocks while the wallet
 * holds the pack's token) or `edition` (a $99/yr custom edition). The bundled packs are expressed in this format
 * (BUNDLED_PACKS) and served read-only by site/api/themes.js from site/api/themes.json (kept equal by
 * themePack.test.ts). A pack from the catalog is validated with parseThemePack before it can paint anything.
 */
export const THEME_PACK_FORMAT = 'bwx-theme/1';
export type ThemeTier = 'free' | 'premium' | 'holder' | 'edition';
export const THEME_TIERS: readonly ThemeTier[] = ['free', 'premium', 'holder', 'edition'];

/** The look: every Accent field except identity and picker bookkeeping. */
export type ThemeLook = Omit<Accent, 'id' | 'kind' | 'label' | 'group' | 'edition' | 'blurb'>;

export interface ThemeToken {
  kind: 'bsv21' | 'coll';
  /** txid_vout of the token (or collection) origin. */
  id: string;
  symbol: string;
  dec: number;
  /** Raw (unscaled) amount the wallet must hold. */
  min_raw: string;
}

export interface ThemePack {
  format: typeof THEME_PACK_FORMAT;
  id: string;
  label: string;
  blurb?: string;
  /** Who made it: "bWalletX", an edition credit, or a creator's handle. */
  creator: string;
  tier: ThemeTier;
  /** Holder packs: the token that unlocks it. */
  token?: ThemeToken;
  /** Premium packs: the price shown (no payments yet). */
  price_usd?: number;
  /** Swatch for the store grid: [page, surface, accent]. */
  preview: [string, string, string];
  look: ThemeLook;
}

const HEX = /^#[0-9a-f]{6}$/i;
const COLOUR_KEYS = [
  'accent',
  'hi',
  'lo',
  'on',
  'bg',
  'surface',
  'surface2',
  'nav',
  'text',
  'muted',
  'line',
  'success',
  'danger',
] as const;
const STRING_KEYS = ['shadow', 'trim', 'glow', 'fontNum', 'fontHead', 'radius', 'radiusCard', 'pattern'] as const;
// CSS values land in style.setProperty, never in markup; still refuse anything that could reach outside the page.
const SAFE_CSS = /^[^;{}<>\\]*$/;
const NO_URL = /url\s*\(|expression|@import/i;

const lookOf = (a: Accent): ThemeLook => {
  const { id: _i, kind: _k, label: _l, group: _g, edition: _e, blurb: _b, ...look } = a;
  return look;
};

/** A bundled Accent as a catalog pack. Editions are bundled and free to apply; the $99 order makes new ones. */
export const packOfAccent = (a: Accent): ThemePack => ({
  format: THEME_PACK_FORMAT,
  id: a.id,
  label: a.label,
  ...(a.blurb ? { blurb: a.blurb } : {}),
  creator: a.edition ?? 'bWalletX',
  tier: 'free',
  preview: [a.bg, a.surface, a.accent],
  look: lookOf(a),
});

/** Every bundled theme pack, in picker order. */
export const BUNDLED_PACKS: readonly ThemePack[] = THEMES.map(packOfAccent);

/** Light themes: white/light cards and black text (house rule), at AA contrast. The page may be paper-coloured. */
export const lightLookOk = (l: ThemeLook): boolean =>
  luminance(l.bg) > 0.4 &&
  luminance(l.surface) > 0.6 &&
  luminance(l.surface2) > 0.5 &&
  luminance(l.text) < 0.05 &&
  contrast(l.text, l.surface) >= 4.5 &&
  contrast(l.text, l.bg) >= 4.5;

const str = (v: unknown, max = 80): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Validates a catalog pack; null for anything malformed or unsafe. */
export function parseThemePack(v: unknown): ThemePack | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (p.format !== THEME_PACK_FORMAT) return null;
  if (!str(p.id, 40) || !/^[a-z0-9][a-z0-9-]*$/.test(p.id) || !str(p.label, 40) || !str(p.creator)) return null;
  if (p.blurb !== undefined && !str(p.blurb, 120)) return null;
  if (!THEME_TIERS.includes(p.tier as ThemeTier)) return null;
  const tier = p.tier as ThemeTier;
  if (
    !Array.isArray(p.preview) ||
    p.preview.length !== 3 ||
    !p.preview.every((c) => typeof c === 'string' && HEX.test(c))
  )
    return null;
  const l = p.look as Record<string, unknown> | null;
  if (!l || typeof l !== 'object') return null;
  if (l.scheme !== 'dark' && l.scheme !== 'light') return null;
  for (const k of COLOUR_KEYS) if (typeof l[k] !== 'string' || !HEX.test(l[k] as string)) return null;
  for (const k of STRING_KEYS) {
    const s = l[k];
    if (!str(s, 160) || !SAFE_CSS.test(s) || NO_URL.test(s)) return null;
  }
  if (l.tint !== undefined && (typeof l.tint !== 'string' || !HEX.test(l.tint))) return null;
  if (typeof l.weightHead !== 'number' || l.weightHead < 100 || l.weightHead > 900) return null;
  if (l.paper !== undefined && typeof l.paper !== 'boolean') return null;
  const look = l as unknown as ThemeLook;
  if (look.scheme === 'light' && !lightLookOk(look)) return null;
  let token: ThemeToken | undefined;
  if (tier === 'holder') {
    const t = p.token as Record<string, unknown> | null;
    if (!t || (t.kind !== 'bsv21' && t.kind !== 'coll')) return null;
    if (!str(t.id, 80) || !/^[0-9a-f]{64}_\d+$/.test(t.id) || !str(t.symbol, 40)) return null;
    if (typeof t.dec !== 'number' || !Number.isInteger(t.dec) || t.dec < 0 || t.dec > 18) return null;
    if (typeof t.min_raw !== 'string' || !/^\d+$/.test(t.min_raw)) return null;
    token = { kind: t.kind, id: t.id, symbol: t.symbol, dec: t.dec, min_raw: t.min_raw };
  }
  let price: number | undefined;
  if (tier === 'premium') {
    if (typeof p.price_usd !== 'number' || !(p.price_usd > 0) || p.price_usd > 100) return null;
    price = p.price_usd;
  }
  return {
    format: THEME_PACK_FORMAT,
    id: p.id,
    label: p.label,
    ...(p.blurb ? { blurb: p.blurb as string } : {}),
    creator: p.creator,
    tier,
    ...(token ? { token } : {}),
    ...(price !== undefined ? { price_usd: price } : {}),
    preview: p.preview as [string, string, string],
    look: { ...look },
  };
}

/** Parses the catalog response ({ packs: [...] }), dropping invalid entries. */
export const parseCatalog = (v: unknown): ThemePack[] => {
  const list = v && typeof v === 'object' ? (v as { packs?: unknown }).packs : null;
  return Array.isArray(list) ? list.map(parseThemePack).filter((p): p is ThemePack => !!p) : [];
};

/** The pack as an Accent the app can paint (as the runtime 'custom' pack). */
export const accentOfPack = (p: ThemePack): Accent => ({
  ...p.look,
  id: 'custom',
  kind: 'theme',
  label: p.label,
  ...(p.blurb ? { blurb: p.blurb } : {}),
});

/** The bundled pack id this catalog pack is, if it is one (applied by id, so it survives restarts as itself). */
export const bundledId = (p: ThemePack): AccentId | null => {
  const a = THEMES.find((t) => t.id === p.id);
  return a ? a.id : null;
};

/** Holder unlock: the wallet's raw balance of the pack's token reaches its minimum. */
// Same holding check as token rooms (chat/tokenRooms.ts atLeast over chat/holdings.ts walletHoldings).
export const holderUnlocked = (
  p: ThemePack,
  held: ReadonlyArray<Pick<Holding, 'kind' | 'id' | 'amountRaw'>>,
): boolean => {
  const t = p.tier === 'holder' ? p.token : undefined;
  if (!t) return false;
  return held.some((h) => h.kind === t.kind && h.id === t.id && atLeast(h.amountRaw, t.min_raw));
};
