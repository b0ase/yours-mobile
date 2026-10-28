import type { WalletName } from '../names/paymail';

/** Where a linked (proven) name comes from, for "Unlink from X". */
export const PROVIDER: Record<WalletName['kind'], string> = { plain: '', x: 'X', gmail: 'Google' };

/**
 * What each row's menu offers, and what it really does on the server (site/lib/paymail.js):
 * - Set as main: `names-primary`. Plain names only; the main name is what payments and your card show.
 * - Remove: `names-remove`. Plain, non-main names only; payments forward to the main name for 90 days, then the
 *   name is released (bit-sign holds it 90 days too). The server refuses it for the main name.
 * - Unlink: `unlink`. Linked names (.x / .gmail) only; deleted at once, no forwarding, anyone can claim it.
 */
export type NameAction = 'main' | 'remove' | 'unlink';
export function nameActions(n: WalletName): NameAction[] {
  if (n.kind !== 'plain') return ['unlink'];
  return n.main ? [] : ['main', 'remove'];
}
export function actionText(a: NameAction, n: WalletName): { label: string; hint: string } {
  if (a === 'main') return { label: 'Set as main', hint: 'Payments and your card show this name. Once every 30 days.' };
  if (a === 'remove')
    return {
      label: 'Remove this name',
      hint: 'You stop receiving at it. Payments forward to your main name for 90 days.',
    };
  return {
    label: `Unlink from ${PROVIDER[n.kind] || 'account'}`,
    hint: 'Stops receiving now, with no forwarding. Anyone can claim it.',
  };
}
export function confirmText(a: 'remove' | 'unlink', n: WalletName, others: number): string {
  if (a === 'remove')
    return `${n.paymail} stops receiving. Payments to it go to your main name for 90 days, then the name is released. Its payment history stays in your wallet.`;
  return `${n.paymail} stops receiving straight away and anyone can claim it.${
    n.main && others ? ' Your next name becomes the main one.' : ''
  } Tokens you already made are not affected.`;
}
