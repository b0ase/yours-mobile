import { sendMessageAsync } from './chromeHelpers';
import { YoursEventName } from '../inject';
import { publishPendingSats } from './pendingBalance';

export { cachedExchangeRate, fetchExchangeRate, isExchangeRateStale, lastKnownExchangeRate } from './exchangeRate';

export async function getWalletBalance(): Promise<number> {
  const response = await sendMessageAsync<{ success: boolean; data?: number; pending?: number; error?: string }>({
    action: YoursEventName.GET_BALANCE,
  });
  if (!response.success) {
    throw new Error(response.error || 'Failed to get balance');
  }
  // The part not yet in a block, for the Wallet card's "pending" line (utils/pendingBalance.ts).
  publishPendingSats(response.pending);
  return response.data ?? 0;
}
