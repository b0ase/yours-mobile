import { Sparkles } from 'lucide-react';
import { money } from '../money/money';
import { indexingEnabled } from '../storeBuild';
import { holderIndexState } from './indexFund';
import { useRoomSetup } from './useRoomSetup';

/**
 * Token detail screen: "Index $X" for ANY holder when the 1Sat overlay says the token needs funding
 * (inactive, or its fee balance can't pay one more output). Anyone may pay a token's fee address, so
 * this is not issuer-only. Reuses the room-setup flow (useRoomSetup: price, confirm sheet, one tx).
 * Indexed: a small "Indexed" note. Indexer silent: nothing. Hidden where indexingEnabled() is off.
 */
export const TokenIndexButton = (props: { tokenId: string; ticker: string; exchangeRate?: number }) =>
  indexingEnabled() ? <Inner {...props} /> : null;

const Inner = ({ tokenId, ticker, exchangeRate = 0 }: { tokenId: string; ticker: string; exchangeRate?: number }) => {
  const s = useRoomSetup(tokenId, ticker, { exchangeRate });
  const state = holderIndexState(s.status);
  if (state === 'unknown') return null;
  if (state === 'indexed' && !s.msg) {
    return (
      <p className="mx-4 mb-3 text-[11px] m-0" style={{ color: '#98A2B3' }}>
        Indexed by 1Sat
      </p>
    );
  }
  if (!s.total) return null;
  return (
    <div
      className="mx-4 mb-4 flex flex-col gap-2 rounded-2xl px-4 py-3"
      style={{ background: '#17191E', border: '1px solid #3a2f0c' }}
    >
      <p className="text-[11px] m-0" style={{ color: '#98A2B3' }}>
        The 1Sat indexer has stopped validating ${ticker} until its fee balance is topped up, so it can't be
        listed or sent as verified. Paying {money(s.total.totalSats, s.rate)} funds it for every holder.
      </p>
      {s.needs && (
        <button
          type="button"
          disabled={s.busy}
          onClick={s.start}
          className="h-10 rounded-xl text-sm font-bold border-0 cursor-pointer disabled:opacity-40 flex items-center justify-center gap-2"
          style={{ background: '#FFD24D', color: '#000' }}
        >
          <Sparkles size={15} />
          {`Index $${ticker} · ${money(s.total.totalSats, s.rate)} (${s.total.totalSats.toLocaleString()} sats)`}
        </button>
      )}
      {s.msg && (
        <p className="text-[11px] m-0" style={{ color: '#98A2B3' }}>
          {s.msg}
        </p>
      )}
      {s.sheet}
    </div>
  );
};
