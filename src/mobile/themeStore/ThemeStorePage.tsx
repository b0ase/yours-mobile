import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useServiceContext } from '../../hooks/useServiceContext';
import { THEME_STORE_PAID_ENABLED } from '../storeBuild';
import { useAccentId } from '../theme/useAccent';
import { BUNDLED_PACKS, bundledId, type ThemePack } from '../theme/themePack';
import { applyPack, byTier, fetchCatalog } from './catalog';
import { S } from './styles';
import { PackCard, PreviewSheet, StatusList } from './ui';

// Premium, Holders and Editions: bWalletX only. A lazy chunk behind the inlined flag, so a store build
// (App Store / Play) has none of their text and shows Free themes only (owner, 16 Oct 2026).
const PaidTabs = THEME_STORE_PAID_ENABLED ? lazy(() => import('./PaidTabs')) : null;
// Subscriptions, Credits, Stickers, Services, Community: same gate, same reason (docs/BSTORE.md).
const Sections = THEME_STORE_PAID_ENABLED ? lazy(() => import('./Sections')) : null;

type Section = 'themes' | 'names' | 'subscriptions' | 'credits' | 'stickers' | 'services' | 'community';
// A 2-column grid of category tiles (no sideways-scrolling filter row). Store builds: free Themes only (owner), no tiles.
const SECTIONS: readonly (readonly [Section, string])[] = THEME_STORE_PAID_ENABLED
  ? [
      ['themes', 'Themes'],
      ['subscriptions', 'Subscriptions'],
      ['names', 'Names'],
      ['credits', 'Credits'],
      ['stickers', 'Stickers & emoji'],
      ['services', 'Services'],
      ['community', 'Community'],
    ]
  : [['themes', 'Themes']];

export type StoreTab = 'free' | 'premium' | 'holders' | 'editions';
const TABS: readonly (readonly [StoreTab, string])[] = THEME_STORE_PAID_ENABLED
  ? [
      ['free', 'Free'],
      ['premium', 'Premium'],
      ['holders', 'Holders'],
      ['editions', 'Editions'],
    ]
  : [['free', 'Free']];

/**
 * bStore (/m/store, docs/BSTORE.md): our things for BSV plus reviewed community listings. Themes section is the
 * former Theme Store (/m/store, docs/THEME-STORE-PLAN.md steps 3, 5, 9): Free packs apply now. bWalletX also shows
 * Premium (price + coming soon, no payments), Holders (unlock while the wallet holds the token) and Editions
 * (the existing order flow). Layout follows the Name Store: title, one tab bar, a grid of cards.
 */
export default function ThemeStorePage() {
  const { chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey ?? '';
  const [section, setSection] = useState<Section>('themes');
  const [tab, setTab] = useState<StoreTab>('free');
  const [packs, setPacks] = useState<ThemePack[]>(() => [...BUNDLED_PACKS]);
  const current = useAccentId();
  useEffect(() => {
    let live = true;
    void fetchCatalog().then((p) => live && setPacks(p));
    return () => {
      live = false;
    };
  }, []);

  const [open, setOpen] = useState<ThemePack | null>(null);
  const inUse = (p: ThemePack) => bundledId(p) === current;
  const apply = (p: ThemePack, on = inUse(p)) => (
    <button
      type="button"
      style={{ ...(on ? S.ghost : S.btn), width: '100%' }}
      disabled={on}
      aria-pressed={on}
      onClick={() => applyPack(account, p)}
    >
      {on ? 'In use' : 'Apply'}
    </button>
  );

  return (
    <div style={S.page}>
      <header style={S.head}>
        <h1 style={S.h1}>bStore</h1>
        <p style={{ ...S.sub, margin: 0 }}>Things for your wallet, paid in BSV.</p>
      </header>
      {SECTIONS.length > 1 && (
        <div role="tablist" aria-label="bStore sections" style={S.tiles}>
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={section === id}
              style={section === id ? S.tileOn : S.tile}
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {section === 'names' && (
        <div style={{ ...S.card, padding: 16 }}>
          <b>Names</b>
          <p style={S.muted}>Search, buy, claim and give names.</p>
          <Link to="/m/names" style={{ ...S.btn, textAlign: 'center', textDecoration: 'none' }}>
            Open the Name Store
          </Link>
        </div>
      )}
      {section !== 'themes' && section !== 'names' && Sections && (
        <Suspense fallback={null}>
          <Sections section={section} account={account} />
        </Suspense>
      )}
      {section === 'themes' && <p style={S.sub}>Restyle the whole app. Tap a theme to preview it.</p>}
      {section === 'themes' && TABS.length > 1 && (
        <div className="bw-cdes-seg" role="tablist" aria-label="Themes" style={{ marginBottom: 16 }}>
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'on' : ''}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {section === 'themes' && tab === 'free' && (
        <div style={S.grid}>
          {byTier(packs, 'free').map((p) => (
            <PackCard key={p.id} p={p} inUse={inUse(p)} price="Free" onOpen={() => setOpen(p)}>
              {apply(p)}
            </PackCard>
          ))}
        </div>
      )}
      {open && (
        <PreviewSheet p={open} inUse={inUse(open)} price="Free" onClose={() => setOpen(null)}>
          {apply(open)}
        </PreviewSheet>
      )}
      {section === 'themes' && tab !== 'free' && PaidTabs && (
        <Suspense fallback={null}>
          <PaidTabs tab={tab} packs={packs} account={account} />
        </Suspense>
      )}
      {section === 'themes' && tab === 'free' && (
        <StatusList
          items={[
            ['Free themes: apply now, kept for this account on this device', true],
            ['Catalog from bwalletx.com, bundled packs offline', true],
          ]}
        />
      )}
    </div>
  );
}
