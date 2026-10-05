import { DEFAULT_RELAYX_ORD_PATH, DEFAULT_TWETCH_WALLET_PATH } from '../../utils/constants';
import { SupportedWalletImports } from '../../services/types/keys.types';
import { getKeys } from '../../utils/keys';
import { BWALLET_PAYMAIL_DOMAIN } from '../names/config';
import { CAP, fill, getCapabilities } from '../names/names';
import { socialProfile } from './socialLogin';

/** The identity key registered for name@<our domain>, or '' when the name is free (public lookup). */
export const registeredIdentityKey = async (alias: string): Promise<string> => {
  if (!alias || !BWALLET_PAYMAIL_DOMAIN) return '';
  const f = (u: string, i?: RequestInit) => fetch(u, i);
  const pki = (await getCapabilities(f, BWALLET_PAYMAIL_DOMAIN))[CAP.pki];
  if (typeof pki !== 'string') return '';
  const r = await f(fill(pki, alias, BWALLET_PAYMAIL_DOMAIN));
  if (r.status === 404) return '';
  if (!r.ok) throw new Error(`Couldn't check who owns ${alias} (${r.status}). Try again.`);
  const pubkey = ((await r.json()) as { pubkey?: string }).pubkey;
  return typeof pubkey === 'string' ? pubkey.toLowerCase() : '';
};

/**
 * Restore with Continue with X / Google: refuse a recovery phrase that isn't the wallet already holding the
 * verified name, so a different wallet never ends up labelled with it (owner, 6 Oct 2026).
 * The phrase is only derived here, on the phone: nothing of it is sent, logged or stored. The single network
 * call is the public name lookup above. Returns an error to show, or '' to go on.
 */
export const checkRestoreMatchesName = async (
  mnemonic: string,
  walletDerivation: string | null,
  ordDerivation: string | null,
  identityDerivation: string | null,
  importWallet?: SupportedWalletImports,
): Promise<string> => {
  const alias = socialProfile()?.alias;
  if (!alias) return '';
  const registered = await registeredIdentityKey(alias);
  if (!registered) return '';
  // Same paths generateSeedAndStoreEncrypted uses for this import.
  if (importWallet === 'relayx') ordDerivation = DEFAULT_RELAYX_ORD_PATH;
  if (importWallet === 'twetch') walletDerivation = DEFAULT_TWETCH_WALLET_PATH;
  const mine = getKeys(mnemonic, walletDerivation, ordDerivation, identityDerivation).identityPubKey.toLowerCase();
  return mine === registered
    ? ''
    : `These 12 words aren't the wallet that owns ${alias}. Check the words, or tap Remove on the X / Google card to restore without the name.`;
};
