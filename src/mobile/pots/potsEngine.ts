import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import { cachedExchangeRate, fetchExchangeRate } from '../../utils/wallet';
import { isLowFunds, listPots, listSubs, potCovers, type Subscription } from './pots';
import { payDue } from './payDue';
import { broadcastRaw, payeeAddress, potBalanceSats, signFromPot } from './potSend';
import { notifyLowFunds, notifyPot, reschedulePotReminders } from './notifyPots';

/**
 * Runs pay-on-open while the wallet is unlocked: once at start and on every resume / return to the tab.
 * Started from NotifyEngine (mounted only while unlocked). Does nothing when there are no standing orders.
 */
type Env = { store: ChromeStorageService };
let env: Env | null = null;
let resumeSub: { remove: () => Promise<void> } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Too many missed payments: ask once per order per app session (window.confirm on every platform). */
const asked = new Set<string>();
const confirmCatchUp = async (s: Subscription, missed: number) => {
  if (asked.has(s.id)) return false;
  asked.add(s.id);
  return window.confirm(
    `${s.payee.name}: ${missed} payments were missed while the app was closed. Pay all ${missed} now? Cancel pays only the latest 3.`,
  );
};

const tick = async () => {
  const e = env;
  if (!e || !listSubs().some((s) => s.status === 'active' || s.status === 'lowFunds')) return;
  const bsvUsd = await fetchExchangeRate('main').catch(() => cachedExchangeRate());
  await payDue({
    bsvUsd,
    resolve: payeeAddress,
    sign: (potId, outputs) => signFromPot(e.store, potId, outputs),
    broadcast: broadcastRaw,
    confirm: confirmCatchUp,
    notify: (t, b) => void notifyPot(t, b),
  }).catch(() => []);
  for (const p of listPots()) {
    const subs = listSubs(p.identityAddress);
    if (!subs.some((s) => s.status === 'active' || s.status === 'lowFunds')) continue;
    const bal = await potBalanceSats(e.store, p.identityAddress).catch(() => null);
    if (bal === null || !(bsvUsd > 0)) continue;
    const covers = potCovers(subs, bal, bsvUsd);
    if (isLowFunds(covers)) notifyLowFunds(p.identityAddress, p.name, covers);
  }
  await reschedulePotReminders();
};

const schedule = (ms: number) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), ms);
};
const onVisible = () => {
  if (document.visibilityState === 'visible' && env) schedule(2_000);
};

export function startPots(next: Env) {
  const first = !env;
  env = next;
  if (!first) return;
  document.addEventListener('visibilitychange', onVisible);
  if (Capacitor.isNativePlatform())
    void App.addListener('resume', () => env && schedule(2_000))
      .then((h) => (resumeSub = h))
      .catch(() => undefined);
  schedule(6_000);
}

export function stopPots() {
  env = null;
  if (timer) clearTimeout(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisible);
  void resumeSub?.remove();
  resumeSub = null;
}
