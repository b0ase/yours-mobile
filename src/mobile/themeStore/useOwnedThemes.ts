import { useCallback, useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { THEME_STORE_PAID_ENABLED } from '../storeBuild';

const f: typeof fetch = (u, i) => fetch(u, i);

/** Which store themes this account owns, and whether buying is open on the server. */
export function useOwnedThemes() {
  const { apiContext } = useServiceContext();
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<boolean | null>(null);
  const load = useCallback(async () => {
    // Store builds sell nothing: no purchase code in their bundle (the inlined flag drops this import).
    if (!THEME_STORE_PAID_ENABLED) return;
    const { isNotConfigured, ownedThemes } = await import('../themeOrder/api');
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
