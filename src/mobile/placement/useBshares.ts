import { useCallback, useEffect, useMemo, useState } from 'react';
import { defaultHttp, loadSession } from '../chat/api';
import { isNative } from '../native';
import { BsharesApi } from './api';
import type { BsharesMe } from './placement';
import type { CompanyListing } from './company';

/** Loads the viewer's bShares standing from bit-sign's register. `me` is null when signed out or not a member. */
export function useBshares(company?: string) {
  const api = useMemo(() => new BsharesApi(defaultHttp(isNative), loadSession(), company), [company]);
  const [me, setMe] = useState<BsharesMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setMe(await api.me());
      setError(null);
    } catch (e) {
      setMe(null);
      setError(e instanceof Error ? e.message : 'Could not load share registers');
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { api, me, loading, error, reload };
}

/** Every company the viewer is a director of or holds shares in (bShares company switcher). */
export function useCompanies() {
  const api = useMemo(() => new BsharesApi(defaultHttp(isNative), loadSession()), []);
  const [companies, setCompanies] = useState<CompanyListing[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setCompanies((await api.companies()).companies);
    } catch {
      setCompanies([]);
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { api, companies, loading, reload };
}
