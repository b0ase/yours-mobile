import { useServiceContext } from '../../hooks/useServiceContext';
import { isAgentAccount } from '../agents/agentAccounts';
import { accountNamesFor } from '../names/accountNames';
import { saveSession } from '../chat/api';
import { signOutAndLock, splitAccounts, type MenuAccount } from './accountMenu';

type StoredAccount = ReturnType<ReturnType<typeof useServiceContext>['chromeStorageService']['getAllAccounts']>[number];
export type MenuEntry = MenuAccount & { account: StoredAccount };

/** Every stored account with its searchable names, split into people and agents (agents never in the switcher). */
export const useMenuAccounts = () => {
  const { chromeStorageService } = useServiceContext();
  const all: MenuEntry[] = chromeStorageService.getAllAccounts().map((account) => {
    const id = account.addresses.identityAddress;
    const n = accountNamesFor(id, account.name, account.settings?.socialProfile?.displayName ?? '');
    return { id, name: n.displayName || n.label, handle: n.handle, paymail: n.paymail, account };
  });
  return splitAccounts(all, isAgentAccount);
};

/** Sign out = sign this account out of chat (only this account), then lock the wallet. */
export const useSignOut = () => {
  const { lockWallet } = useServiceContext();
  return (current?: string) => signOutAndLock(current, { saveSession, lockWallet });
};
