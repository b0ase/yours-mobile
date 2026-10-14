/**
 * Exchange categories, platform filter, tag chips and the Platforms pages (docs/EXCHANGE-CATEGORIES.md).
 * Only categories and platforms that have tokens are shown.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, BadgeCheck, Lock, SlidersHorizontal, Users } from 'lucide-react';
import { ONESAT, cached, roomMeta, type HotRoom } from '../market/indexer';
import { TokenIcon } from './TokenIcon';
import { platformRoute, tradeRoute } from './exchangeData';
import {
  CATEGORIES,
  categoryLabel,
  facetCounts,
  issuerLabels,
  type Filter,
  type Labels,
  type TokenLabels,
} from './registry/catalog';
import type { Registry } from './registry/registry';
import { useRegistry } from './registry/useRegistry';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const PAGE = 50;

const Chip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={on}
    className="shrink-0 rounded-full px-3 py-1 text-xs font-bold border cursor-pointer whitespace-nowrap"
    style={{ background: on ? '#2a2100' : '#17191E', borderColor: on ? GOLD : '#2b2f36', color: on ? GOLD : '#fff' }}
  >
    {children}
  </button>
);

/**
 * The one filter button (owner, 14 Oct 2026: "4×4 filters… but only one large yellow button that stretches the whole
 * width"): a full-width gold button naming the current filter, opening a 4×4 grid: All, People, and the 14
 * categories (Games and Apps among them), each with its count. Platforms and the active tag stay below as before.
 */
