/**
 * Settings › Show my 12 words (owner, 19 Oct 2026: there was no way to SEE the recovery phrase).
 * Pure helpers so the gate and the clipboard clear can be tested without React.
 *
 * The words never go to a log, a URL, analytics or an error report: callers keep them in component state only,
 * and every error thrown here carries a fixed message, never the phrase.
 */

/** The phrase as numbered words. Extra spaces and line breaks are ignored. */
export const seedWords = (mnemonic: string | undefined): string[] =>
  (mnemonic ?? '').trim().split(/\s+/).filter(Boolean);

export type SeedRevealDeps = {
  verifyPassword: (password: string) => Promise<boolean>;
  /** Decrypts the current account's keys (the wallet is unlocked, so the session passKey is there). */
  readMnemonic: () => Promise<string | undefined>;
};

export class SeedRevealError extends Error {
  constructor(public readonly reason: 'wrong-password' | 'no-phrase' | 'failed') {
    super(
      reason === 'wrong-password'
        ? 'Wrong password'
        : reason === 'no-phrase'
          ? 'This account was imported from a private key, so it has no 12 words'
          : 'Could not read the recovery phrase',
    );
    this.name = 'SeedRevealError';
  }
}

/** Password gate, then the words. `verified` skips the password when biometrics already confirmed the user. */
export const revealSeed = async (
  deps: SeedRevealDeps,
  opts: { password?: string; verified?: boolean },
): Promise<string[]> => {
  if (!opts.verified) {
    if (!opts.password || !(await deps.verifyPassword(opts.password).catch(() => false))) {
      throw new SeedRevealError('wrong-password');
    }
  }
  let mnemonic: string | undefined;
  try {
    mnemonic = await deps.readMnemonic();
  } catch {
    throw new SeedRevealError('failed');
  }
  const words = seedWords(mnemonic);
  if (words.length < 12) throw new SeedRevealError('no-phrase');
  return words;
};

export type ClipboardLike = { writeText: (text: string) => Promise<void> };

export const CLIPBOARD_CLEAR_MS = 60_000;

/**
 * Copies `text` and empties the clipboard after `ms`. It does not read the clipboard first: reading asks for paste
 * permission on iOS and in browsers. Returns a cancel function.
 */
export const copyWithAutoClear = async (
  text: string,
  clipboard: ClipboardLike,
  ms = CLIPBOARD_CLEAR_MS,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
): Promise<() => void> => {
  await clipboard.writeText(text);
  const id = timers.set(async () => {
    try {
      await clipboard.writeText('');
    } catch {
      /* the page lost focus or permission: nothing more we can do */
    }
  }, ms);
  return () => timers.clear(id);
};
