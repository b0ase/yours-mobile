import { lazy, Suspense, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { BCREDITS_ENABLED, THEME_ORDERS_ENABLED } from '../storeBuild';
import {
  ALLOWED_CATEGORIES,
  PROHIBITED,
  draftToListing,
  feeSplitLabel,
  priceLabel,
  visible,
  type Draft,
  type Listing,
  type Period,
} from './bstore';
import { S } from './styles';
import { Empty, StatusList } from './ui';

// The existing "Get your own edition" order flow ($99 a year), itself bWalletX only.
const ThemeOrderSheet = THEME_ORDERS_ENABLED ? lazy(() => import('../themeOrder/ThemeOrderSheet')) : null;

export type PaidSection = 'subscriptions' | 'credits' | 'stickers' | 'services' | 'community';

/**
 * bStore sections beyond Themes and Names (bWalletX only: a lazy chunk behind THEME_STORE_PAID_ENABLED, so a
 * store build has none of this text). No money moves here yet: paying shows "Coming" (docs/BSTORE.md).
 */
export default function Sections({ section, account }: { section: PaidSection; account: string }) {
  if (section === 'subscriptions') return <Subscriptions />;
  if (section === 'credits') return <Credits />;
  if (section === 'stickers') return <Stickers />;
  if (section === 'services') return <Services />;
  return <Community account={account} />;
}

const fee = <p style={{ ...S.muted, margin: '0 0 12px' }}>{feeSplitLabel()} (configurable)</p>;
const tag: CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--bw-muted, #98a2b3)',
  border: '1px solid var(--bw-line, #2b2f36)',
  borderRadius: 6,
  padding: '1px 6px',
};

