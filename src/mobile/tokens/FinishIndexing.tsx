import { Sparkles } from 'lucide-react';
import { money } from '../money/money';
import { dismissRoomSetup } from './roomSetup';
import { useRoomSetup } from './useRoomSetup';

/**
 * "Set up $X's room": for a token this wallet minted whose room isn't set up yet (1Sat indexing
 * unfunded). Minting no longer pays this; the card offers it, with "Not now" to hide it for that
 * token (Settings › My tokens and Chat still offer it). Price and payment: useRoomSetup /
 * roomSetup.ts. Nothing is sent without a tap; nothing shows while the indexer doesn't answer.
 */
export const FinishIndexing = ({
  tokenId,
  ticker,
  onFunded,
  compact = false,
  exchangeRate = 0,
  dismissible = true,
}: {
  tokenId: string;
  ticker: string;
  onFunded?: () => void;
  compact?: boolean;
  /** USD per BSV; 0 = use the live rate (unknown = no bCorp fee, always confirm). */
  exchangeRate?: number;
  dismissible?: boolean;
}) => {
  const s = useRoomSetup(tokenId, ticker, { exchangeRate, onDone: onFunded });
  // Unknown (indexer slow or hasn't seen the token): say nothing rather than ask for money.
  if (!s.status || !s.total || (!s.needs && !s.msg)) return null;

  return (
    <div
      className={`flex flex-col gap-2 rounded-2xl ${compact ? 'px-3 py-2.5' : 'px-4 py-3'}`}
      style={{ background: '#17191E', border: '1px solid #3a2f0c' }}
    >
      <div className="flex items-center gap-2">
        <Sparkles size={15} color="#FFD24D" />
        <span className="text-sm font-bold" style={{ color: '#FFD24D' }}>
          Set up ${ticker}'s room
        </span>
      </div>
      <p className="text-[11px] m-0" style={{ color: '#98A2B3' }}>
        Setting up lists ${ticker} in other wallets and the Market and opens its chat room. One payment of about{' '}
        {money(s.total.totalSats, s.rate)}, most of which is a prepaid deposit with
        the 1Sat indexer, not a fee: it stays as ${ticker}'s balance there and pays for its transfers.
      </p>
      {s.needs ? (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={s.busy}
            onClick={s.start}
            className="flex-1 h-10 rounded-xl text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
            style={{ background: '#FFD24D', color: '#000' }}
          >
            {`Set up · ${money(s.total.totalSats, s.rate)}`}
          </button>
          {dismissible && (
            <button
              type="button"
              disabled={s.busy}
              onClick={() => dismissRoomSetup(tokenId)}
              className="h-10 px-4 rounded-xl text-sm font-semibold bg-transparent cursor-pointer disabled:opacity-40"
              style={{ color: '#98A2B3', border: '1px solid #2a2d35' }}
            >
              Not now
            </button>
          )}
        </div>
      ) : null}
      {s.msg && (
        <p className="text-[11px] m-0" style={{ color: '#98A2B3' }}>
          {s.msg}
        </p>
      )}
      {s.sheet}
    </div>
  );
};
