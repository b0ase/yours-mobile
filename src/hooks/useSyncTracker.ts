import { useEffect, useState, useRef } from 'react';
import { YoursEventName } from '../inject';
import { useTheme } from './useTheme';
import { BALANCE_REFRESH_EVENT } from './balanceRefresh';

export type SyncStatusMessage = {
  action: YoursEventName.SYNC_STATUS_UPDATE;
  data:
    | { status: 'start'; addressCount: number }
    | {
        status: 'progress';
        pending: number;
        done: number;
        failed: number;
        message?: string;
        part?: 'scan' | 'coins' | 'names';
        total?: number;
      }
    | { status: 'coins-ready'; found: number; failed: number }
    | { status: 'complete' }
    | { status: 'error'; message: string }
    | { status: 'restoring'; message: string }
    | { status: 'restored'; ok: boolean };
};

/** Safety net — if we see `start` but no `complete` arrives in this window,
 *  assume the sync finished (or the message was dropped) and stop spinning. */
const SYNC_STUCK_TIMEOUT_MS = 30_000;

export const useSyncTracker = () => {
  const { theme } = useTheme();
  const [pendingCount, setPendingCount] = useState(0);
  const [updateBalance, setUpdateBalance] = useState(false);
  /** Bumped on every finished sync and every requestBalanceRefresh(). `updateBalance` latches at true after the
   *  first sync, so later quiet resyncs never re-ran the balance read through it (latency audit, 15 Oct 2026). */
  const [balanceTick, setBalanceTick] = useState(0);
  // Default to false — the spinner should only appear if we actively observe
  // a sync happening. Otherwise the UI can get stuck when the popup mounts
  // after the service worker already finished (or dropped) its `complete` event.
  const [isSyncing, setIsSyncing] = useState(false);
  /** "Loading your wallet from backup…" while a new device copies the remote store (restore, 14 Oct 2026). */
  const [restoreMessage, setRestoreMessage] = useState('');
  /** What the sync is doing right now, from the wallet's own counts: "Loading names 1,200 of 3,400". */
  const [syncMessage, setSyncMessage] = useState('');
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const completeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const stuckTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const clearAllTimers = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (completeTimeoutRef.current) {
        clearTimeout(completeTimeoutRef.current);
        completeTimeoutRef.current = null;
      }
      if (stuckTimeoutRef.current) {
        clearTimeout(stuckTimeoutRef.current);
        stuckTimeoutRef.current = null;
      }
    };

    const finishSync = () => {
      setUpdateBalance(true);
      setBalanceTick((n) => n + 1);
      setIsSyncing(false);
      setPendingCount(0);
      setSyncMessage('');
      clearAllTimers();
    };
    const armStuck = () => {
      if (stuckTimeoutRef.current) clearTimeout(stuckTimeoutRef.current);
      stuckTimeoutRef.current = setTimeout(() => {
        console.warn('[syncTracker] No sync news within safety window — stopping spinner.');
        finishSync();
      }, SYNC_STUCK_TIMEOUT_MS);
    };

    const handleMessage = (message: SyncStatusMessage) => {
      if (message.action !== YoursEventName.SYNC_STATUS_UPDATE) return;

      const { data } = message;

      switch (data.status) {
        case 'start':
          setIsSyncing(true);
          if (!intervalRef.current) {
            intervalRef.current = setInterval(() => {
              setUpdateBalance((prev) => !prev);
            }, 5000);
          }
          // Armed once per sync, not re-armed by each 'start': overlapping 'start's (startup sync and a refresh) used to
          // keep the card's sync spinner going for good (owner, 6 Oct 2026). The background resync every minute is
          // quiet (services/addressResync.ts): it sends no 'start', only 'complete', which refreshes the balance.
          if (!stuckTimeoutRef.current)
            stuckTimeoutRef.current = setTimeout(() => {
              console.warn('[syncTracker] No `complete` received within safety window — stopping spinner.');
              finishSync();
            }, SYNC_STUCK_TIMEOUT_MS);
          break;

        case 'progress':
          // A big restore reports progress for minutes: each report keeps the spinner (and its label) alive.
          setIsSyncing(true);
          setPendingCount(data.pending);
          if (data.message) setSyncMessage(data.message);
          armStuck();
          break;

        case 'coins-ready':
          // Coins are in: read the balance now, while names keep loading.
          setBalanceTick((n) => n + 1);
          break;

        case 'complete':
          if (completeTimeoutRef.current) clearTimeout(completeTimeoutRef.current);
          completeTimeoutRef.current = setTimeout(finishSync, 3000);
          break;

        case 'restoring':
          setRestoreMessage(data.message);
          break;

        case 'restored':
          setRestoreMessage('');
          setUpdateBalance((prev) => !prev);
          break;

        case 'error':
          console.error('Sync error:', data.message);
          // Don't leave the spinner on forever if sync errors out
          finishSync();
          break;
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    const onRefresh = () => setBalanceTick((n) => n + 1);
    window.addEventListener(BALANCE_REFRESH_EVENT, onRefresh);

    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
      window.removeEventListener(BALANCE_REFRESH_EVENT, onRefresh);
      clearAllTimers();
    };
  }, []);

  return {
    pendingCount,
    updateBalance,
    balanceTick,
    theme,
    isSyncing,
    restoreMessage,
    syncMessage,
  };
};
