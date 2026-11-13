import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { RISK_LINE } from '../feed/reels/bexCards';
import { TokenAudit } from './TokenAudit';
import { TokenFacts } from './TokenFacts';
import type { Trade } from './exchangeData';

/**
 * A token page's Details (owner, 13 Nov 2026): the facts the Exchange cards used to carry (fair-launch score,
 * verified badges, deployer, age, market cap, supply, burned, 24h change), plus holders, recent trades and the
 * info & audit block (TokenAudit), and the launch curve / holders / room block (TokenFacts). TokenFacts used to
 * sit open above the listings and grew as its curve and top holders loaded, pushing the page down ("when you
 * open a token page it's unstable"); inside Details it no longer moves anything. Collapsed by default so the page leads with what you can buy; nothing is
 * loaded for it until it is opened. The risk line always shows.
 */
const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';

export const TokenDetails = ({
  tokenId,
  sym,
  rate,
  trades,
  facts,
  audit = true,
  defaultOpen = false,
}: {
  tokenId: string;
  sym: string;
  rate: number;
  /** The trade screen's trades; omitted: TokenAudit reads them (same cache). */
  trades?: Trade[];
  /** Launch curve, price vs floor, holders and the room (TokenFacts); omitted: not shown. */
  facts?: { dec?: number; priceSats: number | null; held?: bigint | null };
  /** Show the score / supply / trades / audit blocks (TokenAudit); off for personal tokens. */
  audit?: boolean;
  defaultOpen?: boolean;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const panel = useId();
  return (
    <section className="flex flex-col gap-3" aria-label={`$${sym} details`}>
      <p className="text-[11px] m-0" style={{ color: MUTED }} data-testid="risk-line">
        {RISK_LINE}
      </p>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between gap-2 w-full min-h-[44px] px-4 rounded-2xl text-sm font-extrabold bg-[var(--bw-surface)] border border-[#2b2f36] cursor-pointer text-white"
      >
        <span>Details</span>
        <span className="flex items-center gap-1 text-xs font-bold" style={{ color: GOLD }}>
          {open ? 'Hide' : 'Score, supply, holders, trades'}
          <ChevronDown
            size={16}
            style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}
            aria-hidden
          />
        </span>
      </button>
      <div id={panel} hidden={!open} className={open ? 'flex flex-col gap-3' : 'hidden'}>
        {open && facts && (
          <TokenFacts
            tokenId={tokenId}
            sym={sym}
            dec={facts.dec}
            rate={rate}
            priceSats={facts.priceSats}
            held={facts.held}
          />
        )}
        {open && audit && <TokenAudit tokenId={tokenId} sym={sym} rate={rate} trades={trades} />}
      </div>
    </section>
  );
};
