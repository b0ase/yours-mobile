import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { cachedExchangeRate, fetchExchangeRate, getWalletBalance } from '../../utils/wallet';
import { BALANCE_TIMEOUT_MS, loadLastBalance, saveLastBalance } from '../wallet/balanceLoad';
import { withTimeout } from '../withTimeout';
import { money } from '../money/money';
import { SendReceiveButtons } from './SendReceiveSheet';
import type { WalletAction } from './walletAction';

/**
 * HOME (docs/PHONE-LAYOUT-PLAN.md §4). Always the balance and Send/Receive at the top, so they are one tap from HOME
 * even with an empty dock (the safeguard). Below: the Apps › Home favourites, same storage and arrange mode.
 */
export const HomeHeader = ({ onAction }: { onAction: (a: WalletAction) => void }) => {
  const { chromeStorageService, apiContext } = useServiceContext();
  const identity = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress;
  const [sats, setSats] = useState<number | null>(() => loadLastBalance(identity));
  const [rate, setRate] = useState(cachedExchangeRate);
  useEffect(() => {
    let live = true;
    withTimeout(getWalletBalance(), BALANCE_TIMEOUT_MS, 'Balance')
      .then((s) => {
        if (!live) return;
        setSats(s);
        saveLastBalance(identity, s);
      })
      .catch(() => undefined);
    if (apiContext)
      fetchExchangeRate(apiContext.chain, apiContext.wocApiKey)
        .then((r) => live && r > 0 && setRate(r))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [identity, apiContext]);
  const bsv = sats == null ? '—' : (sats / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });
  return (
    <div className="flex flex-col gap-3" data-testid="home-header">
      <div
        className="rounded-3xl px-5 py-4 flex flex-col gap-0.5"
        style={{ background: 'linear-gradient(135deg, #2a2205, #120f02)', border: '1px solid #FFD24D44' }}
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#FFD24D]">Balance</span>
        <span className="text-3xl font-bold text-white">
          {sats == null ? '—' : rate > 0 ? money(sats, rate) : `${bsv} BSV`}
        </span>
        {sats != null && rate > 0 && <span className="text-xs text-[#98A2B3]">{bsv} BSV</span>}
      </div>
      <div className="flex gap-3">
        <SendReceiveButtons onPick={onAction} />
      </div>
    </div>
  );
};
