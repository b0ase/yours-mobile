import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { useOnResume } from '../permissions/useOnResume';
import { recordPayment, updateConnectionLog } from '../wallet/connectionLog';
import {
  activeSwaps,
  applyStatus,
  FINAL,
  landedText,
  loadSwaps,
  POLL_MS,
  saveSwap,
  SwapApi,
  type SwapRecord,
} from './swapApi';

const api = new SwapApi();
/** Local notification ids for swaps (clear of pots' 43000–48000). */
const NOTIFY_BASE = 49_000;

/** Phone notice when a swap ends; only if notifications were already allowed (never prompts here). */
const notifyLanded = async (s: SwapRecord) => {
  const t = landedText(s);
  if (!t || !Capacitor.isNativePlatform()) return;
  try {
    if ((await LocalNotifications.checkPermissions()).display !== 'granted') return;
    let h = 0;
    for (const ch of s.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    await LocalNotifications.schedule({
      notifications: [{ id: NOTIFY_BASE + (h % 1000), title: t.title, body: t.body }],
    });
  } catch {
    /* notifications unavailable */
  }
};

/**
 * Keeps unfinished swaps moving while the wallet is open: polls every 20 s and on resume. When one ends it posts a
 * phone notice (`onLanded` shows the in-app one) and, once the BSV lands, labels the payout tx "ChangeNOW swap" in
 * History via the connections log.
 */
export const useSwapWatcher = (onLanded?: (s: SwapRecord) => void) => {
  const [swaps, setSwaps] = useState<SwapRecord[]>(loadSwaps);

  useEffect(() => {
    const re = () => setSwaps(loadSwaps());
    window.addEventListener('bwx-swaps', re);
    return () => window.removeEventListener('bwx-swaps', re);
  }, []);

  const poll = useCallback(() => {
    for (const s of activeSwaps(loadSwaps())) {
      api
        .status(s.id)
        .then((st) => saveSwap(applyStatus(s, st)))
        .catch(() => undefined);
    }
    // Notices for anything that ended (here or on the Track screen) and hasn't been announced yet.
    for (const s of loadSwaps()) {
      if (!FINAL.has(s.stage) || s.notified) continue;
      saveSwap({ ...s, notified: true });
      if (s.stage === 'expired') continue;
      void notifyLanded(s);
      onLanded?.(s);
      if (s.stage === 'done' && s.payoutTxid) {
        void updateConnectionLog((l) =>
          recordPayment(l, 'changenow.io', {
            at: Date.now(),
            txid: s.payoutTxid!,
            sats: 0,
            description: `Swap ${s.label} → BSV`,
          }),
        );
      }
    }
  }, [onLanded]);

  const anyActive = activeSwaps(swaps).length > 0 || swaps.some((s) => FINAL.has(s.stage) && !s.notified);
  useEffect(() => {
    if (!anyActive) return;
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [anyActive, poll]);
  useOnResume(poll, anyActive);

  return { swaps, active: activeSwaps(swaps) };
};
