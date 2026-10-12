import { useCallback, useEffect, useState } from 'react';
import type { Beef, WalletInterface } from '@bsv/sdk';
import { useServiceContext } from '../../hooks/useServiceContext';
import { fetchConfig, fetchRound, listCoins, listVaults, type PneeCoin, type PneeConfig, type Vault } from './vaults';
import type { PriceRound } from './oracle';

/** The wallet, its identity key, its vaults and PNEE coins, and the signers' config. */
export function usePnee() {
  const { apiContext, chromeStorageService } = useServiceContext();
  const wallet = (apiContext as { wallet?: WalletInterface } | undefined)?.wallet;
  const identity = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey ?? '';
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [vaultBeef, setVaultBeef] = useState<Beef | null>(null);
  const [coins, setCoins] = useState<PneeCoin[]>([]);
  const [coinBeef, setCoinBeef] = useState<Beef | null>(null);
  const [cfg, setCfg] = useState<PneeConfig | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!wallet) return;
    try {
      const [v, c] = await Promise.all([listVaults(wallet), listCoins(wallet)]);
      setVaults(v.vaults);
      setVaultBeef(v.beef);
      setCoins(c.coins);
      setCoinBeef(c.beef);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [wallet]);

  useEffect(() => {
    void refresh();
    void fetchConfig()
      .then(setCfg)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [refresh]);

  /** A fresh, checked price round (asked for right before each mint or lock). */
  const round = useCallback(async (): Promise<PriceRound> => {
    const c = cfg ?? (await fetchConfig());
    if (!cfg) setCfg(c);
    return fetchRound(c);
  }, [cfg]);

  return { wallet, identity, vaults, vaultBeef, coins, coinBeef, cfg, error, refresh, round };
}
