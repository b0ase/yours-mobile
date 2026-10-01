import { bareName } from './names';

/**
 * Text for the account identity beside the Wallet balance (WalletIdentity). Pure.
 *  name — the account / profile name ('' when it just repeats the handle);
 *  tag  — "$testy" (paymail alias, else the OpNS name), '' when the account has no handle;
 *  full — "testy@bwallet.space" (the paymail in full; '' without one);
 *  copy — what a tap copies: the full paymail, else the OpNS name, else '' (tap = get a name).
 */
export function identityRowText(displayName: string, paymail: string, handle: string) {
  const alias = paymail ? bareName(paymail) : '';
  const short = alias && !alias.includes('@') ? alias : '';
  const tagBase = short || handle || '';
  const tag = tagBase ? `$${tagBase.replace(/^\$/, '')}` : '';
  const name = (displayName || '').trim();
  const sameAsHandle = !!tagBase && name.replace(/^\$/, '').toLowerCase() === tagBase.toLowerCase();
  return {
    name: sameAsHandle ? '' : name,
    tag,
    full: paymail || '',
    copy: paymail || handle || '',
  };
}
