import { withBeefHint } from '../../brand/walletError';
import { getErrorMessage } from '../../utils/tools';

/** Readable purchase failures; @1sat/actions' own codes otherwise surface as "Unknown error". */
const PURCHASE_ERRORS: Record<string, string> = {
  'listing-not-found-in-overlay':
    "This listing isn't in the 1Sat index any more (it may have just sold). Refresh and try another.",
  'listing-transaction-not-found': "Couldn't fetch this listing's transaction. Try again in a moment.",
  'listing-output-not-found': 'This listing has already been bought or cancelled.',
  'not-an-ordlock-listing': "This isn't a standard 1Sat listing, so it can't be bought here.",
  'services-required-for-purchase': 'The wallet is still starting up. Try again in a moment.',
};
const purchaseText = (e: unknown) => {
  if (typeof e === 'string' && PURCHASE_ERRORS[e]) return PURCHASE_ERRORS[e];
  const generic = getErrorMessage(e);
  // Never hide the real reason behind a generic message.
  if (/unknown error/i.test(generic) && e) return `Purchase failed: ${e instanceof Error ? e.message : String(e)}`;
  return generic;
};
/** Market and Exchange purchases share these messages. */
export const purchaseError = (e: unknown) => withBeefHint(purchaseText(e));
