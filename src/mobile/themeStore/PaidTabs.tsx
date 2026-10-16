import { lazy, Suspense, useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { walletHoldings } from '../chat/holdings';
import type { Holding } from '../chat/tokenRooms';
import { THEME_ORDERS_ENABLED } from '../storeBuild';
import { holderUnlocked, type ThemePack } from '../theme/themePack';
import { applyPack, byTier } from './catalog';
import type { StoreTab } from './ThemeStorePage';
import { S } from './styles';
import { Empty, PackCard, PreviewSheet, StatusList } from './ui';

// The existing "Get your own edition" order flow ($99 a year), itself bWalletX only.
const ThemeOrderSheet = THEME_ORDERS_ENABLED ? lazy(() => import('../themeOrder/ThemeOrderSheet')) : null;

/**
 * Theme Store tabs beyond Free (bWalletX only, never in a store build: THEME_STORE_PAID_ENABLED).
 * No money moves here: Premium shows the price and "Coming soon"; Holders unlock free while the wallet holds the
 * token; Editions opens the existing order flow.
 */
export default function PaidTabs({ tab, packs, account }: { tab: StoreTab; packs: ThemePack[]; account: string }) {
  if (tab === 'premium') return <Premium packs={byTier(packs, 'premium')} />;
  if (tab === 'holders') return <Holders packs={byTier(packs, 'holder')} account={account} />;
  if (tab === 'editions') return <Editions packs={byTier(packs, 'edition')} />;
  return null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function Premium({ packs }: { packs: ThemePack[] }) {
  const [open, setOpen] = useState<ThemePack | null>(null);
  return (
    <>
      {packs.length ? (
        <div style={S.grid}>
          {packs.map((p) => (
            <PackCard key={p.id} p={p} price={p.price_usd ? usd(p.price_usd) : undefined} onOpen={() => setOpen(p)}>
              <button type="button" style={{ ...S.ghost, width: '100%' }} disabled>
                Buy · Coming soon
              </button>
            </PackCard>
          ))}
        </div>
      ) : (
        <Empty title="No premium themes yet">Themes from creators, about $1 each, paid to the creator.</Empty>
      )}
      {open && (
        <PreviewSheet
          p={open}
          inUse={false}
          price={open.price_usd ? usd(open.price_usd) : undefined}
          onClose={() => setOpen(null)}
        >
          <button type="button" style={S.ghost} disabled>
            Buy · Coming soon (paid to the creator)
          </button>
        </PreviewSheet>
      )}
      <StatusList
        items={[
          ['Premium catalog and prices', true],
          ['Buy a premium theme (paid to the creator)', false],
          ['Creator submissions', false],
        ]}
      />
    </>
  );
}

function Holders({ packs, account }: { packs: ThemePack[]; account: string }) {
  const { apiContext } = useServiceContext();
  const [held, setHeld] = useState<Holding[] | null>(null);
  useEffect(() => {
    let live = true;
    void walletHoldings(apiContext)
      .then((h) => live && setHeld(h))
      .catch(() => live && setHeld([]));
    return () => {
      live = false;
    };
  }, [apiContext]);
  return (
    <>
      {packs.length ? (
        <div style={S.grid}>
          {packs.map((p) => {
            const open = held ? holderUnlocked(p, held) : false;
            return (
              <PackCard key={p.id} p={p} price={p.token ? `$${p.token.symbol}` : undefined}>
                {open ? (
                  <button type="button" style={{ ...S.btn, width: '100%' }} onClick={() => applyPack(account, p)}>
                    Apply
                  </button>
                ) : (
                  <p style={S.muted}>
                    {held ? `Unlocks for ${p.token?.symbol ?? 'token'} holders` : 'Checking your tokens…'}
                  </p>
                )}
              </PackCard>
            );
          })}
        </div>
      ) : (
        <Empty title="No token themes yet">Token themes unlock free while your wallet holds the token.</Empty>
      )}
      <StatusList
        items={[
          ['Unlock while you hold the token', true],
          ['Token issuers list their own themes', false],
        ]}
      />
    </>
  );
}

function Editions({ packs }: { packs: ThemePack[] }) {
  const [ordering, setOrdering] = useState(false);
  return (
    <>
      {packs.length > 0 && (
        <div style={{ ...S.grid, marginBottom: 16 }}>
          {packs.map((p) => (
            <PackCard key={p.id} p={p} price="Edition" />
          ))}
        </div>
      )}
      <p style={S.sub}>Your own theme for your brand, band or community, made for you.</p>
      {ThemeOrderSheet && (
        <button type="button" style={S.btn} onClick={() => setOrdering(true)}>
          Get your own edition · $99 a year
        </button>
      )}
      {ThemeOrderSheet && ordering && (
        <Suspense fallback={null}>
          <ThemeOrderSheet onClose={() => setOrdering(false)} />
        </Suspense>
      )}
      <StatusList
        items={[
          ['Order your own edition', !!ThemeOrderSheet],
          ['Live editions listed here', false],
        ]}
      />
    </>
  );
}
