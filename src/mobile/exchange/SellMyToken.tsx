import { useCallback, useEffect, useRef, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useBackClose } from '../backStack';
import { roomMarket, clearMarketCache } from '../market/indexer';
import { createTranche, cancelOutpoints } from '../sell/sellActions';
import { PERSONAL_DECIMALS } from '../names/personalToken';
import {
  centsLabel,
  fetchSettings,
  flatCents,
  listingPriceSats,
  normOutpoint,
  refillPlan,
  saveSettings,
  supporterBadge,
  type SalesMode,
  type SalesSettings,
} from './curveSales';
import type { PersonToken } from './people';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';

/**
 * Bring the person's live curve listings in line with their settings, from THEIR wallet (we hold no keys):
 * cancel when closed or re-pricing, list the gap at the current price, register the outpoints with bit-sign.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const syncCurveListings = async (
  ctx: Parameters<typeof createTranche>[0],
  token: PersonToken,
  s: SalesSettings,
  rate: number,
): Promise<SalesSettings> => {
  const ref = { kind: 'bsv21' as const, id: token.tokenId, key: `bsv21:${token.tokenId}` };
  clearMarketCache();
  const m = await roomMarket(ref, 100).catch(() => null);
  const onMarket = new Set((m?.listings ?? []).map((l) => normOutpoint(l.outpoint)));
  const live = s.sales.listings.filter((o) => onMarket.has(normOutpoint(o)));
  const plan = refillPlan(s.sales, live, s.holders, s.pricing.mode);
  const cancelled = plan.cancel.length ? await cancelOutpoints(ctx, plan.cancel) : [];
  let added: string[] = [];
  const sats = s.price_usd_cents !== null ? listingPriceSats(s.price_usd_cents, s.sales.pack, rate) : 0;
  if (plan.list > 0 && sats > 0) {
    added = await createTranche(ctx, {
      tokenId: token.tokenId,
      symbol: token.ticker,
      dec: PERSONAL_DECIMALS,
      pack: BigInt(s.sales.pack) * 10n ** BigInt(PERSONAL_DECIMALS),
      count: plan.list,
      priceSats: sats,
    });
  }
  const gone = new Set(cancelled.map(normOutpoint));
  const listings = [...live.filter((o) => !gone.has(normOutpoint(o))), ...added];
  if (!plan.cancel.length && !added.length && listings.length === s.sales.listings.length) return s;
  return saveSettings({ token_id: token.tokenId, listings, ...(added.length ? { priced_at_holders: s.holders } : {}) });
};

/** Your own token on the Friends market: sales settings + supporters (the person's settings screen). */
export const SellMyToken = ({ token, rate }: { token: PersonToken; rate: number }) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<SalesSettings | null>(null);
  const [mode, setMode] = useState<SalesMode>('curve');
  const [flat, setFlat] = useState('');
  const [tranche, setTranche] = useState('10');
  const [busy, setBusy] = useState(false);
  const synced = useRef(false);
  useBackClose(open, () => setOpen(false));

  const sync = useCallback(
    async (cur: SalesSettings) => {
      if (rate <= 0) return cur;
      const next = await syncCurveListings(apiContext, token, cur, rate);
      setS(next);
      return next;
    },
    [apiContext, token, rate],
  );

  // Load; when sales are open, refill / re-price once per session while the wallet is open.
  useEffect(() => {
    let live = true;
    void fetchSettings(token.tokenId)
      .then(async (v) => {
        if (!live) return;
        setS(v);
        setMode(v.pricing.mode);
        setFlat(v.pricing.mode === 'flat' && v.pricing.usd_cents ? (v.pricing.usd_cents / 100).toFixed(2) : '');
        setTranche(String(v.sales.tranche));
        if (v.sales.open && !synced.current) {
          synced.current = true;
          await sync(v).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [token.tokenId, sync]);

  const save = async (openSales: boolean) => {
    const cents = mode === 'flat' ? flatCents(flat) : null;
    if (mode === 'flat' && cents === null) return addSnackbar('Choose a price between 1¢ and $1,000', 'error');
    setBusy(true);
    try {
      const v = await saveSettings({
        token_id: token.tokenId,
        mode,
        ...(cents !== null ? { usd_cents: cents } : {}),
        open: openSales && mode !== 'off',
        tranche: Number(tranche) || 10,
      });
      setS(v);
      await sync(v);
      addSnackbar(v.sales.open ? 'Sales are open' : 'Saved', 'success');
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Could not save', 'error');
    } finally {
      setBusy(false);
    }
  };

  const price = s?.price_usd_cents ?? token.priceUsdCents;
  return (
    <>
      <section className="flex items-center gap-3 rounded-2xl bg-[#17191E] border border-[#3a2f0c] px-3 py-2.5">
        <div className="flex-1 min-w-0">
          <div className="font-bold text-white truncate">Your token ${token.ticker}</div>
          <div className="text-[11px] truncate" style={{ color: MUTED }}>
            {s?.sales.open ? `Selling to join · ${price !== null ? centsLabel(price) : ''}` : 'Sales closed'}
            {s && ` · ${s.holders} supporter${s.holders === 1 ? '' : 's'}`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-extrabold border cursor-pointer bg-transparent"
          style={{ borderColor: '#3a2f0c', color: GOLD }}
        >
          <Settings2 size={13} /> Sales
        </button>
      </section>
      {open && (
        <div
          className="fixed inset-0 z-[200] flex items-end md:items-center justify-center bg-black/60"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="w-full md:max-w-[440px] max-h-[85vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-[#17191E] px-5 pt-5 flex flex-col gap-3 text-sm"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-base font-bold text-white">Who can join ${token.handle}'s room</div>
            <div className="flex flex-col gap-2">
              {(
                [
                  [
                    'curve',
                    'Gentle price (default)',
                    'Starts at 1¢ and doubles every 10,000 supporters. One join per person, up to 100 tokens.',
                  ],
                  ['flat', 'Fixed price', 'You choose the price of one join.'],
                  ['off', 'Ask to join', 'No sales. People ask you instead.'],
                ] as const
              ).map(([m, title, sub]) => (
                <label key={m} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sales-mode"
                    checked={mode === m}
                    onChange={() => setMode(m)}
                    className="mt-1"
                  />
                  <span>
                    <span className="text-white font-semibold">{title}</span>
                    <span className="block text-[11px]" style={{ color: MUTED }}>
                      {sub}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {mode === 'flat' && (
              <label className="flex items-center justify-between gap-3 text-white">
                Price of one join ($)
                <input
                  inputMode="decimal"
                  value={flat}
                  onChange={(e) => setFlat(e.target.value)}
                  placeholder="0.25"
                  className="w-24 rounded-lg bg-[#0d0f12] border border-[#2b2f36] px-2 py-1 text-right text-white"
                />
              </label>
            )}
            {mode !== 'off' && (
              <label className="flex items-center justify-between gap-3 text-white">
                Joins on offer at a time
                <input
                  inputMode="numeric"
                  value={tranche}
                  onChange={(e) => setTranche(e.target.value.replace(/\D/g, '').slice(0, 2))}
                  className="w-16 rounded-lg bg-[#0d0f12] border border-[#2b2f36] px-2 py-1 text-right text-white"
                />
              </label>
            )}
            <p className="text-[11px] m-0" style={{ color: MUTED }}>
              Your wallet puts these up from your own tokens and tops them up when it is open. Payments go straight to
              you.
            </p>
            <div className="flex gap-2">
              {mode !== 'off' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save(true)}
                  className="flex-1 rounded-xl py-3 font-extrabold border-0 cursor-pointer disabled:opacity-50"
                  style={{ background: GOLD, color: '#010101' }}
                >
                  {busy ? '…' : s?.sales.open ? 'Save' : 'Open sales'}
                </button>
              )}
              {(s?.sales.open || mode === 'off') && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save(false)}
                  className="flex-1 rounded-xl py-3 font-bold border cursor-pointer bg-transparent disabled:opacity-50"
                  style={{ borderColor: '#2b2f36', color: 'white' }}
                >
                  {mode === 'off' ? 'Save' : 'Close sales'}
                </button>
              )}
            </div>
            <div className="border-t border-[#2b2f36] pt-2">
              <div className="text-xs font-bold mb-1" style={{ color: MUTED }}>
                Supporters
              </div>
              {!s?.supporters.length ? (
                <p className="text-[11px] m-0" style={{ color: MUTED }}>
                  No one yet.
                </p>
              ) : (
                <ul className="m-0 p-0 list-none flex flex-col gap-1">
                  {s.supporters.map((p, i) => (
                    <li key={`${p.handle}-${i}`} className="flex justify-between text-xs text-white">
                      <span>${p.handle}</span>
                      <span style={{ color: GOLD }}>{supporterBadge(p.supporter) ?? ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
