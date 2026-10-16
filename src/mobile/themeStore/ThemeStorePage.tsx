import { lazy, Suspense, useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { THEME_STORE_PAID_ENABLED } from '../storeBuild';
import { useAccentId } from '../theme/useAccent';
import { BUNDLED_PACKS, bundledId, type ThemePack } from '../theme/themePack';
import { applyPack, byTier, fetchCatalog } from './catalog';
import { S } from './styles';
import { PackCard, StatusList } from './ui';

// Premium, Holders and Editions: bWalletX only. A lazy chunk behind the inlined flag, so a store build
// (App Store / Play) has none of their text and shows Free themes only (owner, 16 Oct 2026).
const PaidTabs = THEME_STORE_PAID_ENABLED ? lazy(() => import('./PaidTabs')) : null;

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
 * Theme Store (/m/store, docs/THEME-STORE-PLAN.md steps 3, 5, 9): Free packs apply now. bWalletX also shows
 * Premium (price + coming soon, no payments), Holders (unlock while the wallet holds the token) and Editions
 * (the existing order flow). Layout follows the Name Store: title, one tab bar, a grid of cards.
 */
export default function ThemeStorePage() {
  const { chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey ?? '';
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

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Theme Store</h1>
      <p style={S.sub}>Restyle the whole app. Kept for this account on this device.</p>
      {TABS.length > 1 && (
        <div className="bw-cdes-seg" role="tablist" aria-label="Theme Store" style={{ marginBottom: 16 }}>
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
      {tab === 'free' && (
        <div style={S.grid}>
          {byTier(packs, 'free').map((p) => {
            const on = bundledId(p) === current;
            return (
              <PackCard key={p.id} p={p}>
                <button
                  type="button"
                  style={on ? S.ghost : S.btn}
                  aria-pressed={on}
                  onClick={() => applyPack(account, p)}
                >
                  {on ? 'On' : 'Apply'}
                </button>
              </PackCard>
            );
          })}
        </div>
      )}
      {tab !== 'free' && PaidTabs && (
        <Suspense fallback={null}>
          <PaidTabs tab={tab} packs={packs} account={account} />
        </Suspense>
      )}
      {tab === 'free' && (
        <StatusList
          items={[
            ['Free themes: apply now', true],
            ['Catalog from bwalletx.com, bundled packs offline', true],
          ]}
        />
      )}
    </div>
  );
}
