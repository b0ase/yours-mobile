import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Loader2, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { fetchExchangeRate } from '../../utils/wallet';
import { listAgentsOnly } from '../agents/agentAccounts';
import { loadStrategy, type Strategy } from '../agents/strategy';
import { marketFeeSats } from '../market/fee';
import { buyStrategy, listStrategies, ownedStrategyOutpoints, priceSats, unlockStrategy, type Listing } from './market';
import { SPEC_LABELS, STRATEGY_DISCLAIMER } from './strategyNft';
import { rememberStrategy, myStrategies } from './myStrategies';
import { ErrorActions } from '../errors/ErrorActions';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const CARD = '#17191E';
const LINE = '#2b2f36';
const usd = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;
const RISK_COLOR: Record<string, string> = { Low: '#6CE9A6', Medium: GOLD, High: '#FDA29B', Experimental: '#BDB4FE' };

/** Load a strategy into one of this wallet's agent accounts (always on paper first). */
export const LoadInto = ({ strategy, onDone }: { strategy: Strategy; onDone: () => void }) => {
  const { chromeStorageService } = useServiceContext();
  const accounts = chromeStorageService.getAllAccounts?.() ?? [];
  const agents = listAgentsOnly();
  const { addSnackbar } = useSnackbar();
  if (!agents.length)
    return (
      <p className="text-xs m-0" style={{ color: MUTED }}>
        Make an agent account (Settings › Agents) to run it. It stays in your wallet until then.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-bold text-white">Load into an agent account (starts on paper)</div>
      {agents.map((a) => {
        const name = accounts.find((x) => x.addresses.identityAddress === a.identityAddress)?.name || 'Agent account';
        return (
          <button
            key={a.identityAddress}
            type="button"
            onClick={() => {
              loadStrategy(a.identityAddress, strategy, 'paper');
              addSnackbar(`Loaded into ${name} on paper.`, 'success');
              onDone();
            }}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-bold border-0 text-left"
            style={{ background: '#7A5AF822', color: '#BDB4FE' }}
          >
            <Bot size={15} /> {name}
          </button>
        );
      })}
    </div>
  );
};

