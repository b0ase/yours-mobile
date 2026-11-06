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
): Promise<boolean> => {
  const r = await deps.auth(reason, host);
  if (r.status === 'ok') return true;
  if (r.status === 'unavailable') return deps.passwordAuth(reason, host);
  return false;
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
