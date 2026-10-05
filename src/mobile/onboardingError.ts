/**
 * Why creating / restoring / importing an account failed, in words (owner, 6 Oct 2026: upstream's
 * "Make sure your password is correct" showed for every failure, so a wrong password and a real fault looked alike).
 * Keys.service throws 'Unauthorized!' only when the password isn't the wallet's unlock password.
 */
export function onboardingError(action: string, error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  if (msg === 'Unauthorized!') return 'Wrong password: use the password you unlock bWalletX with (one for all accounts).';
  return `Couldn't ${action} the account${msg ? `: ${msg}` : '.'}`;
}
