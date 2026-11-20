/**
 * Honest refusal codes (P0, 20 Nov 2026). Only a person's real "No" (Not now / Cancel / closing the sheet) may answer
 * a site with ERR_PERMISSION_DENIED (services/userDenied.ts). Every refusal the WALLET makes on its own gets its own
 * code and a plain sentence, so a site never tells someone "you cancelled" when they did not (RB's bit-sign seal:
 * "You cancelled in your wallet", 20 Nov 2026).
 *
 * ⚠ Every code here is for a refusal made BEFORE anything was signed or broadcast: bit-sign (#774) releases its seal
 * hold on exactly these codes. A failure that may have broadcast must never use one of them.
 *
 * The error carries `code` and `name` (both the code), `status` and `isError`. Paths that pass only the message on
 * (the background's generic `{ success: false, error }` replies) get the code back by message (withRefusalCode), as
 * promptWatchdog.ts withPromptNotShownCode does. Pure.
 */
import { BLOCKED_SITE_REFUSAL } from './permissionBundle';
import { NO_PAYEES_REFUSAL, RECIPIENTS_REFUSAL } from './spendRecipients';
import { SEAL_BUSY_REFUSAL } from './sealPass';
import { APP_NAME } from '../mobile/storeBuild';

export const PROMPT_STALE_CODE = 'ERR_PROMPT_STALE';
export const SEAL_NOT_COVERED_CODE = 'ERR_SEAL_NOT_COVERED';
export const SPEND_NOT_COVERED_CODE = 'ERR_SPEND_NOT_COVERED';
export const SITE_BLOCKED_CODE = 'ERR_SITE_BLOCKED';
export const PAIRING_ENDED_CODE = 'ERR_PAIRING_ENDED';
export const WALLET_LOCKED_CODE = 'ERR_WALLET_LOCKED';
/** Not in bit-sign's release list on purpose: an internal refusal keeps the site's hold (safe side). */
export const INTERNAL_REFUSAL_CODE = 'ERR_INTERNAL';

export const PROMPT_STALE_MESSAGE = 'The request changed while it was open. Try again.';
export const PAIRING_ENDED_MESSAGE = 'This pairing has ended';
export const WALLET_LOCKED_MESSAGE = `${APP_NAME} couldn't confirm it's you (wrong password, or the check could not run), so nothing was signed or paid. Try again.`;
/** Every ERR_INTERNAL refusal's message starts with this, then says why. */
export const INTERNAL_REFUSAL_PREFIX = `${APP_NAME} refused this request: `;

/** The codes a wallet refusal may carry besides ERR_PERMISSION_DENIED. Transports pass these on unchanged. */
export const REFUSAL_CODES: readonly string[] = [
  PROMPT_STALE_CODE,
  SEAL_NOT_COVERED_CODE,
  SPEND_NOT_COVERED_CODE,
  SITE_BLOCKED_CODE,
  PAIRING_ENDED_CODE,
  WALLET_LOCKED_CODE,
  INTERNAL_REFUSAL_CODE,
];
export const isRefusalCode = (c: unknown): c is string => typeof c === 'string' && REFUSAL_CODES.includes(c);

export type RefusalError = Error & { code: string; status: number; isError: true };

export const refusalError = (code: string, message: string, status = 403): RefusalError =>
  Object.assign(new Error(message), { code, name: code, status, isError: true as const });

export const promptStaleError = () => refusalError(PROMPT_STALE_CODE, PROMPT_STALE_MESSAGE, 409);
export const siteBlockedError = () => refusalError(SITE_BLOCKED_CODE, BLOCKED_SITE_REFUSAL);
export const pairingEndedError = () => refusalError(PAIRING_ENDED_CODE, PAIRING_ENDED_MESSAGE);
export const walletLockedError = () => refusalError(WALLET_LOCKED_CODE, WALLET_LOCKED_MESSAGE, 401);
export const sealNotCoveredError = (message = SEAL_BUSY_REFUSAL) => refusalError(SEAL_NOT_COVERED_CODE, message, 409);
export const spendNotCoveredError = (message = NO_PAYEES_REFUSAL) => refusalError(SPEND_NOT_COVERED_CODE, message);
/** A policy or internal refusal, with its reason. A reason that already reads as a sentence is kept whole. */
export const internalRefusal = (reason: string) =>
  refusalError(INTERNAL_REFUSAL_CODE, `${INTERNAL_REFUSAL_PREFIX}${reason || 'an internal check failed'}`, 500);

/**
 * The coded error for something thrown while a sheet was being put together (background.ts showPermissionPrompt):
 * a payment whose payees the wallet cannot read is ERR_SPEND_NOT_COVERED, anything else ERR_INTERNAL with its reason.
 */
export const sheetBuildRefusal = (error: unknown): RefusalError => {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (e && isRefusalCode(e.code) && error instanceof Error) return error as RefusalError;
  const msg = error instanceof Error ? error.message : String(error ?? '');
  if (msg === NO_PAYEES_REFUSAL || msg === RECIPIENTS_REFUSAL) return spendNotCoveredError(msg);
  return internalRefusal(msg);
};

/** Fixed messages → code and status, for replies that carry only the message. */
const CODED: [string, string, number][] = [
  [PROMPT_STALE_MESSAGE, PROMPT_STALE_CODE, 409],
  [BLOCKED_SITE_REFUSAL, SITE_BLOCKED_CODE, 403],
  [PAIRING_ENDED_MESSAGE, PAIRING_ENDED_CODE, 403],
  [WALLET_LOCKED_MESSAGE, WALLET_LOCKED_CODE, 401],
  [SEAL_BUSY_REFUSAL, SEAL_NOT_COVERED_CODE, 409],
  [NO_PAYEES_REFUSAL, SPEND_NOT_COVERED_CODE, 403],
  [RECIPIENTS_REFUSAL, SPEND_NOT_COVERED_CODE, 403],
];

/** The code for a refusal message, or null (not one of ours). */
export const refusalCodeFor = (message: unknown): { code: string; status: number } | null => {
  if (typeof message !== 'string' || !message) return null;
  if (message.startsWith(INTERNAL_REFUSAL_PREFIX)) return { code: INTERNAL_REFUSAL_CODE, status: 500 };
  const hit = CODED.find(([m]) => message === m) ?? CODED.find(([m]) => message.includes(m));
  return hit ? { code: hit[1], status: hit[2] } : null;
};

/** Adds the refusal's code to a `{ success: false, error }` reply that has none. Anything else is returned as is. */
export function withRefusalCode<R>(response: R): R {
  const r = response as { success?: unknown; error?: unknown; code?: unknown } | null | undefined;
  if (!r || typeof r !== 'object' || r.success !== false || r.code !== undefined) return response;
  const hit = refusalCodeFor(r.error);
  return hit ? ({ ...r, code: hit.code, status: hit.status } as R) : response;
}
