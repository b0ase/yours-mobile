/**
 * Recipient wording for the Send screens (owner, 16 Oct 2026). The payee is always the real
 * recipient: never a bare "bWalletX" (it read like a payment to us). A paymail is shown in full so
 * the user can check it; a long address is shortened by the caller.
 */

/** Placeholder hint for the recipient box. */
export const recipientHint = (domain: string): string =>
  domain ? `$name, name@${domain}, paymail or address` : '$name, paymail or address';

/** Second line of the resolved card: "$mike · mike@bwalletx.com", or "$mike · 1Abc…xyz". */
export const payeeDetail = (input: string, to: string, short: (s: string) => string): string => {
  const shown = to.includes('@') ? to : short(to);
  return !input || input.toLowerCase() === to.toLowerCase() ? shown : `${input} · ${shown}`;
};
