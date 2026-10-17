import { useCallback, useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isNotConfigured, ownedThemes } from '../themeOrder/api';

const f: typeof fetch = (u, i) => fetch(u, i);

/** Which store themes this account owns, and whether buying is open on the server. */
export function useOwnedThemes() {
  const { apiContext } = useServiceContext();
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<boolean | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await ownedThemes(f, apiContext.wallet);
      setOwned(new Set(r.packs));
      setOpen(r.configured);
    } catch (e) {
      setOpen(isNotConfigured(e) ? false : null);
    }
  }, [apiContext.wallet]);
  useEffect(() => {
    void load();
  }, [load]);
  return { owned, open, add: (id: string) => setOwned((s) => new Set(s).add(id)) };
}
