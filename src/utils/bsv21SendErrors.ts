/**
 * What a failed BSV-21 send tells the user.
 *
 * @1sat/actions sendBsv21 returns 'token-not-found' whenever its token details lookup throws (a timeout, a 5xx, an
 * offline phone), not only when the indexer has never heard of the token, so "Unknown token" was wrong for a
 * healthy token (TERANODE, 12 Oct 2026). 'overlay-validation-failed' (the output status lookup threw) fell through
 * to a generic snackbar.
 */
import type { Bsv21OverlayIssue } from '../components/Bsv21OverlayPrompt';

/** sendBsv21 errors that open the overlay prompt (only with validateOverlay). */
export const OVERLAY_ISSUES: Record<string, Bsv21OverlayIssue> = {
  'token-not-active': 'not-active',
  'tokens-queued': 'queued',
  'insufficient-valid-tokens': 'not-valid',
  // A lookup failure, not a verdict on the token.
  'token-not-found': 'unreachable',
};

/** A snackbar message for sendBsv21 / fund errors this view knows; undefined = use the generic mapping. */
export const bsv21ErrorMessage = (error: string | undefined, ticker: string): string | undefined => {
  switch (error) {
    case 'token-not-found':
      return "Couldn't reach the token indexer. Nothing was sent. Try again.";
    case 'overlay-validation-failed':
      return `Couldn't check your ${ticker} with the token indexer (it didn't answer). Nothing was sent. Try again in a minute.`;
    case 'funding-amount-unknown':
    case 'funding-template-unavailable':
      return `Couldn't get the ${ticker} indexer's price. Nothing was paid. Try again.`;
    case 'funding-amount-changed':
      return `The ${ticker} indexer changed its price. Nothing was paid. Check the new amount and confirm again.`;
    default:
      return undefined;
  }
};
