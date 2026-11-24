import type { AuthResult } from '../siteGate';

/**
 * The seal's payment approval (security P0, 3 Nov 2026): the minute 011 seal paid 75 sats with NO prompt, because
 * an 'unavailable' OS prompt (no deviceOwnerAuth in this shell, or the device answering available:false) was
 * counted as approval. A seal is a payment and a legal act: never a silent pass. 'unavailable' falls back to the
 * wallet password, exactly as siteGate does; 'cancelled' refuses.
 */
export const approveSealPayment = async (
  reason: string,
  host: string,
  deps: {
    auth: (reason: string, host: string) => Promise<AuthResult>;
    passwordAuth: (reason: string, host: string) => Promise<boolean>;
  },
): Promise<boolean> => (await approveSealPaymentResult(reason, host, deps)) === 'ok';

/**
 * approveSealPayment, saying WHICH prompt did not complete (owner, 23 Nov 2026: the page words it honestly, "Face ID
 * didn't complete. Nothing was paid.", and keeps the drawing for Try again). A prompt that throws is a failure, never a
 * pass.
 */
export const approveSealPaymentResult = async (
  reason: string,
  host: string,
  deps: {
    auth: (reason: string, host: string) => Promise<AuthResult>;
    passwordAuth: (reason: string, host: string) => Promise<boolean>;
  },
): Promise<'ok' | 'device_auth_failed' | 'password_failed'> => {
  let r: AuthResult;
  try {
    r = await deps.auth(reason, host);
  } catch {
    return 'device_auth_failed';
  }
  if (r.status === 'ok') return 'ok';
  if (r.status === 'unavailable') {
    const ok = await deps.passwordAuth(reason, host).catch(() => false);
    return ok === true ? 'ok' : 'password_failed';
  }
  return 'device_auth_failed';
};

/**
 * The whole seal approval (owner, 3 Nov 2026): EVERY time, the wallet's payment approval sheet (SealPaySheet.tsx:
 * amount, "Seal <title> on Bitcoin", the room, the document hash), and only after its Approve, Face ID / passcode
 * (or the wallet password) through approveSealPayment. Takes no spending limit, allowance, one-click setting or
 * remembered grant: there is nothing here that could skip the sheet. Cancel on the sheet → false, no prompt asked.
 */
export const approveSealWithSheet = async <T>(
  sheet: T,
  deps: {
    /** Shows the sheet; resolves true on Approve, false on Cancel / ✕. */
    showSheet: (sheet: T) => Promise<boolean>;
    /** approveSealPayment with the phone's prompt and password fallback. */
    confirm: () => Promise<boolean>;
  },
): Promise<boolean> => {
  if (!(await deps.showSheet(sheet))) return false;
  return (await deps.confirm()) === true;
};

/**
 * approveSealWithSheet with the reason it did not approve: 'declined' (Cancel on the sheet, no prompt asked), or which
 * prompt did not complete. Same rule: the sheet first, every time, and only its Approve asks the prompt.
 */
export const approveSealWithSheetOutcome = async <T>(
  sheet: T,
  deps: {
    showSheet: (sheet: T) => Promise<boolean>;
    confirm: () => Promise<'ok' | 'device_auth_failed' | 'password_failed'>;
  },
): Promise<'approved' | 'declined' | 'device_auth_failed' | 'password_failed'> => {
  if (!(await deps.showSheet(sheet))) return 'declined';
  const r = await deps.confirm().catch(() => 'device_auth_failed' as const);
  // Only an exact 'ok' approves; anything else is a prompt that did not complete.
  return r === 'ok' ? 'approved' : r === 'password_failed' ? 'password_failed' : 'device_auth_failed';
};