export const FilterBar = ({
  labels,
  filter,
  registry,
  onChange,
  people,
  onPeople,
  shares,
  onShares,
}: {
  labels: readonly TokenLabels[];
  filter: Filter;
  registry: Registry;
  onChange: (f: Filter) => void;
  /** The People (friends' tokens) view, when the page offers it. */
  people?: boolean;
  onPeople?: (on: boolean) => void;
  /** The restricted Shares view (bShares; never offered for sale), when the page offers it (not in a store build). */
  shares?: boolean;
  onShares?: (on: boolean) => void;
}) => {
  const { cats, plats } = useMemo(() => facetCounts(labels, filter), [labels, filter]);
  const total = [...cats.values()].reduce((a, b) => a + b, 0);
  const platforms = registry.platforms.filter((p) => (plats.get(p.slug) ?? 0) > 0 || filter.platforms.includes(p.slug));
  const [grid, setGrid] = useState(false);
  const current = shares ? 'Shares' : people ? 'People' : filter.cat ? categoryLabel(filter.cat) : 'All markets';
  const currentCount = people || shares ? null : filter.cat ? (cats.get(filter.cat) ?? 0) : total;
  const cell = (on: boolean, label: string, count: number | null, onClick: () => void, icon?: React.ReactNode) => (
    <button
      key={label}
      type="button"
      aria-pressed={on}
      onClick={() => {
        onClick();
        setGrid(false);
      }}
      className="min-h-[64px] rounded-xl px-1.5 py-2 text-[12px] font-bold flex flex-col items-center justify-center gap-0.5 cursor-pointer"
      style={{
        background: on ? GOLD : '#17191E',
        color: on ? '#1a1300' : '#fff',
        border: `1px solid ${on ? GOLD : '#2b2f36'}`,
      }}
    >
      {icon}
      <span className="leading-tight text-center">{label}</span>
      {count !== null && (
        <span className="text-[10px] font-semibold" style={{ color: on ? '#1a1300' : MUTED }}>
          {count}
        </span>
      )}
    </button>
  );
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setGrid(true)}
        aria-haspopup="dialog"
        aria-expanded={grid}
        className="w-full min-h-[48px] rounded-xl px-4 flex items-center justify-between gap-3 text-sm font-bold cursor-pointer border-0"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        <span className="inline-flex items-center gap-2">
          <SlidersHorizontal size={16} aria-hidden="true" /> {current}
          {currentCount !== null && <span className="font-semibold opacity-70">{currentCount}</span>}
        </span>
        <span className="text-xs font-semibold opacity-80">Change</span>
      </button>
      {grid &&
        createPortal(
          <div
            role="dialog"
            aria-label="Show which markets?"
            className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            onClick={() => setGrid(false)}
          >
            <div
              className="w-full max-w-md rounded-t-3xl sm:rounded-3xl p-3 flex flex-col gap-2"
              style={{ background: '#0f1013', border: '1px solid #2b2f36' }}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="m-0 px-1 pt-1 text-sm font-bold text-white">Show which markets?</p>
              <div className="grid grid-cols-4 gap-1.5">
                {cell(!people && !shares && !filter.cat, 'All', total, () => {
                  onPeople?.(false);
                  onShares?.(false);
                  onChange({ ...filter, cat: null });
                })}
                {onPeople &&
                  cell(!!people, 'People', null, () => onPeople(true), <Users size={14} aria-hidden="true" />)}
                {onShares &&
                  cell(!!shares, 'Shares', null, () => onShares(true), <Lock size={14} aria-hidden="true" />)}
                {CATEGORIES.map((c) =>
                  cell(!people && !shares && filter.cat === c.slug, c.label, cats.get(c.slug) ?? 0, () => {
                    onPeople?.(false);
                    onShares?.(false);
                    onChange({ ...filter, cat: c.slug });
                  }),
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
      {platforms.length > 1 && (
        <div className="flex gap-1.5 items-center overflow-x-auto pb-1" role="group" aria-label="Platforms">
          <span className="text-[11px] shrink-0" style={{ color: MUTED }}>
            Platform
          </span>
          {platforms.map((p) => {
            const on = filter.platforms.includes(p.slug);
            return (
              <Chip
                key={p.slug}
                on={on}
                onClick={() =>
                  onChange({
                    ...filter,
                    platforms: on ? filter.platforms.filter((x) => x !== p.slug) : [...filter.platforms, p.slug],
                  })
                }
              >
                {p.name} {plats.get(p.slug) ?? 0}
              </Chip>
            );
          })}
        </div>
      )}
      {filter.tag && (
        <div className="flex gap-1.5 items-center">
          <span className="text-[11px]" style={{ color: MUTED }}>
            Tag
          </span>
          <Chip on onClick={() => onChange({ ...filter, tag: '' })}>
            #{filter.tag} ✕
          </Chip>
        </div>
      )}
    </div>
  );
};

/** Category, platform badge (with a tick when verified) and tags. Tags open the board filtered by that tag. */
export const LabelChips = ({ l, registry }: { l: TokenLabels; registry: Registry }) => {
  const navigate = useNavigate();
  const p = registry.platforms.find((x) => x.slug === l.platform);
  return (
    <div className="flex flex-wrap gap-1.5 items-center text-[11px]">
      <span className="rounded-full px-2 py-0.5 border border-[#2b2f36] text-white">{categoryLabel(l.category)}</span>
      <button
        type="button"
        onClick={() => navigate(platformRoute(l.platform))}
        className="flex items-center gap-1 rounded-full px-2 py-0.5 border border-[#2b2f36] bg-transparent cursor-pointer"
        style={{ color: GOLD }}
        title={l.verified ? 'Listed by this platform (signed)' : 'Platform'}
      >
        {l.verified && <BadgeCheck size={12} color={GOLD} />}
        {p?.name ?? l.platform}
      </button>
      {l.tags.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => navigate(`/m/exchange?tag=${encodeURIComponent(t)}`)}
          className="rounded-full px-2 py-0.5 border-0 bg-[#17191E] cursor-pointer"
          style={{ color: MUTED }}
        >
          #{t}
        </button>
      ))}
    </div>
  );
};

/** Every platform with tokens, and how many. */
export const PlatformsView = ({ registry, board }: { registry: Registry; board: readonly HotRoom[] }) => {
  const navigate = useNavigate();
  const counts = useMemo(() => platformCounts(registry, board), [registry, board]);
  const list = registry.platforms.filter((p) => (counts.get(p.slug) ?? 0) > 0);
  return (
    <div className="flex flex-col gap-2 w-full max-w-[720px]">
      {list.map((p) => (
        <button
          key={p.slug}
          type="button"
          onClick={() => navigate(platformRoute(p.slug))}
          className="flex justify-between items-center gap-3 rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-3 text-left cursor-pointer"
        >
          <span className="min-w-0">
            <span className="block text-sm font-bold text-white">{p.name}</span>
            {p.about && (
              <span className="block text-xs truncate" style={{ color: MUTED }}>
                {p.about}
              </span>
            )}
          </span>
          <span className="text-xs shrink-0" style={{ color: GOLD }}>
            {counts.get(p.slug)} token{counts.get(p.slug) === 1 ? '' : 's'}
          </span>
        </button>
      ))}
    </div>
  );
};

