/**
 * Page side of `window.CWI.theme` (services/themeOfferSite.ts): a family site offers a look to the connected wallet.
 *
 *   await wallet.theme.offer({ id, label, scheme, accent, … })  → { result: 'used' | 'declined' | 'never' | 'skipped' }
 *
 * The wallet shows one sheet ("Use the FWUIT look?") and never applies a theme without the tap. The origin comes
 * from the browser, and the call must come from a tap on the page.
 */
import { THEME_OFFER_ACTION } from './services/themeOfferAction';

export const attachThemeOffer = (
  target: Record<string, unknown>,
  transport: (action: string, params: unknown) => Promise<unknown>,
) => {
  target.theme = Object.freeze({
    offer: (args: unknown) => transport(THEME_OFFER_ACTION, args ?? {}),
  });
};
