/**
 * `window.CWI.theme.offer` (docs/SITE-THEMES.md "Offer from the page"). Checks the asking origin (from Chrome) is a
 * family site, validates the look (mobile/theme/themeOffer.ts), applies the once-per-session and "Never" rules, then
 * asks the user on the wallet's own sheet. Saving the look happens on that sheet (an extension page, where the theme
 * storage lives). Pure over deps so it is unit-tested in themeOfferSite.test.ts.
 */
import {
  afterAnswer,
  offerBlocked,
  offerSite,
  parseThemeOffer,
  type OfferMemory,
  type ThemeOfferResult,
} from '../mobile/theme/themeOffer';
import type { ThemePack } from '../mobile/theme/themePack';

export { isThemeOfferAction } from './themeOfferAction';

export type ThemeOfferDeps = {
  /** True when no account is open (locked or not set up): offers are skipped, never an unlock sheet. */
  locked: () => Promise<boolean>;
  load: () => Promise<OfferMemory>;
  save: (m: OfferMemory) => Promise<void>;
  /** Shows the sheet; resolves with the user's answer ('declined' on close or timeout). */
  ask: (sheet: { host: string; pack: ThemePack }) => Promise<ThemeOfferResult>;
};

export type ThemeOfferSiteResult =
  | { success: true; data: { result: ThemeOfferResult; reason?: string } }
  | { success: false; error: string; code: string };

export async function runThemeOffer(
  origin: string | undefined,
  topFrame: boolean,
  params: unknown,
  deps: ThemeOfferDeps,
): Promise<ThemeOfferSiteResult> {
  const site = offerSite(origin);
  if (!site || !origin || !topFrame)
    return { success: false, error: 'Theme offers are only open to bWalletX family sites', code: 'ORIGIN' };
  const pack = parseThemeOffer(params, site);
  if (!pack)
    return {
      success: false,
      error:
        'Theme must be { id, label, scheme, accent, hi, lo, on, bg, surface, surface2, nav, text, muted, line, success, danger } with readable contrast',
      code: 'BAD_REQUEST',
    };
  const skipped = (reason: string): ThemeOfferSiteResult => ({ success: true, data: { result: 'skipped', reason } });
  if (await deps.locked()) return skipped('locked');
  const memory = await deps.load();
  const blocked = offerBlocked(memory, origin, pack);
  if (blocked) return skipped(blocked);
  // Mark it shown before asking, so a page calling twice in a row gets one sheet.
  await deps.save(afterAnswer(memory, origin, pack, 'declined'));
  const answer = await deps.ask({ host: new URL(origin).host, pack });
  await deps.save(afterAnswer(await deps.load(), origin, pack, answer));
  return { success: true, data: { result: answer } };
}
