/**
 * Page side of `window.CWI.getBalanceSummary()` (services/balanceSummary.ts): a connected app reads totals, nothing else.
 *
 *   await window.CWI.getBalanceSummary() → { sats, tokens: [{ id, sym, dec, amountRaw }] }
 *
 * The first call per site opens the wallet's own "See your balance (read-only)" line; the wallet takes the origin from
 * the browser. A refusal rejects with code ERR_PERMISSION_DENIED.
 */
import { BALANCE_SUMMARY_ACTION } from './services/balanceSummary';

export const attachBalanceSummary = (
  target: Record<string, unknown>,
  transport: (action: string, params: unknown) => Promise<unknown>,
) => {
  target.getBalanceSummary = () => transport(BALANCE_SUMMARY_ACTION, {});
};
