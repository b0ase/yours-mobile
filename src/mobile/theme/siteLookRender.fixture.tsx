/* eslint-disable react-refresh/only-export-components -- a test page's entry script, never hot-reloaded */
/**
 * Browser fixture for siteLookRender.test.ts (src/testing/siteLookRender.ts bundles it; also the before/after screenshots): the extension's main wallet view,
 * built from the real components (top row, Swap into BSV, wallet card, dock) and worn in a theme through the real
 * path (parseConnectTheme → siteLookAccent → wearSiteLook), so the test reads the colours Chrome actually paints.
 * The test passes the theme in window.__SITE_THEME (null = the user's own Gold) before this script runs.
 */
import { createRoot } from 'react-dom/client';
import { Component, useEffect, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ServiceContext, type ServiceContextProps } from '../../contexts/ServiceContext';
import { SnackbarContext } from '../../contexts/SnackbarContext';
import { PriceCell } from '../wallet/BuyBsv';
import { HistoryButton } from '../wallet/HistoryButton';
import { SwapPromo } from '../swap/SwapPromo';
import { WalletCard } from '../wallet/WalletCard';
import { Dock } from '../phone/Dock';
import { DEFAULT_DOCK } from '../phone/dockModel';
import { parseConnectTheme } from './connectSiteTheme';
import { siteLookAccent } from './siteLook';
import { wearConnectedSiteTheme, wearSiteLook } from './accent';
import type { AccentId } from './accents';

/** `pack`: a bundled pack painted instead of a site theme (for comparing packs before and after a change). */
type Fixture = { theme: Record<string, unknown> | null; identityPubKey: string; pack?: AccentId };
const w = window as unknown as { __SITE_THEME?: Fixture; __READY?: boolean; __ERROR?: string };
const fx: Fixture = w.__SITE_THEME ?? { theme: null, identityPubKey: '' };

const account = {
  name: 'Fixture',
  addresses: { identityAddress: '', bsvAddress: '', ordAddress: '' },
  pubKeys: { identityPubKey: fx.identityPubKey, bsvPubKey: '', ordPubKey: '' },
  settings: {},
};
const services = {
  chromeStorageService: {
    getCurrentAccountObject: () => ({ account }),
    getNetwork: () => 'mainnet',
  },
  isLocked: false,
  isReady: true,
} as unknown as ServiceContextProps;
const snackbar = { addSnackbar: () => undefined, message: null, snackBarType: null };

/**
 * Wears the theme once the view has settled: the card (and the lazy balance carousel's copy of it) switches to the
 * account's own accent when it mounts, as in the app, so the site look goes on after that, and again if a late mount
 * put the account's accent back (the real panel re-wears on its own events).
 */
const Wear = ({ children }: { children: ReactNode }) => {
  useEffect(() => {
    const wear = (): boolean => {
      if (fx.pack) {
        wearConnectedSiteTheme(fx.pack);
        return true;
      }
      if (!fx.theme) return true;
      const p = parseConnectTheme(fx.theme, 'https://fixture.example');
      if (!p.theme) {
        w.__ERROR = p.error ?? 'theme refused';
        return false;
      }
      wearSiteLook(siteLookAccent({ ...p.theme, origin: 'https://fixture.example' }));
      return true;
    };
    let tries = 0;
    const tick = () => {
      const want = fx.pack ?? (fx.theme ? 'custom' : null);
      const worn = want === null || (document.documentElement.dataset.bwTheme ?? 'gold') === want;
      if (worn && tries > 0) {
        w.__READY = true;
        return;
      }
      tries++;
      if (wear()) timer = window.setTimeout(tick, 400);
    };
    let timer = window.setTimeout(tick, 600);
    return () => window.clearTimeout(timer);
  }, []);
  return <>{children}</>;
};

const View = () => (
  <div className="flex flex-col items-center" style={{ width: '100%', minHeight: '100vh', paddingTop: 12 }}>
    <div className="bw-toprow w-[92%] mb-2 flex items-stretch gap-2">
      <PriceCell rate={16.91} change={-1.53} onOpen={() => undefined} />
      <button
        type="button"
        className="flex-1 basis-0 min-w-0 h-14 rounded-xl flex items-center justify-center border cursor-pointer text-sm font-extrabold"
        style={{
          background: 'linear-gradient(135deg, var(--bw-accent-lo), var(--bw-accent-hi))',
          borderColor: 'rgb(var(--bw-accent-rgb)/0.4)',
          color: 'var(--bw-on-accent)',
        }}
      >
        Buy BSV
      </button>
      <HistoryButton className="flex-1 basis-0 min-w-0 h-14 rounded-xl flex items-center justify-center border cursor-pointer" />
    </div>
    <div className="bw-swaprow w-[92%] -mb-1 flex items-stretch gap-2">
      <SwapPromo active={null} onOpen={() => undefined} />
    </div>
    <div style={{ width: '100%', marginTop: 12 }}>
      <WalletCard
        usd={2.24}
        sats={13_218_787}
        view="amount"
        syncing={false}
        failed={false}
        onRetry={() => undefined}
        receiveAddress="15L4pSDd6dACXXmqZaosFyabAuSX8a7C3x"
        rate={16.91}
      />
    </div>
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, height: 88 }}>
      <Dock
        items={[...DEFAULT_DOCK]}
        labels={{}}
        activeKey="screen:wallet"
        badges={{}}
        onOpen={() => undefined}
        onHome={() => undefined}
        onAgent={() => undefined}
        onChange={() => undefined}
        onAdd={() => undefined}
        pageKey="wallet"
      />
    </div>
  </div>
);

/** A render error fails the test with its message instead of an empty page. */
class Catch extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    w.__ERROR = String(e);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

try {
  createRoot(document.getElementById('root') as HTMLElement).render(
    <Catch>
      <MemoryRouter>
        <ServiceContext.Provider value={services}>
          <SnackbarContext.Provider value={snackbar}>
            <Wear>
              <View />
            </Wear>
          </SnackbarContext.Provider>
        </ServiceContext.Provider>
      </MemoryRouter>
    </Catch>,
  );
} catch (e) {
  w.__ERROR = String(e);
}
