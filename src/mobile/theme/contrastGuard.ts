import { contrast, ensureContrast, pickReadable } from './colour';
import type { Accent } from './accents';

/**
 * Contrast guard for themed colours (COO report, 7 Nov 2026: a connected site's LIGHT theme left white text on its
 * paper, red "% today" on paper, and a dark-blue balance and Scan pill on the dark card). Every foreground the wallet
 * derives from a theme is checked against the ground it actually sits on: 4.5:1 for text, 3:1 for icons (WCAG AA).
 * A pair that already reads is returned exactly as it was, so the Gold look and every passing pack stay identical.
 */
export const TEXT_RATIO = 4.5;
export const ICON_RATIO = 3;
export type InkKind = 'text' | 'icon';
export const ratioFor = (kind: InkKind): number => (kind === 'icon' ? ICON_RATIO : TEXT_RATIO);

/**
 * The wallet card face when it does NOT wear the theme (an own picture, or the default art under its dark shade:
 * mobile.css .bw-wcard-face). Its text stays light in every pack, so its accent ink is checked against this.
 */
export const DARK_CARD_GROUND = '#1B1B1D';
export const DARK_CARD_INK = '#F2F2F0';
/** An accent stop is kept on that face only with this margin, since the art under the shade moves its ground. */
const DARK_CARD_MARGIN = 7;

/** Light ink on a dark ground, dark ink on a light one: whichever of the two reads better on `bg`. */
export function contrastPick(bg: string, light = '#FFFFFF', dark = '#000000'): string {
  return (contrast(light, bg) >= contrast(dark, bg) ? light : dark).toUpperCase();
}

/**
 * `fg` when it reaches the ratio on every ground; otherwise the readable choice: the same hue moved away from the
 * grounds (lighter on dark, darker on light) until it reads, and black or white when no shade of it does.
 */
export function guardInk(fg: string, bgs: string | readonly string[], kind: InkKind = 'text'): string {
  const list = typeof bgs === 'string' ? [bgs] : [...bgs];
  return ensureContrast(fg, list, ratioFor(kind));
}

/**
 * A whole look, guarded: body and secondary text, accent ink (Scan, active tabs, links: text, so 4.5:1), the accent
 * itself (icons and fills: 3:1), success / danger, and the ink on the accent's three stops. The ink on the stops is
 * picked AFTER the stops are guarded (the stops painted are the guarded ones), and a stop that still leaves that ink
 * under 4.5:1 is moved away from it until it reads.
 */
export function guardLook(a: Accent): Accent {
  const grounds = [a.bg, a.surface, a.surface2];
  const hi = guardInk(a.hi, grounds);
  const accent = guardInk(a.accent, [a.bg, a.surface], 'icon');
  // The ink that reads on all three stops; else the one for accent and hi (hi is also text on the paper, so it keeps
  // its darkness), and the lighter lo stop is moved to match.
  const all = pickReadable([a.on], [accent, hi, a.lo], TEXT_RATIO);
  const on = [accent, hi, a.lo].every((c) => contrast(all, c) >= TEXT_RATIO)
    ? all
    : pickReadable([a.on], [accent, hi], TEXT_RATIO);
  const fill = (stop: string) => guardInk(stop, on);
  return {
    ...a,
    text: same(a.text, guardInk(a.text, grounds)),
    muted: same(a.muted, guardInk(a.muted, grounds)),
    hi: same(a.hi, fill(hi)),
    accent: same(a.accent, fill(accent)),
    lo: same(a.lo, fill(a.lo)),
    on: same(a.on, on),
    success: same(a.success, guardInk(a.success, grounds)),
    danger: same(a.danger, guardInk(a.danger, grounds)),
  };
}

/** Keeps the original spelling when the guard did not change the colour (so passing looks are byte-identical). */
const same = (was: string, now: string): string => (was.toUpperCase() === now.toUpperCase() ? was : now);

/**
 * Inks for the dark card face inside a light pack: a contrast pick for that face, not for the pack's paper. The face's
 * ground moves with the art under its shade (white text is held at 4.5:1 over the brightest art), so the accent stop
 * is kept only with a wide margin (7:1 on the face's base, as Gold's gold has) and otherwise the face's own light ink
 * is used. Pills on the face fade from `hi` to `lo`, so `on` (the ink on them) must read on both: when the pack's own
 * `lo` leaves no such ink, the pill is flat `hi`.
 */
export function darkGroundInks(a: Pick<Accent, 'hi' | 'lo' | 'on'>): { hi: string; lo: string; on: string } {
  const kept = contrast(a.hi, DARK_CARD_GROUND) >= DARK_CARD_MARGIN;
  const hi = kept ? a.hi.toUpperCase() : contrastPick(DARK_CARD_GROUND, DARK_CARD_INK);
  const reads = (on: string, stops: string[]) => stops.every((s) => contrast(on, s) >= TEXT_RATIO);
  if (kept) {
    const on = pickReadable([a.on], [hi, a.lo], TEXT_RATIO);
    if (reads(on, [hi, a.lo])) return { hi, lo: a.lo.toUpperCase(), on };
  }
  return { hi, lo: hi, on: pickReadable([a.on], [hi], TEXT_RATIO) };
}