/** Exchange › Strategies (SMART-WALLET-SPEC.md §7). */
export const StrategiesMarket = () => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [items, setItems] = useState<Listing[] | null>(null);
  const [error, setError] = useState('');
  const [rate, setRate] = useState(0);
  const [open, setOpen] = useState<Listing | null>(null);
  const [owned, setOwned] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [bought, setBought] = useState<Strategy | null>(null);
  const [risk, setRisk] = useState<string>('All');

  const refresh = () => {
    listStrategies().then(setItems, (e) => setError(e instanceof Error ? e.message : String(e)));
    if (apiContext) void ownedStrategyOutpoints(apiContext).then(setOwned, () => {});
  };
  useEffect(() => {
    refresh();
    fetchExchangeRate('main').then(setRate, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mine = myStrategies();
  const lockedOwned = owned.filter((o) => !mine[o]);

  const buy = async (l: Listing) => {
    if (!apiContext) return;
    setBusy('Buying…');
    try {
      const { outpoint, strategy } = await buyStrategy(apiContext, l.origin, rate);
      rememberStrategy(outpoint, strategy);
      setBought(strategy);
      addSnackbar(`Bought ${strategy.name}.`, 'success');
      refresh();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Purchase failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const unlock = async (outpoint: string) => {
    if (!apiContext) return;
    setBusy('Unlocking…');
    try {
      const s = await unlockStrategy(apiContext, outpoint);
      rememberStrategy(outpoint, s);
      setBought(s);
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Unlock failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const shown = (items ?? []).filter((l) => risk === 'All' || l.envelope.spec.risk === risk);
  return (
    <section className="flex flex-col gap-3">
      <p className="text-[11px] m-0" style={{ color: MUTED }}>
        {STRATEGY_DISCLAIMER}
      </p>
      <div className="flex gap-2 flex-wrap">
        {['All', 'Low', 'Medium', 'High', 'Experimental'].map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRisk(r)}
            className="rounded-full px-3 py-1 text-xs font-semibold border-0"
            style={{
              background: risk === r ? '#2b2f36' : 'transparent',
              color: risk === r ? '#fff' : MUTED,
              border: `1px solid ${LINE}`,
            }}
          >
            {r === 'All' ? 'Any risk' : r}
          </button>
        ))}
      </div>

      {(Object.keys(mine).length > 0 || lockedOwned.length > 0) && (
        <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: CARD }}>
          <div className="text-sm font-bold text-white">Your strategies</div>
          {Object.entries(mine).map(([op, m]) => (
            <button
              key={op}
              type="button"
              onClick={() => setBought(m.strategy)}
              className="text-left text-sm border-0 bg-transparent p-0"
              style={{ color: GOLD }}
            >
              {m.strategy.name} v{m.strategy.version} → Load
            </button>
          ))}
          {lockedOwned.map((op) => (
            <button
              key={op}
              type="button"
              disabled={!!busy}
              onClick={() => void unlock(op)}
              className="text-left text-sm border-0 bg-transparent p-0"
              style={{ color: GOLD }}
            >
              Strategy NFT {op.slice(0, 8)}… → Unlock
            </button>
          ))}
        </div>
      )}

      {items === null && !error && (
        <p className="text-xs text-center py-8 m-0" style={{ color: MUTED }}>
          Loading strategies…
        </p>
      )}
      {error && (
<div className="flex flex-col gap-1.5"><p className="text-xs m-0" style={{ color: '#F97066' }}>
          {error}
        </p><ErrorActions message={String(error)} /></div>
)}
      {items?.length === 0 && (
        <p className="text-xs text-center py-8 m-0" style={{ color: MUTED }}>
          No strategies for sale yet. Publish yours from an agent account (Settings › Agents › Strategy › Publish &amp;
          sell).
        </p>
      )}
      {shown.map((l) => {
        const left = l.envelope.sale.copies - l.sold;
        return (
          <button
            key={l.origin}
            type="button"
            onClick={() => setOpen(l)}
            className="flex flex-col gap-1 rounded-xl px-3 py-3 text-left border-0"
            style={{ background: CARD }}
          >
            <div className="flex items-center gap-2">
              <span className="flex-1 text-sm font-semibold text-white truncate">
                {l.envelope.name} <span style={{ color: MUTED }}>v{l.envelope.version}</span>
              </span>
              <span className="text-sm font-bold" style={{ color: '#A1FF8B' }}>
                {usd(l.envelope.sale.priceUsd)}
              </span>
            </div>
            <div className="text-[11px] truncate" style={{ color: MUTED }}>
              by {l.envelope.author.name || l.envelope.author.address.slice(0, 8)} · {l.envelope.spec.trades} ·{' '}
              <span style={{ color: RISK_COLOR[l.envelope.spec.risk] ?? MUTED }}>{l.envelope.spec.risk} risk</span> ·{' '}
              {left > 0 ? `${left} left` : 'sold out'}
            </div>
          </button>
        );
      })}

      {(open || bought) &&
        createPortal(
          <div
            className="fixed inset-0 z-[300] flex items-end"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            onClick={() => (setOpen(null), setBought(null))}
          >
            <div
              className="w-full max-h-[85vh] overflow-y-auto rounded-t-2xl p-4 flex flex-col gap-3"
              style={{ background: '#101114', paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center">
                <span className="flex-1 text-base font-bold text-white">
                  {bought ? bought.name : open!.envelope.name}
                </span>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => (setOpen(null), setBought(null))}
                  className="p-1 border-0 bg-transparent"
                >
                  <X size={18} color={MUTED} />
                </button>
              </div>
              {bought ? (
                <LoadInto strategy={bought} onDone={() => (setOpen(null), setBought(null))} />
              ) : (
                open && (
                  <>
                    <p className="text-sm m-0 whitespace-pre-wrap" style={{ color: '#D0D5DD' }}>
                      {open.envelope.description}
                    </p>
                    <div className="rounded-lg p-3 flex flex-col gap-1.5" style={{ background: CARD }}>
                      {(Object.keys(SPEC_LABELS) as (keyof typeof SPEC_LABELS)[]).map((k) => (
                        <div key={k} className="flex gap-2 text-xs">
                          <span className="w-36 shrink-0" style={{ color: MUTED }}>
                            {SPEC_LABELS[k]}
                          </span>
                          <span style={{ color: k === 'risk' ? RISK_COLOR[open.envelope.spec.risk] : '#F2F2F0' }}>
                            {open.envelope.spec[k]}
                          </span>
                        </div>
                      ))}
                      <div className="flex gap-2 text-xs">
                        <span className="w-36 shrink-0" style={{ color: MUTED }}>
                          Author · version
                        </span>
                        <span className="text-white">
                          {open.envelope.author.name || open.envelope.author.address.slice(0, 10)} · v
                          {open.envelope.version}
                        </span>
                      </div>
                      <div className="flex gap-2 text-xs">
                        <span className="w-36 shrink-0" style={{ color: MUTED }}>
                          Copies
                        </span>
                        <span className="text-white">
                          {open.sold} of {open.envelope.sale.copies} sold ·{' '}
                          {new Date(open.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <p className="text-[11px] m-0" style={{ color: MUTED }}>
                      {STRATEGY_DISCLAIMER} You own your copy: you can load it, send it, or resell it.
                    </p>
                    {(() => {
                      const sats = rate > 0 ? priceSats(open.envelope, rate) : 0;
                      const fee = marketFeeSats(sats);
                      const soldOut = open.sold >= open.envelope.sale.copies;
                      return (
                        <button
                          type="button"
                          disabled={!!busy || soldOut || !rate || !apiContext}
                          onClick={() => void buy(open)}
                          className="flex items-center justify-center gap-2 rounded-full py-3 font-bold border-0"
                          style={{ background: GOLD, color: '#000', opacity: busy || soldOut ? 0.6 : 1 }}
                        >
                          {busy && <Loader2 size={15} className="animate-spin" />}
                          {busy ||
                            (soldOut
                              ? 'Sold out'
                              : `Buy for ${usd(open.envelope.sale.priceUsd)}${fee && rate ? ` + ${usd((fee / 1e8) * rate)} fee` : ''}`)}
                        </button>
                      );
                    })()}
                  </>
                )
              )}
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
};
