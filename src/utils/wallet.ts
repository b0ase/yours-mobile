import { sendMessageAsync } from './chromeHelpers';
import { YoursEventName } from '../inject';

export { cachedExchangeRate, fetchExchangeRate, isExchangeRateStale, lastKnownExchangeRate } from './exchangeRate';

export async function getWalletBalance(): Promise<number> {
  const response = await sendMessageAsync<{ success: boolean; data?: number; error?: string }>({
    action: YoursEventName.GET_BALANCE,
  });
  if (!response.success) {
    throw new Error(response.error || 'Failed to get balance');
  }
  return response.data ?? 0;
}
