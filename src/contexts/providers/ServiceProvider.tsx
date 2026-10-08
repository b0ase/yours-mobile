import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ChromeStorageService } from '../../services/ChromeStorage.service';
import { KeysService } from '../../services/Keys.service';
import { INACTIVITY_LIMIT } from '../../utils/constants';
import { ServiceContext, ServiceContextProps } from '../ServiceContext';
import { createContext } from '@1sat/actions';
import { fetchExchangeRate } from '../../utils/wallet';
import { createChromeCWI, OneSatServices } from '@1sat/wallet-browser';
import { gateWalletOnUsb } from '../../services/usbPresence';
import { setChatAccount } from '../../mobile/chat/chatAccount';

const initializeServices = async (onUsbRemoved: () => void) => {
  const chromeStorageService = new ChromeStorageService();
  // Startup timing (owner, 6 Oct 2026: 40 s blank side panel). Logged so a slow start can be diagnosed from the console.
  const t0 = performance.now();
  const all = await chromeStorageService.getAndSetStorage();
  try {
    const bytes = JSON.stringify(all ?? {}).length;
    console.info(`[startup] storage read ${Math.round(performance.now() - t0)} ms, ${Object.keys(all ?? {}).length} keys, ~${Math.round(bytes / 1024)} KB`);
  } catch {
    /* size is diagnostics only */
  }

  const keysService = new KeysService(chromeStorageService);

  // Create context using ChromeCWI (communicates with service worker via chrome.runtime.sendMessage)
  // USB key security: spend/sign calls from this page first confirm a
  // registered stick is present; two misses in a row lock the wallet.
  const chromeCWI = gateWalletOnUsb(createChromeCWI(), chromeStorageService, onUsbRemoved);
  const chain = 'main' as const;
  const services = new OneSatServices(chain);
  // chromeCWI is the gated background wallet — module owns apply.
  const apiContext = createContext(chromeCWI, {
    chain,
    services,
    isBaseWallet: false,
  });

  return {
    chromeStorageService,
    keysService,
    apiContext,
  };
};

export const ServiceProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [services, setServices] = useState<Partial<ServiceContextProps>>({});
  const [isLocked, setIsLocked] = useState<boolean>(true); // Start locked until checkLockState runs
  const [isReady, setIsReady] = useState<boolean>(false);
  const [isSwitchingAccount, setIsSwitchingAccount] = useState<boolean>(false);
  const prevIsLockedRef = useRef<boolean | null>(null);
  const lockRef = useRef<() => void>(() => setIsLocked(true));
  useEffect(() => {
    if (services?.chromeStorageService) {
      const timestamp = Date.now();
      const twentyMinutesAgo = timestamp - 20 * 60 * 1000;
      services.chromeStorageService.update({ lastActiveTime: isLocked ? twentyMinutesAgo : timestamp, isLocked });
      // Notify background to destroy decrypted keys only on actual lock transitions,
      // not on initial render (where isLocked starts as true before checkLockState runs)
      if (isLocked && prevIsLockedRef.current === false) {
        chrome.runtime.sendMessage({ action: 'WALLET_LOCKED' }).catch(() => {});
      }
      prevIsLockedRef.current = isLocked;
    }
  }, [isLocked, services?.chromeStorageService]);

  useEffect(() => {
    const initServices = async () => {
      try {
        const initializedServices = await initializeServices(() => lockRef.current());
        const { chromeStorageService, apiContext } = initializedServices;
        const { account, lastActiveTime, selectedAccount } = chromeStorageService.getCurrentAccountObject();
        // bit-sign sessions are per account: every bChat call acts as the ACTIVE account.
        setChatAccount(selectedAccount);

        // Unlocked only with session passKey AND within inactivity window.
        // lastActiveTime alone must not unlock (passKey is cleared on restart).
        if (!account?.encryptedKeys) {
          setIsLocked(false);
        } else {
          const passKey = await chromeStorageService.getPassKey();
          const withinTimeout =
            !!lastActiveTime && Date.now() - Number(lastActiveTime) <= chromeStorageService.getLockTimeout();
          setIsLocked(!(passKey && withinTimeout));
        }

        if (account) {
          // Pre-fetch exchange rate to cache it. In the background: awaiting it held the whole UI blank while
          // WhatsOnChain was slow or rate-limited (owner, 6 Oct 2026: a 40 s blank side panel). Prices fill in after.
          void fetchExchangeRate(apiContext.chain, apiContext.wocApiKey).catch(() => undefined);
        }

        setServices({ ...initializedServices, isLocked, isReady, lockWallet });
        setIsReady(true);
      } catch (error) {
        console.error('Error initializing services:', error);
      }
    };
    initServices();
    return () => {
      // Legacy cleanup — `walletImporting` was used by the old SyncBanner to show
      // an "Initializing..." state. Banner is gone, but clearing stale values in
      // long-time-user browsers is harmless.
      localStorage.removeItem('walletImporting');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Address/message sync runs in the service worker on unlock (initWallet).
  // Do not also run it here — concurrent popup+SW sync races storage.

  const lockWallet = useCallback(async () => {
    if (!isReady) return;
    setIsLocked(true);
  }, [isReady]);
  lockRef.current = () => setIsLocked(true);

  useEffect(() => {
    const checkLockState = async () => {
      if (!isReady || !services?.chromeStorageService) return;
      try {
        const chromeStorageService = services.chromeStorageService;
        await chromeStorageService.getAndSetStorage();
        const result = chromeStorageService.getCurrentAccountObject();
        setChatAccount(result?.selectedAccount);
        const lastActiveTime = result?.lastActiveTime;
        const timeout = chromeStorageService.getLockTimeout() ?? INACTIVITY_LIMIT;

        if (!result?.account?.encryptedKeys) {
          setIsLocked(false);
          return;
        }

        const passKey = await chromeStorageService.getPassKey();
        const timedOut = !lastActiveTime || Date.now() - Number(lastActiveTime) > timeout;

        if (timedOut || !passKey) {
          lockWallet();
        } else {
          setIsLocked(false);
        }
      } catch (error) {
        console.error('Error checking lock state:', error);
      }
    };

    checkLockState();

    const interval = setInterval(checkLockState, 5000);

    return () => {
      clearInterval(interval);
    };
  }, [lockWallet, isReady, services]);

  return (
    <ServiceContext.Provider
      value={
        {
          ...services,
          isLocked,
          setIsLocked,
          isReady,
          lockWallet,
          isSwitchingAccount,
          setIsSwitchingAccount,
        } as ServiceContextProps
      }
    >
      {children}
    </ServiceContext.Provider>
  );
};
