/**
 * `window.CWI.swap.offer / accept` from bChatX (owner "money-ok atomic swap", 27 Oct 2026). Validates the site's
 * params, then runs mobile/p2p/swap/swapActions.ts with the wallet's own approval sheet (`ask`). Pure over deps so
 * it is unit-tested in swapSite.test.ts.
 */
import type { OneSatContext } from '@1sat/actions';
import { SwapError, validTerms, type SwapOffer, type SwapTerms } from '../mobile/p2p/swap/swap';
import { acceptSwap, offerSwap, type Ask, type RateQuote, type SwapStore } from '../mobile/p2p/swap/swapActions';
import { SWAP_ACCEPT_ACTION, SWAP_OFFER_ACTION, isSwapOrigin } from './swapAction';

export { isSwapAction, isSwapOrigin } from './swapAction';

export type SwapSiteDeps = {
  ctx: OneSatContext;
  quote: () => Promise<RateQuote | undefined>;
  ask: Ask;
  store: SwapStore;
};
export type SwapSiteResult = { success: true; data: unknown } | { success: false; error: string; code: string };

const bad = (error: string): SwapSiteResult => ({ success: false, error, code: 'BAD_REQUEST' });

const asTerms = (p: Record<string, unknown>): SwapTerms | null => (validTerms(p.terms) ? (p.terms as SwapTerms) : null);

export async function runSiteSwap(
  action: string,
  origin: string | undefined,
  params: unknown,
  deps: () => Promise<SwapSiteDeps>,
): Promise<SwapSiteResult> {
  if (!isSwapOrigin(origin)) return { success: false, error: 'Swaps are only available in bChatX', code: 'ORIGIN' };
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const terms = asTerms(p);
  if (!terms) return bad('terms must be { ref, docHash, tokenId, amount, priceUsd }');
  if (action === SWAP_ACCEPT_ACTION && (!p.offer || typeof p.offer !== 'object')) return bad('offer missing');
  try {
    const d = await deps();
    const quote = await d.quote();
    if (!quote)
      return { success: false, error: 'No BSV price yet. Open the wallet once, then try again', code: 'NO_RATE' };
    if (action === SWAP_OFFER_ACTION) {
      const offer = await offerSwap(d.ctx, { terms, quote, ask: d.ask });
      return { success: true, data: { offer } };
    }
    if (action === SWAP_ACCEPT_ACTION) {
      const r = await acceptSwap(d.ctx, { offer: p.offer as SwapOffer, terms, quote, ask: d.ask, store: d.store });
      return { success: true, data: r };
    }
    return bad('unknown swap call');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      error: msg,
      code: e instanceof SwapError && /declined/.test(msg) ? 'USER_REFUSED' : 'ERROR',
    };
  }
}
