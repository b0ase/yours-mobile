/**
 * What a connected site is told when its createAction fails (TERRORNODE audit, 29 Oct 2026).
 *
 * The external CWI path used to pass the toolbox's raw text through: a plain one-output payment answered
 * WERR_INTERNAL "An internal error has occurred.", which tells neither the site nor the person what to do. Here the
 * error is mapped to one plain, specific sentence and the machine-readable code (WERR_*, ERR_*) is kept beside it,
 * so sites that branch on the code still can. Pure.
 */
import { classifySendError } from '../utils/sendErrors';
import { unprovableParentTxid } from './unprovableCoinRetry';

export const COIN_HISTORY_MESSAGE =
  "Couldn't load a coin's history from the Bitcoin data services, so the payment wasn't built. Nothing was sent. Try again in a minute.";
export const WALLET_INTERNAL_MESSAGE =
  "bWalletX couldn't build this payment (a coin's data was missing or a Bitcoin data service was busy). Nothing was broadcast. Try again in a minute.";

const codeOf = (e: unknown): string | undefined => {
  const o = e as { code?: unknown; name?: unknown } | null;
  const c = (typeof o?.code === 'string' && o.code) || (typeof o?.name === 'string' && o.name) || '';
  return /^(WERR|ERR)_[A-Z0-9_]+$/.test(c) ? c : undefined;
};

/**
 * `described` is the background's own text for the error (describeWalletError, the funding or heal message); it is
 * kept when it is already specific. Returns the site's message and the original code.
 */
export function siteActionError(error: unknown, described: string): { error: string; code?: string } {
  const code = codeOf(error);
  const c = (msg: string) => (code ? { error: msg, code } : { error: msg });
  if (unprovableParentTxid(error)) return c(COIN_HISTORY_MESSAGE);
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (/WOC_RATE_LIMITED|rate-limiting/i.test(raw) || (error as { code?: unknown })?.code === 'WOC_RATE_LIMITED')
    return c(raw);
  const info = classifySendError(error);
  if (info.kind === 'wallet-internal') return c(WALLET_INTERNAL_MESSAGE);
  if (info.kind === 'network') return c(info.message);
  // Specific already (funding, broadcast verdict, heal advice, denial): leave the background's text alone.
  return c(described);
}
