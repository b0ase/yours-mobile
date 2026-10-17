import { lazy, Suspense, useMemo, useState, type CSSProperties } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Brush,
  Clapperboard,
  DoorOpen,
  Palette,
  Repeat,
  Search,
  Smile,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { TopNav } from '../../components/TopNav';
import { THEME_ORDERS_ENABLED } from '../storeBuild';
import { priceLabel, visible, type Listing } from './bstore';
import { S } from './styles';
import { StatusList } from './ui';

// The existing "Get your own edition" order flow ($99 a year), bWalletX only.
const ThemeOrderSheet = THEME_ORDERS_ENABLED ? lazy(() => import('../themeOrder/ThemeOrderSheet')) : null;

type DeptId = 'themes' | 'subscriptions' | 'stickers' | 'art' | 'media' | 'learning' | 'rooms' | 'services';
interface Dept {
  id: DeptId;
  name: string;
  blurb: string;
  sell: string;
  Icon: LucideIcon;
  has: (l: Listing) => boolean;
}

/**
 * bStore departments (owner, 17 Oct 2026): the store is organised into departments and Themes is one of them.
 * Themes means themes people make and sell; the built-in themes stay in Settings › Theme, never here.
 */
const DEPTS: readonly Dept[] = [
  {
    id: 'themes',
    name: 'Themes',
    blurb: 'Looks for the whole app, made by people',
    sell: 'Sell your theme',
    Icon: Palette,
    has: (l) => l.category === 'themes',
  },
  {
    id: 'subscriptions',
    name: 'Subscriptions',
    blurb: 'Pay by the day, week or month',
    sell: 'Sell a subscription',
    Icon: Repeat,
    has: (l) => l.type === 'subscription',
  },
  {
    id: 'stickers',
    name: 'Stickers & emoji',
    blurb: 'Packs for chats and posts',
    sell: 'Sell a pack',
    Icon: Smile,
    has: (l) => l.category === 'stickers',
  },
  {
    id: 'art',
    name: 'Art & editions',
    blurb: 'Pictures and numbered editions',
    sell: 'Sell your art',
    Icon: Brush,
    has: (l) => l.category === 'art',
  },
  {
    id: 'media',
    name: 'Music & video',
    blurb: 'Albums, films and fan access',
    sell: 'Sell music or video',
    Icon: Clapperboard,
    has: (l) => l.category === 'media',
  },
  {
    id: 'learning',
    name: 'Courses & books',
    blurb: 'Learn something, read something',
    sell: 'Sell a course or book',
    Icon: BookOpen,
    has: (l) => l.category === 'learning',
  },
  {
    id: 'rooms',
    name: 'Rooms & memberships',
    blurb: 'Join a room without holding its token',
    sell: 'Sell memberships',
    Icon: DoorOpen,
    has: (l) => l.category === 'rooms',
  },
  {
    id: 'services',
    name: 'Services',
    blurb: 'Design, dev and help from people',
    sell: 'Offer a service',
    Icon: Wrench,
    has: (l) => l.category === 'services',
  },
];

// Real listings only. None are live yet, so each department shows an honest empty state (no examples).
const LISTINGS: readonly Listing[] = visible([]);

const matches = (l: Listing, q: string) =>
  !q || `${l.title} ${l.description} ${l.seller}`.toLowerCase().includes(q.toLowerCase());

const deptCard: CSSProperties = {
  ...S.card,
  padding: 14,
  minHeight: 132,
  textAlign: 'left',
  font: 'inherit',
  color: 'var(--bw-text, #f2f2f0)',
  cursor: 'pointer',
};
const searchBox: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  margin: '0 0 16px',
  padding: '10px 12px',
  borderRadius: 'var(--bw-radius-btn, 12px)',
  background: 'var(--bw-card, #17191e)',
  border: '1px solid var(--bw-line, #2b2f36)',
};

