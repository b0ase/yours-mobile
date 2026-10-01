import { useCallback, useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import type { InvestorCert, KycSummary } from './kyc';
import { identityKeyOf, loadInvestorCert, onKycChange, readKyc } from './kycWallet';

/** Current verification + investor qualification for the wallet's identity key. */
export const useKyc = () => {
  const { apiContext } = useServiceContext();
  const [identityKey, setIdentityKey] = useState('');
  const [kyc, setKyc] = useState<KycSummary | null>(null);
  const [investor, setInvestor] = useState<InvestorCert | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!apiContext) return;
    try {
      const key = await identityKeyOf(apiContext);
      setIdentityKey(key);
      setInvestor(loadInvestorCert(key));
      setKyc(await readKyc(apiContext));
    } catch (e) {
      console.warn('[kyc] status read failed:', e);
    } finally {
      setLoading(false);
    }
  }, [apiContext]);

  useEffect(() => {
    void refresh();
    return onKycChange(() => void refresh());
  }, [refresh]);

  return { identityKey, kyc, investor, loading, refresh };
};
