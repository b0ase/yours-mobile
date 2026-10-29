/**
 * `window.CWI.proveHoldings()` from bChatX / bit-sign (29 Oct 2026). A user who signs in on the bChatX website never
 * opens the wallet's own Chat tab, so mobile/chat/holdings.ts proveHoldings never ran and bit-sign had no addresses
 * for them (bit_sign_wallet_addresses empty, $b swap lookups found nothing). The site now asks on sign-in/connect.
 *
 * The wallet signs one message per key that holds room tokens (plus its deposit key) and posts the proofs itself:
 * signatures only, no transaction, nothing spent. The first call per site per account opens one sheet; Allow is
 * remembered, so later calls (every sign-in) run without a sheet. Pure over deps: unit-tested in
 * proveHoldingsSite.test.ts.
 */
import { isProveHoldingsOrigin } from './proveHoldingsAction';

export { isProveHoldingsAction, isProveHoldingsOrigin } from './proveHoldingsAction';

export type ProveHoldingsDeps = {
  /** True when no account is open: refused, never an unlock sheet just for this. */
  locked: () => Promise<boolean>;
  granted: (origin: string) => Promise<boolean>;
  grant: (origin: string) => Promise<void>;
  /** Shows the sheet; resolves true only on Allow (false on close or timeout). */
  ask: (host: string) => Promise<boolean>;
  /** Signs in to bit-sign as this wallet and posts the proofs. Resolves with how many addresses were accepted. */
  prove: () => Promise<number>;
};

export type ProveHoldingsResult =
  | { success: true; data: { linked: number } }
  | { success: false; error: string; code: string };

export async function runSiteProveHoldings(
  origin: string | undefined,
  deps: ProveHoldingsDeps,
): Promise<ProveHoldingsResult> {
  if (!origin || !isProveHoldingsOrigin(origin))
    return { success: false, error: 'Only bChatX can link wallet addresses', code: 'ORIGIN' };
  try {
    if (await deps.locked()) return { success: false, error: 'Unlock bWalletX first', code: 'LOCKED' };
    if (!(await deps.granted(origin))) {
      const allow = await deps.ask(new URL(origin).host);
      if (!allow) return { success: false, error: 'Declined', code: 'ERR_PERMISSION_DENIED' };
      await deps.grant(origin);
    }
    return { success: true, data: { linked: await deps.prove() } };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e), code: 'ERROR' };
  }
}
