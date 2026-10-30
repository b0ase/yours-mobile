import { Hash, Utils } from '@bsv/sdk';
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

const INVALID_PHRASE = "Those words aren't a valid recovery phrase. Check the spelling and order.";

/**
 * Lower-case, drop numbering ("1." "2)"), commas and extra whitespace: "1. Apple\n2. Banana" → "apple banana".
 * b_feedback #181 (29 Oct 2026, Android): phone keyboards and copy/paste also add things bip39's strict check
 * rejects even though the words are right, so these are cleaned too: Unicode compatibility forms (NFKD, so
 * full-width letters become plain ones), zero-width spaces/joiners and BOMs, non-breaking spaces, accents an
 * autocorrect added (no English BIP39 word has one), and punctuation stuck to a word ("zoo." "'abandon").
 * None of this can turn a wrong phrase into a valid one: the checksum is still checked on the cleaned words.
 */
export const normalizePhrase = (raw: string): string =>
  cleanWords(
    String(raw || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, ''),
  );

/** Same cleaning but accents kept: used only to recognise a non-English BIP39 phrase. */
const cleanWords = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '')
    .replace(/[,;]/g, ' ')
    .split(/\s+/)
    .map((w) =>
      w
        .replace(/^\d+[.)]?$/, '')
        .replace(/^\d+[.)]/, '')
        .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''),
    )
    .filter(Boolean)
    .join(' ');

const OTHER_WORDLISTS: [string, string][] = [
  ['spanish', 'Spanish'],
  ['french', 'French'],
  ['italian', 'Italian'],
  ['portuguese', 'Portuguese'],
  ['czech', 'Czech'],
  ['japanese', 'Japanese'],
  ['korean', 'Korean'],
  ['chinese_simplified', 'Chinese'],
  ['chinese_traditional', 'Chinese'],
];

/** The language of a valid non-English BIP39 phrase, else null. */
export const otherLanguageOf = (raw: string): string | null => {
  const words = cleanWords(String(raw || '').normalize('NFKD'));
  if (!words) return null;
  for (const [key, label] of OTHER_WORDLISTS) {
    const list = bip39.wordlists[key];
    if (list && bip39.validateMnemonic(words, list)) return label;
  }
  return null;
};

/**
 * True for an Electrum 2.0+ seed (Electrum, ElectrumSV): English-looking words, but no BIP39 checksum. Electrum marks
 * its seeds with a version prefix on HMAC-SHA512("Seed version", phrase) instead: "01" standard, "100" segwit,
 * "101" two-factor.
 */
export const looksLikeElectrum = (phrase: string): boolean => {
  const mac = Hash.sha512hmac(Utils.toArray('Seed version', 'utf8'), Utils.toArray(phrase, 'utf8'));
  const hex = Utils.toHex(mac);
  return hex.startsWith('01') || hex.startsWith('100') || hex.startsWith('101');
};

/** Null when the phrase is usable, else what to tell the person. */
export const phraseProblem = (raw: string): string | null => {
  const phrase = normalizePhrase(raw);
  if (!phrase) return 'Enter your recovery words.';
  const n = phrase.split(' ').length;
  const lang = otherLanguageOf(raw);
  if (lang)
    return `That looks like a ${lang} recovery phrase. ${APP_NAME} can only restore English phrases for now, so keep using the wallet it came from or move the funds to a new ${APP_NAME} address.`;
  if (!WORD_COUNTS.includes(n)) return `Recovery phrases have 12 or 24 words. This one has ${n}.`;
  if (bip39.validateMnemonic(phrase)) return null;
  const english = bip39.wordlists.english;
  const unknown = phrase.split(' ').filter((w) => !english.includes(w));
  if (unknown.length)
    return `${unknown.length === 1 ? "This word isn't" : "These words aren't"} in the recovery word list: ${unknown
      .slice(0, 3)
      .join(', ')}. Check the spelling.`;
  if (looksLikeElectrum(phrase))
    return `That looks like an Electrum or ElectrumSV seed, which ${APP_NAME} can't restore yet. Open it in ElectrumSV and send the funds to your ${APP_NAME} address.`;
  return INVALID_PHRASE;
};

export { AccountExistsError };

/** What went wrong while adding the account, in words the person can act on. */
export const restoreErrorMessage = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (err instanceof AccountExistsError || /already added/i.test(msg)) return 'That account is already in bWalletX.';
  // Same words the phone/extension builds already showed (mobile/onboardingError.ts): accurate, so kept.
  if (/unauthori[sz]ed/i.test(msg))
    return `Wrong password: use the password you unlock ${APP_NAME} with (one for all accounts).`;
  if (/invalid mnemonic/i.test(msg)) return INVALID_PHRASE;
  if (/usb/i.test(msg)) return 'Plug in your USB security key, then try again.';
  return msg ? `Couldn't restore the account: ${msg}` : "Couldn't restore the account.";
};
