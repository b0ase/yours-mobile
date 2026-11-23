import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { FileSignature } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { badgeLabel, badgeText } from '../tabs/tabBadges';
import { setSignedBadge, useSignedBadge } from './badge';
import { heldFor, readHeldSeals } from './held';
import { loadCachedSync, loadLocal, onSignedChange } from './localStore';
import { installSignedRecorder } from './recorder';
import { quietSyncDue, syncSigned } from './sync';
import { sessionGet, sessionHandle } from './session';
import { badgeCount, mergeRows } from './signedList';

/**
 * The always-on half of Signed (bWalletX builds only; mobile, web.bwalletx.com and the extension all use these mounts,
 * vite.config.mobile.ts MOBILE_SWAPS):
 *   - SignedRecorder, mounted by MobileRoutes (every /m/* screen, the Sign page included): installs the recorder
 *     (signed/recorder.ts) with the router's live path, so every seal this device records lands in the wallet's list;
 *   - SignedBadgeKeeper, mounted by the top bar (tabs/TopNav.tsx): keeps the ☰ › Signed badge current (waiting for me
 *     + held) and runs a quiet sync with bit-sign at most every 5 minutes, ONLY when a bChatX session already exists
 *     (it never signs in by itself).
 */
const useIdentityKey = (): string => {
  const { chromeStorageService } = useServiceContext();
  return chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey ?? '';
};

export const refreshSignedBadge = (identityKey: string): void => {
  if (!identityKey) return setSignedBadge(0);
  const rows = mergeRows(loadLocal(identityKey), loadCachedSync(identityKey)?.rows ?? []);
  setSignedBadge(badgeCount(rows, new Set(heldFor(identityKey, readHeldSeals()).map((p) => p.documentId)).size));
};

export const SignedRecorder = () => {
  const { pathname } = useLocation();
  const identityKey = useIdentityKey();
  const path = useRef(pathname);
  const key = useRef(identityKey);
  path.current = pathname;
  key.current = identityKey;
  installSignedRecorder({ path: () => path.current, identityKey: () => key.current });
  return null;
};

export const SignedBadgeKeeper = () => {
  const { pathname } = useLocation();
  const identityKey = useIdentityKey();
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
    if (quietSyncDue(identityKey, !!get)) void syncSigned(identityKey, get, sessionHandle());
  }, [identityKey, pathname]);
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
