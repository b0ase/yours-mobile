import * as bip39 from 'bip39';
import { AccountExistsError } from '../../services/accountErrors';
import { APP_NAME } from '../../mobile/storeBuild';

/**
 * Add account › Restore (owner, 10 Oct 2026). Importing a Twetch phrase "wouldn't take" either a new
 * password or the wallet password: the phrase was never checked until AFTER the password step, and any
 * failure there (a pasted phrase with a line break, capitals or numbering fails bip39's strict check)
 * was reported as "make sure your password is correct". These helpers clean the phrase, check it
 * before the password step, and say which thing actually went wrong.
 */

const WORD_COUNTS = [12, 15, 18, 21, 24];

/** Lower-case, drop numbering ("1." "2)"), commas and extra whitespace: "1. Apple\n2. Banana" → "apple banana". */
export const normalizePhrase = (raw: string): string =>
  String(raw || '')
    .toLowerCase()
    .replace(/[,;]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^\d+[.)]?$/, '').replace(/^\d+[.)]/, ''))
    .filter(Boolean)
    .join(' ');

/** Null when the phrase is usable, else what to tell the person. */
export const phraseProblem = (raw: string): string | null => {
  const phrase = normalizePhrase(raw);
  if (!phrase) return 'Enter your recovery words.';
  const n = phrase.split(' ').length;
  if (!WORD_COUNTS.includes(n)) return `Recovery phrases have 12 or 24 words. This one has ${n}.`;
  if (!bip39.validateMnemonic(phrase)) return "Those words aren't a valid recovery phrase. Check the spelling and order.";
  return null;
};

export { AccountExistsError };

/** What went wrong while adding the account, in words the person can act on. */
export const restoreErrorMessage = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (err instanceof AccountExistsError || /already added/i.test(msg)) return 'That account is already in bWalletX.';
  // Same words the phone/extension builds already showed (mobile/onboardingError.ts): accurate, so kept.
  if (/unauthori[sz]ed/i.test(msg)) return `Wrong password: use the password you unlock ${APP_NAME} with (one for all accounts).`;
  if (/invalid mnemonic/i.test(msg)) return "Those words aren't a valid recovery phrase. Check the spelling and order.";
  if (/usb/i.test(msg)) return 'Plug in your USB security key, then try again.';
  return msg ? `Couldn't restore the account: ${msg}` : "Couldn't restore the account.";
};
