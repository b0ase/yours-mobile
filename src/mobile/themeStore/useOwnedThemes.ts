import { useCallback, useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { THEME_STORE_PAID_ENABLED } from '../storeBuild';
import { ownedAcrossWallet, recalledOwned, rememberOwned, type WalletAccount } from './ownedAcross';

const f: typeof fetch = (u, i) => fetch(u, i);

/**
 * Which store themes this wallet owns, and whether buying is open on the server. `owned` covers every account in the
 * wallet (ownedAcross.ts); `boughtOn` says where each was bought (null = the open account).
 */
export function useOwnedThemes() {
  const { apiContext, chromeStorageService } = useServiceContext();
  const accounts: WalletAccount[] = chromeStorageService.getAllAccounts().map((a) => ({
    identityKey: a.pubKeys?.identityPubKey ?? '',
    name: a.name ?? '',
  }));
  const current = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey ?? '';
  const [mine, setMine] = useState<string[]>(() => (THEME_STORE_PAID_ENABLED ? recalledOwned(current) : []));
  const [open, setOpen] = useState<boolean | null>(null);
  const load = useCallback(async () => {
    // Store builds sell nothing: no purchase code in their bundle (the inlined flag drops this import).
    if (!THEME_STORE_PAID_ENABLED) return;
    const { isNotConfigured, ownedThemes } = await import('../themeOrder/api');
    try {
      const r = await ownedThemes(f, apiContext.wallet);
      rememberOwned(current, r.packs);
      setMine(r.packs);
      setOpen(r.configured);
    } catch (e) {
      setOpen(isNotConfigured(e) ? false : null);
    }
  }, [apiContext.wallet, current]);
  useEffect(() => {
    if (THEME_STORE_PAID_ENABLED) setMine(recalledOwned(current));
    void load();
  }, [load, current]);
  const boughtOn = THEME_STORE_PAID_ENABLED
    ? ownedAcrossWallet(current, mine, accounts)
    : new Map<string, string | null>();
  const owned = new Set(boughtOn.keys());
  return {
    owned,
    boughtOn,
    open,
    add: (id: string) =>
      setMine((s) => {
        const next = [...new Set([...s, id])];
        if (THEME_STORE_PAID_ENABLED) rememberOwned(current, next);
        return next;
      }),
  };
}
