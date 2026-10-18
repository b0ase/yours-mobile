import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { fetchHoldings, type Holding } from './holding';
import logo from './assets/npg-logo.png';

/**
 * "Your shareholding" (all builds, read-only). Renders only when a company returns this wallet's own register entry,
 * signed by its pinned key (holding.ts). No offers, prices, values, buy / transfer / register-interest controls.
 * Until a company key is pinned it makes no request and renders nothing.
 */
const n = (x: number) => x.toLocaleString('en-GB');

export const SharesCard = () => {
  const { apiContext } = useServiceContext();
  const [holdings, setHoldings] = useState<Holding[]>([]);
  useEffect(() => {
    let live = true;
    fetchHoldings(apiContext.wallet)
      .then((h) => live && setHoldings(h))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [apiContext]);
  if (!holdings.length) return null;
  return (
    <div className="bw-home-cell">
      {holdings.map((h) => (
        <HoldingCard key={h.company.number} h={h} />
      ))}
    </div>
  );
};

const Badge = ({ children }: { children: string }) => (
  <span
    className="text-[11px] font-bold px-2 py-1 rounded-full"
    style={{ background: 'rgba(255,46,136,0.14)', color: '#ff7ab6', border: '1px solid rgba(255,46,136,0.4)' }}
  >
    {children}
  </span>
);

const HoldingCard = ({ h }: { h: Holding }) => (
  <section
    aria-label="Your shareholding"
    className="rounded-2xl p-4 flex flex-col gap-3 text-white overflow-hidden"
    style={{ background: 'linear-gradient(160deg,#120a10,#07070a)', border: '1px solid #2a1220' }}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-xs uppercase tracking-wider" style={{ color: '#ff7ab6' }}>
          Your shareholding
        </span>
        <span className="text-4xl font-black leading-none">{n(h.holder.shares)}</span>
        <span className="text-xs" style={{ color: '#98A2B3' }}>
          shares in {h.company.name}, as entered in the register of members
        </span>
      </div>
      <div
        aria-hidden="true"
        className="shrink-0 rounded-lg p-2 flex flex-col items-center gap-1"
        style={{
          width: 108,
          transform: 'rotate(6deg)',
          background: 'linear-gradient(145deg,#ff4f9d,#c2185b)',
          boxShadow: '0 10px 24px rgba(255,46,136,0.35)',
        }}
      >
        <img src={logo} alt="" style={{ width: 84, height: 'auto' }} />
        <span className="text-[9px] font-bold text-white/90">Certificate · No. {h.holder.registerEntry}</span>
      </div>
    </div>
    <div className="flex flex-wrap gap-2">
      <Badge>Register = tokens</Badge>
      <Badge>{`Safe with ${h.company.ticker === 'NINJAPUNKGIRLS' ? 'NPG' : h.company.ticker} (2-of-2)`}</Badge>
    </div>
    <ul className="m-0 p-0 list-none text-sm flex flex-col gap-1">
      {h.tokens.map((t) => (
        <li key={t.id} className="flex justify-between">
          <span style={{ color: '#98A2B3' }}>Tranche {t.tranche}</span>
          <span className="font-semibold">{n(t.amount)}</span>
        </li>
      ))}
      <li className="flex justify-between">
        <span style={{ color: '#98A2B3' }}>Name on the register</span>
        <span className="font-semibold">{h.holder.nameOnRegister}</span>
      </li>
    </ul>
    {h.activity.length > 0 && (
      <ul className="m-0 p-0 list-none text-xs flex flex-col gap-1 border-t pt-2" style={{ borderColor: '#2a1220' }}>
        {h.activity.map((a, i) => (
          <li key={i} className="flex justify-between gap-3">
            <span>{a.text}</span>
            <span style={{ color: '#98A2B3' }}>{a.at.slice(0, 10)}</span>
          </li>
        ))}
      </ul>
    )}
  </section>
);

export default SharesCard;
