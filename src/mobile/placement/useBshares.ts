import { useCallback, useEffect, useMemo, useState } from 'react';
import { defaultHttp, loadSession } from '../chat/api';
import { isNative } from '../native';
import { BsharesApi } from './api';
import type { BsharesMe } from './placement';

/** Loads the viewer's bShares standing from bit-sign's register. `me` is null when signed out or not a member. */
export function useBshares() {
  const api = useMemo(() => new BsharesApi(defaultHttp(isNative), loadSession()), []);
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
      setError(e instanceof Error ? e.message : 'Could not reach the register');
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { api, me, loading, error, reload };
}
