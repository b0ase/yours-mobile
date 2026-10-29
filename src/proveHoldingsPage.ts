/**
 * Page side of `window.CWI.proveHoldings()` (services/proveHoldingsSite.ts): bChatX / bit-sign ask the wallet to
 * link the addresses that hold its tokens, on sign-in/connect or before a lookup that found none.
 *
 *   await window.CWI.proveHoldings() → { linked: number }
 *
 * The first call per site opens the wallet's own sheet; the wallet takes the origin from the browser.
 */
import { PROVE_HOLDINGS_ACTION } from './services/proveHoldingsAction';

export const attachProveHoldings = (
  target: Record<string, unknown>,
  transport: (action: string, params: unknown) => Promise<unknown>,
) => {
  target.proveHoldings = () => transport(PROVE_HOLDINGS_ACTION, {});
};
