import { sendMessageAsync } from './chromeHelpers';
import { YoursEventName } from '../inject';
import { publishPendingSats } from './pendingBalance';
import { publishBalanceRead } from './balanceReads';

export { cachedExchangeRate, fetchExchangeRate, isExchangeRateStale, lastKnownExchangeRate } from './exchangeRate';

export async function getWalletBalance(): Promise<number> {
  // When the read began: the live balance only counts spends announced before it as included (utils/balanceReads.ts).
  const startedAt = Date.now();
  const response = await sendMessageAsync<{
    success: boolean;
    data?: number;
    pending?: number;
    error?: string;
    account?: string;
  }>({
    action: YoursEventName.GET_BALANCE,
  });
  if (!response.success) {
    throw new Error(response.error || 'Failed to get balance');
  }
  // The part not yet in a block, for the Wallet card's "pending" line (utils/pendingBalance.ts).
  publishPendingSats(response.pending);
  publishBalanceRead({
    sats: response.data ?? 0,
    startedAt,
    ...(typeof response.account === 'string' ? { account: response.account } : {}),
  });
  return response.data ?? 0;
}