/** A platform's token ids: everything it lists, plus board tokens that resolve to it. Hidden ones dropped. */
const platformCatalogue = (registry: Registry, board: readonly HotRoom[], slug: string): string[] => {
  const ids = new Set(registry.platformTokens(slug));
  for (const r of board) if (registry.labels(r.ref.id).platform === slug) ids.add(r.ref.id);
  return [...ids].filter((id) => !registry.hidden.has(id));
};

const platformCounts = (registry: Registry, board: readonly HotRoom[]) =>
  new Map(registry.platforms.map((p) => [p.slug, platformCatalogue(registry, board, p.slug).length]));

/** One platform's whole catalogue, PAGE rows at a time; names/icons for rows off the board load as they show. */
export const PlatformPage = ({
  slug,
  registry,
  board,
}: {
  slug: string;
  registry: Registry;
  board: readonly HotRoom[];
}) => {
  const navigate = useNavigate();
  const p = registry.platforms.find((x) => x.slug === slug);
  const ids = useMemo(() => platformCatalogue(registry, board, slug), [registry, board, slug]);
  const byId = useMemo(() => new Map(board.map((r) => [r.ref.id, r])), [board]);
  const [shown, setShown] = useState(PAGE);
  const [meta, setMeta] = useState<Record<string, { title: string; icon: string | null }>>({});
  const visible = ids.slice(0, shown);
  const key = visible.join(',');
  useEffect(() => {
    let live = true;
    for (const id of visible)
      if (!byId.has(id) && !meta[id])
        void roomMeta('bsv21', id).then(
          (m) => live && m && setMeta((x) => ({ ...x, [id]: { title: m.title, icon: m.icon } })),
        );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate(platformRoute())}
          aria-label="All platforms"
          className="w-9 h-9 grid place-items-center rounded-full bg-[#17191E] border-0 cursor-pointer"
        >
          <ArrowLeft size={18} color="#fff" />
        </button>
        <div className="min-w-0">
          <div className="text-lg font-extrabold text-white">{p?.name ?? slug}</div>
          <div className="text-xs" style={{ color: MUTED }}>
            {ids.length} token{ids.length === 1 ? '' : 's'}
            {p?.url && (
              <>
                {' · '}
                <a href={p.url} target="_blank" rel="noreferrer" style={{ color: GOLD }}>
                  {p.url.replace(/^https:\/\/(www\.)?/, '')}
                </a>
              </>
            )}
          </div>
        </div>
      </div>
      {!ids.length ? (
        <p className="text-sm" style={{ color: MUTED }}>
          No tokens from this platform.
        </p>
      ) : (
        <div className="rounded-2xl bg-[#17191E] border border-[#2b2f36]">
          {visible.map((id) => {
            const r = byId.get(id);
            const m = meta[id];
            const title = r?.title ?? m?.title ?? `${id.slice(0, 8)}…`;
            const l = registry.labels(id);
            return (
              <div
                key={id}
                role="button"
                tabIndex={0}
                onClick={() => navigate(tradeRoute(id))}
                onKeyDown={(e) => e.key === 'Enter' && navigate(tradeRoute(id))}
                className="flex items-center gap-3 px-3 py-2.5 border-t first:border-t-0 border-[#2b2f36] cursor-pointer hover:bg-[#1e2127]"
              >
                <TokenIcon icon={r?.icon ?? m?.icon ?? null} sym={title} size={28} />
                <span className="font-bold text-white text-sm truncate flex-1">{title}</span>
                <span className="text-[11px] shrink-0" style={{ color: MUTED }}>
                  {categoryLabel(l.category)}
                </span>
              </div>
            );
          })}
          {ids.length > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE)}
              className="w-full py-3 text-xs font-bold border-0 bg-transparent cursor-pointer"
              style={{ color: GOLD }}
            >
              Show more ({ids.length - shown})
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/** What the issuer wrote in the deploy inscription (category/tags), if anything. */
const issuerOf = (id: string): Promise<Labels> =>
  cached(`issuer:${id}`, async () => {
    try {
      const r = await fetch(`${ONESAT}/bsv21/${id}`);
      if (!r.ok) return {};
      const j = (await r.json()) as { token?: unknown };
      return issuerLabels(j.token);
    } catch {
      return {};
    }
  });

/** The token page's category, platform badge and tags. */
export const TokenLabelsRow = ({ id }: { id: string }) => {
  const registry = useRegistry();
  const [issuer, setIssuer] = useState<Labels | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void issuerOf(id).then((l) => live && setIssuer(l));
    return () => {
      live = false;
    };
  }, [id]);
  if (!registry) return null;
  return <LabelChips l={registry.labels(id, issuer)} registry={registry} />;
};