function ListingCard({ l, onReport }: { l: Listing; onReport?: () => void }) {
  return (
    <div style={S.card}>
      {l.example && <span style={tag}>Example</span>}
      <div>
        <b style={{ display: 'block' }}>{l.title}</b>
        <p style={S.muted}>{l.seller}</p>
      </div>
      <p style={{ ...S.muted, color: 'var(--bw-text, #f2f2f0)' }}>{l.description}</p>
      {l.perks && l.perks.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {l.perks.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <p style={{ margin: 0, fontWeight: 700 }}>
        {priceLabel(l)} <span style={S.muted}>· paid in BSV</span>
      </p>
      <button type="button" style={S.ghost} disabled>
        {l.type === 'subscription' ? 'Subscribe · Coming' : 'Buy · Coming'}
      </button>
      {onReport && (
        <button type="button" style={{ ...S.ghost, fontSize: 12, padding: '4px 8px' }} onClick={onReport}>
          Report
        </button>
      )}
    </div>
  );
}

function Subscriptions() {
  // Listings come from the server once it exists (docs/BSTORE.md); none yet, and no placeholder items.
  const live: Listing[] = [];
  return (
    <>
      <p style={S.sub}>Pay per day, week or month. Prices in USD, settled in BSV. Cancel anytime.</p>
      {fee}
      {live.length ? (
        <div style={S.grid}>
          {live.map((l) => (
            <ListingCard key={l.id} l={l} />
          ))}
        </div>
      ) : (
        <Empty title="No subscriptions yet">Sellers list memberships and plans here once selling opens.</Empty>
      )}
      <StatusList
        items={[
          ['Subscription listings (seller, price per period, perks)', true],
          ['Subscribe and pay in BSV', false],
          ['Renewals from your pots, cancel anytime', false],
        ]}
      />
    </>
  );
}

function Credits() {
  return (
    <>
      <p style={S.sub}>bCredits pay for b replies. Top up with BSV.</p>
      {BCREDITS_ENABLED && (
        <Link to="/m/credits" style={{ ...S.btn, display: 'inline-block', textDecoration: 'none' }}>
          Top up bCredits
        </Link>
      )}
      <StatusList items={[['bCredits top-up', BCREDITS_ENABLED]]} />
    </>
  );
}

function Stickers() {
  return (
    <>
      <p style={S.sub}>Sticker and emoji packs for chat, from bCorp and from creators.</p>
      {fee}
      <Empty title="No sticker packs yet">Packs appear here when they go on sale.</Empty>
      <StatusList
        items={[
          ['Sticker & emoji packs', false],
          ['Creators list their own packs (Community)', true],
        ]}
      />
    </>
  );
}

function Services() {
  const [ordering, setOrdering] = useState(false);
  return (
    <>
      <div style={S.grid}>
        <div style={S.card}>
          <b>Theme edition</b>
          <p style={S.muted}>Your own theme for your brand, band or community, made for you. $99 a year.</p>
          {ThemeOrderSheet && (
            <button type="button" style={S.btn} onClick={() => setOrdering(true)}>
              Order
            </button>
          )}
        </div>
        <div style={S.card}>
          <b>Business agent</b>
          <p style={S.muted}>A b agent for your business that answers customers in your room.</p>
          <Link to="/m/chat" style={{ ...S.ghost, textAlign: 'center', textDecoration: 'none' }}>
            Set up in a room
          </Link>
        </div>
      </div>
      {ThemeOrderSheet && ordering && (
        <Suspense fallback={null}>
          <ThemeOrderSheet onClose={() => setOrdering(false)} />
        </Suspense>
      )}
      <StatusList
        items={[
          ['Order a theme edition', !!ThemeOrderSheet],
          ['Business agent in your room', true],
          ['Design & dev services from sellers (Community)', true],
        ]}
      />
    </>
  );
}

function Community({ account }: { account: string }) {
  const [selling, setSelling] = useState(false);
  const [reported, setReported] = useState<string | null>(null);
  // Listings come from bit-sign once the endpoints exist (docs/BSTORE.md); none yet.
  const listings = visible([]);
  return (
    <>
      <p style={S.sub}>Digital goods and services from other people. b reviews every listing before it goes live.</p>
      {fee}
      <button type="button" style={{ ...S.btn, marginBottom: 16 }} onClick={() => setSelling(true)}>
        Sell something
      </button>
      {listings.length ? (
        <div style={S.grid}>
          {listings.map((l) => (
            <ListingCard key={l.id} l={l} onReport={() => setReported(l.id)} />
          ))}
        </div>
      ) : (
        <Empty title="No community listings yet">Be the first: tap Sell something.</Empty>
      )}
      {reported && <p style={S.muted}>Reported. b will take a look.</p>}
      {selling && <SellSheet account={account} onClose={() => setSelling(false)} />}
      <StatusList
        items={[
          ['Draft a listing (saved on this device)', true],
          ['Submit for review by b', false],
          ['Live community listings', false],
          ['Report a listing', false],
        ]}
      />
    </>
  );
}

const field: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--bw-card, #17191e)',
  color: 'var(--bw-text, #f2f2f0)',
  border: '1px solid var(--bw-line, #2b2f36)',
  borderRadius: 10,
  padding: '8px 10px',
  font: 'inherit',
  marginBottom: 10,
};

function SellSheet({ account, onClose }: { account: string; onClose: () => void }) {
  const [d, setD] = useState<Draft>({
    seller: account,
    category: '',
    title: '',
    description: '',
    images: [],
    price: '',
    type: 'one-off',
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const saveDraft = () => {
    const r = draftToListing(d, `draft-${Date.now()}`);
    setErrors(r.errors);
    if (!r.listing) return;
    // Nothing is sent: the server (docs/BSTORE.md) does not exist yet. The draft is kept on this device only.
    try {
      localStorage.setItem('bwallet.bstore.draft', JSON.stringify(r.listing));
      setSaved(true);
    } catch {
      setErrors(['Could not save the draft on this device.']);
    }
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Sell something"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          ...S.page,
          minHeight: 0,
          width: '100%',
          maxWidth: 560,
          maxHeight: '90vh',
          overflowY: 'auto',
          borderRadius: '16px 16px 0 0',
          padding: '20px 16px 32px',
        }}
      >
        <h2 style={{ margin: '0 0 8px', fontSize: 20 }}>Sell something</h2>
        <>
          <p style={S.muted}>Digital goods and services only. {feeSplitLabel()}.</p>
          <div style={{ ...S.card, margin: '12px 0' }}>
            <b>Not allowed</b>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {PROHIBITED.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
          <select
            aria-label="Category"
            style={field}
            value={d.category}
            onChange={(e) => set({ category: e.target.value })}
          >
            <option value="">Category…</option>
            {ALLOWED_CATEGORIES.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <input
            aria-label="Title"
            placeholder="Title"
            style={field}
            value={d.title}
            onChange={(e) => set({ title: e.target.value })}
          />
          <textarea
            aria-label="Description"
            placeholder="What buyers get"
            rows={4}
            style={field}
            value={d.description}
            onChange={(e) => set({ description: e.target.value })}
          />
          <div className="bw-cdes-seg" role="tablist" aria-label="Type" style={{ marginBottom: 10 }}>
            {(['one-off', 'subscription'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={d.type === t}
                className={d.type === t ? 'on' : ''}
                onClick={() => set({ type: t })}
              >
                {t === 'one-off' ? 'One-off' : 'Subscription'}
              </button>
            ))}
          </div>
          <input
            aria-label="Price in USD"
            placeholder="Price (USD, paid in BSV)"
            inputMode="decimal"
            style={field}
            value={d.price}
            onChange={(e) => set({ price: e.target.value })}
          />
          {d.type === 'subscription' && (
            <>
              <select
                aria-label="Period"
                style={field}
                value={d.period ?? ''}
                onChange={(e) => set({ period: (e.target.value || undefined) as Period | undefined })}
              >
                <option value="">Per…</option>
                <option value="day">day</option>
                <option value="week">week</option>
                <option value="month">month</option>
              </select>
              <textarea
                aria-label="Perks"
                placeholder="Perks, one per line"
                rows={3}
                style={field}
                value={d.perks ?? ''}
                onChange={(e) => set({ perks: e.target.value })}
              />
            </>
          )}
          {saved && <p style={S.muted}>Draft saved on this device. Not sent: selling opens soon.</p>}
          {errors.length > 0 && (
            <ul role="alert" style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 13 }}>
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={S.btn} onClick={saveDraft}>
              Save draft
            </button>
            <button type="button" style={S.ghost} disabled>
              Selling opens soon
            </button>
            <button type="button" style={S.ghost} onClick={onClose}>
              Close
            </button>
          </div>
        </>
      </div>
    </div>
  );
}