/** One department: its products, or "Be the first to sell here". Buying and selling are not open yet. */
function Department({ d, query, onBack }: { d: Dept; query: string; onBack: () => void }) {
  const [soon, setSoon] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const items = LISTINGS.filter((l) => d.has(l) && matches(l, query));
  return (
    <>
      <button
        type="button"
        onClick={onBack}
        style={{ ...S.ghost, display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12 }}
      >
        <ArrowLeft size={16} aria-hidden="true" /> All departments
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <d.Icon size={22} color="var(--bw-accent)" aria-hidden="true" />
        <h2 style={{ margin: 0, fontSize: 22 }}>{d.name}</h2>
      </div>
      <p style={S.sub}>{d.blurb}</p>
      {items.length ? (
        <div style={S.grid}>
          {items.map((l) => (
            <div key={l.id} style={S.card}>
              <b>{l.title}</b>
              <p style={S.muted}>{l.seller}</p>
              <p style={{ ...S.muted, color: 'var(--bw-text, #f2f2f0)' }}>{priceLabel(l)}</p>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ ...S.card, padding: 20, alignItems: 'center', textAlign: 'center' }}>
          <d.Icon size={32} color="var(--bw-accent)" aria-hidden="true" />
          <b>Be the first to sell here</b>
          <p style={S.muted}>Nothing is for sale in {d.name} yet.</p>
        </div>
      )}
      <button type="button" style={{ ...S.btn, width: '100%', marginTop: 16 }} onClick={() => setSoon(true)}>
        {d.sell}
      </button>
      {soon && (
        <p role="status" style={{ ...S.muted, marginTop: 8, textAlign: 'center' }}>
          Selling opens soon. b reviews every listing before it goes live.
        </p>
      )}
      {d.id === 'themes' && ThemeOrderSheet && (
        <button type="button" style={{ ...S.ghost, width: '100%', marginTop: 8 }} onClick={() => setOrdering(true)}>
          Order your own theme edition
        </button>
      )}
      {ordering && ThemeOrderSheet && (
        <Suspense fallback={null}>
          <ThemeOrderSheet onClose={() => setOrdering(false)} />
        </Suspense>
      )}
    </>
  );
}

function Store() {
  const [dept, setDept] = useState<DeptId | null>(null);
  const [query, setQuery] = useState('');
  const open = DEPTS.find((d) => d.id === dept);
  const q = query.trim();
  const shown = useMemo(
    () =>
      q
        ? DEPTS.filter(
            (d) =>
              `${d.name} ${d.blurb}`.toLowerCase().includes(q.toLowerCase()) ||
              LISTINGS.some((l) => d.has(l) && matches(l, q)),
          )
        : DEPTS,
    [q],
  );

  return (
    <div style={{ ...S.page, paddingBottom: 'calc(var(--dock-h, 80px) + 24px)' }}>
      <TopNav />
      <div style={{ paddingTop: 'calc(64px + var(--wallet-inset-top, 0px))' }}>
        <h1 style={S.h1}>bStore</h1>
        <p style={S.sub}>Things for your wallet, paid in BSV.</p>
        <label style={searchBox}>
          <Search size={16} color="var(--bw-muted, #98a2b3)" aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the bStore"
            aria-label="Search the bStore"
            style={{
              flex: 1,
              background: 'transparent',
              border: 0,
              outline: 'none',
              color: 'inherit',
              font: 'inherit',
            }}
          />
        </label>
        {open ? (
          <Department d={open} query={q} onBack={() => setDept(null)} />
        ) : (
          <>
            {shown.length ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {shown.map((d) => {
                  const n = LISTINGS.filter(d.has).length;
                  return (
                    <button key={d.id} type="button" style={deptCard} onClick={() => setDept(d.id)}>
                      <d.Icon size={28} color="var(--bw-accent)" aria-hidden="true" />
                      <b style={{ fontSize: 16 }}>{d.name}</b>
                      <span style={S.muted}>{d.blurb}</span>
                      <span style={{ ...S.muted, marginTop: 'auto' }}>
                        {n ? `${n} for sale` : 'Be the first to sell'}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p style={S.muted}>Nothing matches &ldquo;{q}&rdquo;.</p>
            )}
            <StatusList
              items={[
                ['Departments and search', true],
                ['Buying, paid in BSV', false],
                ['Selling, with every listing reviewed by b', false],
              ]}
            />
          </>
        )}
      </div>
    </div>
  );
}

/** bStore (/m/store, docs/BSTORE.md): departments as big cards, search, each department's products, inside the
 *  app shell (top bar + dock). bWalletX only: ThemeStorePage loads this chunk behind THEME_STORE_PAID_ENABLED. */
export default Store;
