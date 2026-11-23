import { sendMessageAsync } from './chromeHelpers';
import { YoursEventName } from '../inject';
import { publishPendingSats } from './pendingBalance';
import { nextReadSeq, publishBalanceRead, type BalanceRead } from './balanceReads';

export { cachedExchangeRate, fetchExchangeRate, isExchangeRateStale, lastKnownExchangeRate } from './exchangeRate';

/**
 * One balance read: the number, when the read began, whose it is, and whether it came back stale (it began before a
 * read already published for that account, so a newer number is on screen: utils/balanceReads.ts). A stale read is
 * published nowhere and must not be shown.
 */
export async function readWalletBalance(): Promise<BalanceRead & { stale: boolean }> {
  // When the read began: the live balance only counts spends announced before it as included (utils/balanceReads.ts).
  const startedAt = Date.now();
  // Its place in start order: reads are ordered by this, never by the clock (utils/balanceReads.ts nextReadSeq).
  const seq = nextReadSeq();
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
  const read: BalanceRead = {
    sats: response.data ?? 0,
    startedAt,
    seq,
    ...(typeof response.account === 'string' ? { account: response.account } : {}),
  };
  const stale = !publishBalanceRead(read);
  // The part not yet in a block, for the Wallet card's "pending" line (utils/pendingBalance.ts).
  if (!stale) publishPendingSats(response.pending);
  return { ...read, stale };
}

/** The balance in sats (sites and screens that only need the number). */
export async function getWalletBalance(): Promise<number> {
  return (await readWalletBalance()).sats;
}
