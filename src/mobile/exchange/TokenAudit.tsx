import { useEffect, useState } from 'react';
import { BadgeCheck, Copy, ExternalLink } from 'lucide-react';
import { openExternal } from './useTokenRowActions';
import { bsvLabel, chainTip, fiatLabel, tokenTrades, unitPriceLabel, type Trade } from './exchangeData';
import { ScoreRing, ScoreSheet } from './TokenBoard';
import { ageLabel, capLabel, badges, boardFacts, derive, fairScore, shortAmount, type BoardFacts } from './boardFacts';

/**
 * Token page detail (27 Oct 2026): header facts, supply & holders, market cap, recent trades, and an info &
 * audit block that says how each number was proven. A gold tick ("verified by your wallet") marks numbers this
 * wallet checked itself from the deploy transaction's bytes; the rest name their indexer. Same cached data as
 * the card board (boardFacts) and the trade screen (tokenTrades), so opening a token adds no new slow calls.
 */
const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const LINE = '#2b2f36';
const CARD = 'rounded-2xl bg-[var(--bw-surface)] border border-[#2b2f36] p-4 flex flex-col gap-3';
const WOC_TX = 'https://whatsonchain.com/tx/';
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(x > 0 && x < 0.01 ? 2 : 1)}%`);

const Tick = () => (
  <BadgeCheck size={14} color={GOLD} aria-label="Verified by your wallet" className="inline shrink-0" />
);

const Fact = ({ k, v, sub, ok }: { k: string; v: string; sub?: string; ok?: boolean }) => (
  <div className="flex flex-col min-w-0">
    <span className="text-[10px] uppercase tracking-wide" style={{ color: MUTED }}>
      {k}
    </span>
    <span className="text-sm font-bold text-white flex items-center gap-1 min-w-0">
      <span className="truncate">{v}</span>
      {ok && <Tick />}
    </span>
    {sub && (
      <span className="text-[10px]" style={{ color: MUTED }}>
        {sub}
      </span>
    )}
  </div>
);

export const TokenAudit = ({
  tokenId,
  sym,
  rate,
  trades: tradesIn,
}: {
  tokenId: string;
  sym: string;
  rate: number;
  /** The trade screen's trades; omitted: read here (same cache). */
  trades?: Trade[];
}) => {
  const [ownTrades, setOwnTrades] = useState<Trade[]>([]);
  useEffect(() => {
    if (tradesIn) return;
    let live = true;
    void tokenTrades(tokenId).then((t) => live && setOwnTrades(t));
    return () => {
      live = false;
    };
  }, [tokenId, tradesIn]);
  const trades = tradesIn ?? ownTrades;
  const [f, setF] = useState<BoardFacts | null | undefined>(undefined);
  const [tip, setTip] = useState(0);
  const [sheet, setSheet] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    setF(undefined);
    void boardFacts(tokenId)
      .catch(() => null)
      .then((x) => live && setF(x));
    void chainTip().then((t) => live && setTip(t));
    return () => {
      live = false;
    };
  }, [tokenId]);

  if (f === undefined)
    return (
      <p className="text-xs m-0" style={{ color: MUTED }}>
        Checking the chain…
      </p>
    );
  if (f === null) return null;
  const d = derive(f);
  const score = fairScore(f, d);
  const proven = badges(f, d);
  const last = trades.length ? trades[trades.length - 1].satsPerToken : null;
  const mcap = last !== null ? Math.round((last * Number(d.circulating)) / 10 ** f.dec) : null;
  const txid = tokenId.split('_')[0];
  const recent = [...trades].reverse().slice(0, 20);
  const copyId = () => {
    void navigator.clipboard
      ?.writeText(tokenId)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  return (
    <>
      <section className={CARD} aria-label="Token facts">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1 min-w-0">
            <h2 className="text-sm font-extrabold text-white m-0">About ${sym}</h2>
            <button
              type="button"
              onClick={copyId}
              className="flex items-center gap-1.5 min-h-[44px] text-xs font-mono bg-transparent border-0 p-0 cursor-pointer text-left"
              style={{ color: MUTED }}
            >
              {short(tokenId)} <Copy size={12} /> {copied ? 'Copied' : 'Copy ID'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setSheet(true)}
            aria-label={`Fair-launch score ${score.total} of 100. How it's scored`}
            className="flex items-center gap-2 min-h-[44px] bg-transparent border-0 cursor-pointer p-0"
          >
            <ScoreRing n={score.total} />
            <span className="text-[11px] text-left" style={{ color: GOLD }}>
              Fair-launch
              <br />
              score
            </span>
          </button>
        </div>
        {proven.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 m-0 p-0 list-none">
            {proven.map((b) => (
              <li
                key={b.id}
                className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{ background: 'rgba(245,197,24,0.08)', border: '1px solid rgba(245,197,24,0.28)', color: GOLD }}
                title={b.detail}
              >
                {b.label}
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Fact k="Deployer" v={f.deployer ? short(f.deployer) : 'Contract'} ok={!!f.deployer} />
          <Fact k="Launched" v={f.height && tip ? `${ageLabel(tip - f.height)} ago` : '—'} sub={`block ${f.height}`} />
          <Fact
            k="Market cap"
            v={mcap === null ? '—' : capLabel(mcap, rate)}
            sub={mcap === null ? 'never traded' : `${capLabel(mcap, 0)} · at last trade`}
          />
          <Fact
            k="Price per 1M"
            v={last === null ? '—' : unitPriceLabel(last * 1e6)}
            sub={last === null ? '' : `${unitPriceLabel(last)} / token`}
          />
        </div>
      </section>

      <section className={CARD} aria-label="Supply and holders">
        <h2 className="text-sm font-extrabold text-white m-0">Supply &amp; holders</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Fact k="Supply" v={shortAmount(f.supply, f.dec)} sub="Fixed: BSV-21 mints once, at deploy" />
          <Fact k="Burned" v={shortAmount(d.burned, f.dec)} sub={`${pct(d.burnedPct)} at burn addresses`} />
          <Fact k="Circulating" v={shortAmount(d.circulating, f.dec)} sub="Supply − burned" />
          <Fact k="Top 10" v={pct(d.top10Pct)} sub="of circulating, burns excluded" />
          <Fact k="Deployer holds" v={d.devPct === null ? '—' : pct(d.devPct)} sub="of circulating" />
          <Fact k="Holders" v={f.holders === null ? '—' : f.holders.toLocaleString('en-US')} />
        </div>
        {f.top.length > 0 && (
          <ol className="m-0 p-0 list-none flex flex-col text-xs">
            {f.top.slice(0, 10).map((h, i) => (
              <li
                key={h.address}
                className="flex items-center justify-between gap-2 py-1.5"
                style={{ borderTop: i ? `1px solid ${LINE}` : 'none' }}
              >
                <span className="font-mono" style={{ color: MUTED }}>
                  {i + 1}. {short(h.address)}
                  {h.address === f.deployer && <span style={{ color: GOLD }}> · deployer</span>}
                </span>
                <span className="text-white">
                  {shortAmount(h.amt, f.dec)} · {pct(Number(h.amt) / Number(f.supply || 1n))}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={CARD} aria-label="Recent trades">
        <h2 className="text-sm font-extrabold text-white m-0">Recent trades</h2>
        {!recent.length ? (
          <p className="text-xs m-0" style={{ color: MUTED }}>
            No trades yet.
          </p>
        ) : (
          <div className="flex flex-col text-xs">
            <div
              className="grid grid-cols-[48px_1fr_1fr_44px] sm:grid-cols-[56px_1fr_1fr_1fr_1fr_44px] gap-2 py-1"
              style={{ color: MUTED }}
            >
              <span>Age</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">Paid</span>
              <span className="text-right hidden sm:block">Sats / token</span>
              <span className="text-right hidden sm:block">Seller</span>
              <span />
            </div>
            {recent.map((t, i) => (
              <div
                key={`${t.txid ?? i}-${i}`}
                className="grid grid-cols-[48px_1fr_1fr_44px] sm:grid-cols-[56px_1fr_1fr_1fr_1fr_44px] gap-2 items-center min-h-[44px]"
                style={{ borderTop: `1px solid ${LINE}` }}
              >
                <span style={{ color: MUTED }}>{tip ? ageLabel(Math.max(0, tip - t.height)) : `#${t.height}`}</span>
                <span className="text-right text-white">
                  {t.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
                <span className="text-right text-white">
                  {bsvLabel(t.totalSats)}
                  {fiatLabel(t.totalSats, rate) && (
                    <span className="block text-[10px]" style={{ color: MUTED }}>
                      {fiatLabel(t.totalSats, rate)}
                    </span>
                  )}
                </span>
                <span className="text-right text-white hidden sm:block">{unitPriceLabel(t.satsPerToken)}</span>
                <span className="text-right font-mono hidden sm:block" style={{ color: MUTED }}>
                  {t.seller ? short(t.seller) : '—'}
                </span>
                {t.txid ? (
                  <button
                    type="button"
                    aria-label="Open transaction"
                    onClick={() => openExternal(`${WOC_TX}${t.txid}`)}
                    className="w-11 h-11 grid place-items-center bg-transparent border-0 cursor-pointer"
                  >
                    <ExternalLink size={14} color={GOLD} />
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={CARD} aria-label="Info and audit">
        <h2 className="text-sm font-extrabold text-white m-0">Info &amp; audit</h2>
        <ul className="m-0 p-0 list-none flex flex-col gap-2 text-xs">
          <li className="flex items-start gap-2">
            <Tick />
            <span className="text-white">
              Deploy transaction{' '}
              <button
                type="button"
                onClick={() => openExternal(`${WOC_TX}${txid}`)}
                className="font-mono bg-transparent border-0 p-0 cursor-pointer underline"
                style={{ color: GOLD }}
              >
                {short(txid)}
              </button>
              : your wallet fetched its bytes and checked they hash to this token's ID.
            </span>
          </li>
          <li className="flex items-start gap-2">
            {f.deployer ? <Tick /> : <span className="w-[14px]" />}
            <span className="text-white">
              {f.deployer
                ? `Deployer ${short(f.deployer)}: read from the deploy output's address.`
                : 'The minted supply went to a contract, not a plain address.'}
            </span>
          </li>
          <li className="flex items-start gap-2">
            {f.curve ? <Tick /> : <span className="w-[14px]" />}
            <span className="text-white">
              {f.curve
                ? 'Launch curve: committed in the deploy transaction; your wallet checked its hash.'
                : 'No launch curve is committed in the deploy transaction.'}
            </span>
          </li>
          <li className="flex items-start gap-2" style={{ color: MUTED }}>
            <span className="w-[14px]" />
            <span>
              Supply, decimals ({f.dec}), holders and balances: GorillaPool's BSV-21 indexer. Trades: GorillaPool market
              sales. Burned = balances at known burn addresses.
            </span>
          </li>
        </ul>
      </section>
      {sheet && <ScoreSheet token={{ title: `$${sym}`, score }} onClose={() => setSheet(false)} />}
    </>
  );
};
