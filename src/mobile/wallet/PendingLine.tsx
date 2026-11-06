import { formatUSD } from '../../utils/format';
import { cardSats, type CardUnit } from './walletCardText';

/**
 * "… pending" under the Wallet card's amount: money received and counted, not yet in a block (services/receiveWatch.ts,
 * owner 5 Nov 2026). Part of the balance, never more than it; hidden with the balance.
 */
export const PendingLine = ({
  sats,
  pending,
  unit,
  rate,
  hidden,
}: {
  /** The balance shown, in satoshis. */
  sats: number;
  /** GET_BALANCE's pending part (utils/pendingBalance.ts). */
  pending: number;
  unit: CardUnit;
  /** USD per BSV; 0 = not known yet (sats are shown). */
  rate: number;
  hidden: boolean;
}) => {
  const p = Math.min(Math.max(0, sats), Math.max(0, pending));
  if (hidden || !(p > 0)) return null;
  return (
    <span className="bw-wcard-pending" role="status">
      {unit === 'usd' && rate > 0 ? formatUSD((p * rate) / 100_000_000) : cardSats(p)} pending
    </span>
  );
};
