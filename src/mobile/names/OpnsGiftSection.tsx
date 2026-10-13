import { useMemo, useState } from 'react';
import type { OneSatContext } from '@1sat/actions';
import { OpnsGiftPanel } from './OpnsGiftPanel';
import { withoutGifted } from './opnsGift';
import type { OwnedForSale } from './opnsSell';

/**
 * Store edition Owned names: Gift only. Sending a name is an NFT send, which the store edition allows; listing
 * for sale is the market, which it does not have (OpnsSellSection, bWalletX only).
 */
const GOLD = '#FFD24D';
const TEXT = '#f4f1e8';
const MUTED = 'rgba(244,241,232,0.58)';
const HAIR = 'rgba(255,255,255,0.08)';
const ghostBtn =
  'rounded-lg px-3 py-1.5 text-xs font-semibold cursor-pointer bg-transparent border-0 transition-colors duration-150 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 disabled:opacity-40 disabled:cursor-not-allowed';

export const OpnsGiftSection = (p: {
  ctx: OneSatContext | undefined;
  owned: OwnedForSale[];
  onChanged: () => void;
}) => {
  const [gifted, setGifted] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [gifting, setGifting] = useState<OwnedForSale[] | null>(null);
  const owned = useMemo(() => withoutGifted(p.owned, gifted), [p.owned, gifted]);
  const chosen = owned.filter((o) => picked.has(o.name));
  if (!owned.length && !gifting) return null;
  const toggle = (name: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  return (
    <section
      aria-labelledby="opns-owned"
      className="rounded-2xl p-4 sm:p-5 flex flex-col gap-3"
      style={{ background: 'rgba(12,12,14,0.92)', border: `1px solid ${HAIR}` }}
    >
      <header className="flex flex-col">
        <h2 id="opns-owned" className="m-0 text-[15px] font-semibold tracking-tight" style={{ color: TEXT }}>
          Owned names
        </h2>
        <span className="text-xs" style={{ color: MUTED }}>
          Tick names to gift. A gift is free; you pay only the network fee.
        </span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {owned.map((o) => (
          <li
            key={o.name}
            className="flex items-center justify-between gap-3 py-2 text-[13px]"
            style={{ borderTop: `1px solid ${HAIR}` }}
          >
            <label className="flex items-center gap-3 min-w-0 cursor-pointer">
              <input
                type="checkbox"
                checked={picked.has(o.name)}
                disabled={!!gifting}
                onChange={() => toggle(o.name)}
                className="w-4 h-4 shrink-0 accent-[#FFD24D] cursor-pointer disabled:cursor-not-allowed"
                aria-label={`Select ${o.name}`}
              />
              <span className="font-medium break-all" style={{ color: TEXT }}>
                {o.name}
              </span>
            </label>
            <button
              type="button"
              className={ghostBtn}
              style={{ color: GOLD, border: `1px solid ${HAIR}` }}
              disabled={!p.ctx || !!gifting}
              onClick={() => setGifting([o])}
              aria-label={`Gift ${o.name}`}
            >
              Gift
            </button>
          </li>
        ))}
      </ul>
      {gifting ? (
        <OpnsGiftPanel
          key={gifting.map((g) => g.name).join(',')}
          ctx={p.ctx}
          names={gifting}
          onGifted={(names) => {
            setGifted((g) => new Set([...g, ...names]));
            setPicked(new Set());
            p.onChanged();
          }}
          onClose={() => setGifting(null)}
        />
      ) : (
        <button
          type="button"
          className="rounded-xl font-semibold border-0 cursor-pointer w-full py-3 text-[14px] disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: GOLD, color: '#000' }}
          disabled={!p.ctx || !chosen.length}
          onClick={() => setGifting(chosen)}
        >
          {chosen.length > 1 ? `Gift ${chosen.length} selected` : 'Gift selected'}
        </button>
      )}
    </section>
  );
};
