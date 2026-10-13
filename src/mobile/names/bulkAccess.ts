import { isAgentAccount } from '../agents/agentAccounts';
import { getPaymail } from './accountName';
import { BWALLET_PAYMAIL_DOMAIN } from './config';

/**
 * Who sees the bulk OpNS minter (bMint › Mint names, /m/bmint/opns). Owner, 14 Oct 2026: it is the maker's tool,
 * and it shows what a name costs to mine, so it is hidden from everyone else and the Name Store shows one price
 * for everyone. Open for agent accounts (the headless minters are driven from them), for the bMint studio owner
 * (VITE_BMINT_STUDIO_KEYS) and for the owner's own handle.
 */
export const BULK_MINT_HANDLES: readonly string[] = ['b0asex'];

/** "$b0asex", "b0asex" or "b0asex@<our paymail domain>" → true; any other name or domain → false. */
export const paymailAllowsBulkMint = (paymail: string, handles: readonly string[] = BULK_MINT_HANDLES): boolean => {
  const [alias, domain] = paymail.trim().toLowerCase().replace(/^\$/, '').split('@');
  if (!alias || !handles.includes(alias)) return false;
  return !domain || domain === BWALLET_PAYMAIL_DOMAIN.toLowerCase();
};

export const canBulkMint = (identityAddress?: string | null, studioOwner = false): boolean =>
  studioOwner || isAgentAccount(identityAddress) || paymailAllowsBulkMint(getPaymail(identityAddress ?? undefined));
