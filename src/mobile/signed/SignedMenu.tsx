import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { FileSignature } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getChatAccount } from '../chat/chatAccount';
import { badgeLabel, badgeText } from '../tabs/tabBadges';
import { useSignedBadge } from './badge';
import { onSignedChange } from './localStore';
import { installSignedRecorder } from './recorder';
import { syncSigned } from './sync';
import { sessionGet, sessionHandle } from './session';
import { refreshSignedBadge } from './refresh';

/**
 * The always-on half of Signed (bWalletX builds only; mobile, web.bwalletx.com and the extension all use these mounts,
 * vite.config.mobile.ts MOBILE_SWAPS):
 *   - SignedRecorder, mounted by MobileRoutes (every /m/* screen, the Sign page included): installs the recorder
 *     (signed/recorder.ts), so every seal this device records lands in the wallet's list;
 *   - SignedBadgeKeeper, mounted by the top bar (tabs/TopNav.tsx): keeps the ☰ › Signed badge current (waiting for me
 *     + this account's held documents) and runs the shared sync with bit-sign (sync.ts: at most once per 5 minutes per
 *     account, failures included), ONLY when a bChatX session already exists (it never signs in by itself).
 */
const useIdentityKey = (): string => {
  const { chromeStorageService } = useServiceContext();
  return chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey ?? '';
};
const useIdentityAddress = (): string => {
  const { chromeStorageService } = useServiceContext();
  return chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
};

export const SignedRecorder = () => {
  installSignedRecorder();
  return null;
};

export const SignedBadgeKeeper = () => {
  const { pathname } = useLocation();
  const identityKey = useIdentityKey();
  const identityAddress = useIdentityAddress();
  useEffect(() => {
    refreshSignedBadge(identityKey);
    const off = onSignedChange(() => refreshSignedBadge(identityKey));
    const onStorage = () => refreshSignedBadge(identityKey);
    window.addEventListener('storage', onStorage);
    return () => {
      off();
      window.removeEventListener('storage', onStorage);
    };
  }, [identityKey]);
  // Leaving the Sign page (a seal held or finished) and every other move re-reads the held seals.
  useEffect(() => {
    refreshSignedBadge(identityKey);
    const get = sessionGet();
    if (identityKey && get)
      void syncSigned(identityKey, get, sessionHandle(), {
        account: { account: identityAddress, chatAccount: getChatAccount },
      });
  }, [identityKey, identityAddress, pathname]);
  return null;
};

/** ☰ › Signed: a top-level row in the account menu, with the waiting-for-me badge. */
export const SignedMenuRow = ({ onOpen }: { onOpen: () => void }) => {
  const n = useSignedBadge();
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="menu-signed"
      aria-label={badgeLabel('Signed', n)}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left border-0 bg-transparent active:bg-white/5"
    >
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
        style={{ background: 'rgb(var(--bw-accent-rgb) / 0.16)' }}
      >
        <FileSignature size={16} color="var(--bw-accent)" />
      </span>
      <span className="min-w-0 flex-1 text-sm font-semibold text-white">Signed</span>
      {n > 0 && (
        <span
          aria-hidden
          className="min-w-[20px] rounded-full px-1.5 text-center text-[11px] font-bold leading-5"
          style={{ background: 'var(--bw-accent)', color: 'var(--bw-on-accent)' }}
        >
          {badgeText(n)}
        </span>
      )}
    </button>
  );
};
