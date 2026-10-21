import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { buyOrdinal } from '@1sat/actions';
import { useServiceContext } from '../../hooks/useServiceContext';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { fmtSats } from '../money/money';
import { usdOrSats } from '../names/opnsSell';
import { assertOrdLockV2 } from '../market/ordlockVersion';
import { MODULE_FINISHES, purchaseContext, walletOutpoint } from '../market/walletOutpoint';
import { purchaseError } from '../exchange/purchase';
import {
  filterNpg,
  NPG_AVATARS_COLLECTION,
  NPG_EMPTY_FILTER,
  NPG_SORTS,
  npgFixturePreview,
  npgImageUrl,
  npgMarketUrl,
  pad4,
  parseNpgListings,
  sortNpg,
  STAT_KEYS,
  statLabel,
  type NpgFilter,
  type NpgListing,
  type NpgSort,
} from './npgAvatar';
import { NpgAvatarFlip } from './NpgAvatarFlip';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';

async function loadListings(): Promise<NpgListing[]> {
  if (npgFixturePreview()) return (await import('./npgFixtures')).fixtureListings();
  if (!NPG_AVATARS_COLLECTION) return [];
  const out: NpgListing[] = [];
  // 3,334 items at most: page through the collection's live listings.
  for (let offset = 0; offset < 4000; offset += 100) {
    const r = await fetch(npgMarketUrl(NPG_AVATARS_COLLECTION, offset), { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(String(r.status));
    const rows: unknown = await r.json();
    out.push(...parseNpgListings(rows));
    if (!Array.isArray(rows) || rows.length < 100) break;
  }
  return out;
}

const BuySheet = ({
  l,
  rate,
  onAllow,
  onClose,
}: {
  l: NpgListing;
  rate: number;
  onAllow: () => void;
  onClose: () => void;
}) =>
  createPortal(
    <div
      className="fixed inset-0 z-[420] flex flex-col"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <ApprovalCard
        ours
        site="bWalletX"
        siteSub="Exchange · NPG Avatars"
        onClose={onClose}
        hero={<PayHero amount={usdOrSats(l.priceSats, rate)} sub={fmtSats(l.priceSats)} />}
        title={
          <>
            Own <span style={{ color: CARD.gold }}>{l.name}</span>
          </>
        }
        primary={{ label: 'Allow', onClick: onAllow }}
        secondary={{ label: 'Not now', onClick: onClose }}
      >
        <div className="flex flex-wrap gap-2">
          <Chip>NPG Avatar</Chip>
          <Chip>Score {l.score}</Chip>
          <Chip>Use as your picture</Chip>
          <Chip>Plus a small network fee</Chip>
        </div>
      </ApprovalCard>
    </div>,
    document.body,
  );

const DetailSheet = ({
  l,
  rate,
  busy,
  onBuy,
  onClose,
}: {
  l: NpgListing;
  rate: number;
  busy: boolean;
  onBuy: () => void;
  onClose: () => void;
}) =>
  createPortal(
    <div className="fixed inset-0 z-[400] flex items-end sm:items-center justify-center" role="presentation">
      <button type="button" aria-label="Close" className="absolute inset-0 border-0 bg-black/70" onClick={onClose} />
      <div
        role="dialog"
        aria-label={l.name}
        className="relative w-full sm:max-w-[420px] max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl p-4 flex flex-col gap-3"
        style={{ background: '#111216', paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}
      >
        <NpgAvatarFlip
          a={l}
          size={260}
          actions={
            <div className="w-full grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={onBuy}
                className="rounded-xl py-2.5 text-sm font-bold border-0 cursor-pointer disabled:opacity-50"
                style={{ background: GOLD, color: '#1a1300' }}
              >
                Buy · {usdOrSats(l.priceSats, rate)}
              </button>
              {l.stream === 'claim' && l.url ? (
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl py-2.5 text-sm font-bold text-center no-underline"
                  style={{ border: `1px solid ${GOLD}`, color: GOLD }}
                >
                  Claim
                </a>
              ) : (
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl py-2.5 text-sm font-bold bg-transparent cursor-pointer text-white"
                  style={{ border: '1px solid #2b2f36' }}
                >
                  Close
                </button>
              )}
            </div>
          }
        />
      </div>
    </div>,
    document.body,
  );

/**
 * Exchange › NPG Avatars (owner, 19 Oct 2026): every listed NPG Avatar (OrdLock v2), in a wrapping grid with filters
 * by score, stats and price, sorted by price/score/stat. Buying reuses the Exchange NFT buy (buyOrdinal, v2 only).
 * Off until NPG_AVATARS_COLLECTION is set.
 */
export const NpgAvatarsMarket = ({ rate }: { rate: number }) => {
  const { apiContext } = useServiceContext();
  const [all, setAll] = useState<NpgListing[] | null>(null);
  const [err, setErr] = useState('');
  const [sort, setSort] = useState<NpgSort>('price-asc');
  const [filter, setFilter] = useState<NpgFilter>(NPG_EMPTY_FILTER);
  const [open, setOpen] = useState<NpgListing | null>(null);
  const [buy, setBuy] = useState<NpgListing | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [bought, setBought] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    loadListings()
      .then((l) => live && setAll(l))
      .catch(() => live && (setAll([]), setErr('Couldn’t load listings. Try again in a moment.')));
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(
    () =>
      sortNpg(
        filterNpg(
          (all ?? []).filter((l) => !bought.has(l.outpoint)),
          filter,
        ),
        sort,
      ),
    [all, filter, sort, bought],
  );
  const maxScore = useMemo(() => Math.max(0, ...(all ?? []).map((l) => l.score)), [all]);

  const purchase = async (l: NpgListing) => {
    setBuy(null);
    if (!apiContext) return;
    setBusy(l.outpoint);
    setMsg('');
    try {
      const outpoint = walletOutpoint(l.outpoint);
      await assertOrdLockV2(outpoint);
      const res = await buyOrdinal.execute(purchaseContext(apiContext, outpoint), {
        outpoint,
        name: l.name.slice(0, 64),
        contentType: 'image/webp',
        ...MODULE_FINISHES,
      });
      if (res.error || !res.txid) throw res.error ?? 'Purchase failed';
      setBought((s) => new Set(s).add(l.outpoint));
      setOpen(null);
      setMsg(`You own ${l.name}. Open it in your NFTs to use it as your picture.`);
    } catch (e) {
      setMsg(purchaseError(e));
    } finally {
      setBusy('');
    }
  };

  const set = (p: Partial<NpgFilter>) => setFilter((f) => ({ ...f, ...p }));
  const field = 'rounded-xl px-3 py-2 text-sm bg-[#17191E] border border-[#2b2f36] text-white min-w-0';
  return (
    <div className="flex flex-col gap-3 w-full" data-testid="npg-market">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-extrabold text-white m-0">NPG Avatars</h2>
        <p className="text-xs m-0" style={{ color: MUTED }}>
          3,334 Ninja Punk Girls circles, one per Series 2 card. Each has six stats and a score. Own one and use it as
          your picture.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <input
          className={field}
          placeholder="Search # or trait"
          aria-label="Search"
          value={filter.query}
          onChange={(e) => set({ query: e.target.value })}
        />
        <select className={field} aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as NpgSort)}>
          {NPG_SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <label className="flex flex-col gap-1 text-[11px] col-span-2" style={{ color: MUTED }}>
          Min score: {filter.minScore}
          <input
            type="range"
            min={0}
            max={maxScore || 600}
            value={filter.minScore}
            onChange={(e) => set({ minScore: Number(e.target.value) })}
            style={{ accentColor: 'var(--bw-accent)' }}
          />
        </label>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2" role="group" aria-label="Minimum stats">
        {STAT_KEYS.map((k) => (
          <label key={k} className="flex flex-col gap-1 text-[11px]" style={{ color: MUTED }}>
            {statLabel(k)} ≥
            <input
              className={field}
              inputMode="numeric"
              value={filter.minStat[k] ?? ''}
              placeholder="0"
              onChange={(e) => {
                const v = Number(e.target.value.replace(/\D/g, ''));
                set({ minStat: { ...filter.minStat, [k]: v || undefined } });
              }}
            />
          </label>
        ))}
      </div>
      {all === null ? (
        <p className="text-sm text-center py-8" style={{ color: MUTED }}>
          Loading NPG Avatars…
        </p>
      ) : !shown.length ? (
        <p className="text-sm text-center py-8" style={{ color: MUTED }}>
          {err || (all.length ? 'None match these filters.' : 'No NPG Avatars are listed for sale yet.')}
        </p>
      ) : (
        <ul className="list-none m-0 p-0 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {shown.map((l) => (
            <li key={l.outpoint}>
              <button
                type="button"
                onClick={() => setOpen(l)}
                className="w-full rounded-2xl border border-[#2b2f36] bg-[#111216] p-2 flex flex-col gap-1.5 cursor-pointer text-left"
              >
                <img
                  src={npgImageUrl(l)}
                  alt={l.name}
                  loading="lazy"
                  className="w-full aspect-square object-contain rounded-full bg-black"
                />
                <span className="text-xs font-bold text-white truncate">
                  #{l.card !== null ? pad4(l.card) : (l.mintNumber ?? '')}
                </span>
                <span className="flex items-center justify-between text-[11px]">
                  <span style={{ color: MUTED }}>Score {l.score}</span>
                  <span className="font-bold" style={{ color: GOLD }}>
                    {busy === l.outpoint ? 'Buying…' : usdOrSats(l.priceSats, rate)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {msg && (
        <p className="text-xs m-0" role="status" style={{ color: MUTED }}>
          {msg}
        </p>
      )}
      {open && !buy && (
        <DetailSheet
          l={open}
          rate={rate}
          busy={!apiContext || !!busy}
          onBuy={() => setBuy(open)}
          onClose={() => setOpen(null)}
        />
      )}
      {buy && <BuySheet l={buy} rate={rate} onAllow={() => void purchase(buy)} onClose={() => setBuy(null)} />}
    </div>
  );
};
