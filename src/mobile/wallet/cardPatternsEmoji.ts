import { mix } from '../theme/colour';
import { emojiTheme, type EmojiTheme } from '../theme/emojiThemes';
import { TWEMOJI } from './emojiArt/twemoji';

/**
 * Emoji theme card art (owner, 18 Oct 2026): an original composition around one Twemoji (CC-BY 4.0, emojiArt/
 * ATTRIBUTION.md). The pack's dark ground with a glow in its accent, a tilted wallpaper of the small emoji, the big
 * emoji on the right (clear of the balance at bottom left) and a thin accent trim. Pure SVG, a few KB per card.
 */
const W = 1011;
const H = 637;

const symbol = (e: EmojiTheme) => `<symbol id="e" viewBox="0 0 36 36">${TWEMOJI[e.code] ?? ''}</symbol>`;

export function emojiCardSvg(e: EmojiTheme, variant = 0): string {
  const a = e.accent;
  const tilt = variant % 2 ? 8 : -8;
  const big = 400;
  const bx = W - big - 70;
  const by = (H - big) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>${symbol(e)}` +
    `<radialGradient id="gr" cx="74%" cy="46%" r="85%"><stop offset="0" stop-color="${mix(e.bg, a, 0.32)}"/>` +
    `<stop offset="0.5" stop-color="${mix(e.bg, a, 0.1)}"/><stop offset="1" stop-color="${e.bg}"/></radialGradient>` +
    `<radialGradient id="glow"><stop offset="0" stop-color="${a}" stop-opacity="0.45"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient>` +
    `<pattern id="wall" width="132" height="132" patternUnits="userSpaceOnUse" patternTransform="rotate(${-tilt * 1.5})">` +
    `<use href="#e" xlink:href="#e" x="12" y="12" width="40" height="40"/><use href="#e" xlink:href="#e" x="78" y="78" width="40" height="40"/></pattern>` +
    `<linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0.35"/><stop offset="1" stop-color="#fff" stop-opacity="0.08"/></linearGradient>` +
    `<mask id="m"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#gr)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#wall)" mask="url(#m)" opacity="0.5"/>` +
    `<circle cx="${bx + big / 2}" cy="${by + big / 2}" r="${big * 0.62}" fill="url(#glow)"/>` +
    `<use href="#e" xlink:href="#e" x="${bx}" y="${by}" width="${big}" height="${big}" transform="rotate(${tilt} ${bx + big / 2} ${by + big / 2})"/>` +
    `<rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="30" fill="none" stroke="${a}" stroke-opacity="0.45" stroke-width="3"/>` +
    `</svg>`
  );
}

/** A square tile (shop logo, receipt art, Store chips): the emoji on the pack's ground. */
export function emojiTileSvg(e: EmojiTheme, size = 192): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 48 48">` +
    `<defs>${symbol(e)}<radialGradient id="g"><stop offset="0" stop-color="${mix(e.bg, e.accent, 0.4)}"/><stop offset="1" stop-color="${e.bg}"/></radialGradient></defs>` +
    `<rect width="48" height="48" rx="10" fill="url(#g)"/><use href="#e" xlink:href="#e" x="8" y="8" width="32" height="32"/></svg>`
  );
}

const uri = (svg: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
const cache = new Map<string, string>();

/** The card art for an emoji pack, as a data URI; '' for an unknown id. */
export function emojiArtUri(id: string, variant = 0): string {
  const e = emojiTheme(id);
  if (!e) return '';
  const k = `${id}:${variant % 2}`;
  let u = cache.get(k);
  if (!u) {
    u = uri(emojiCardSvg(e, variant));
    cache.set(k, u);
  }
  return u;
}

export function emojiTileUri(id: string, size = 192): string {
  const e = emojiTheme(id);
  return e ? uri(emojiTileSvg(e, size)) : '';
}
