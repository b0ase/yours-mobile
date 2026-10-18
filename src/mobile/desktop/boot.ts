/* eslint-disable @typescript-eslint/no-explicit-any */
import { listen } from '@tauri-apps/api/event';
import { getCurrent } from '@tauri-apps/plugin-deep-link';
import { offerPairLink } from '../pair/links';
import { offerSubscribeLink } from '../pots/subscribeLink';
import { offerAppLink } from '../spaces/inviteLinks';
import { SUBSCRIPTIONS_ENABLED } from '../storeBuild';
import { isAppUrl } from './links';

/**
 * bWalletX Desktop (Tauri) after the UI has loaded (main.ts):
 * - bwalletx:// links (at launch, and while running via the `app-url` event from src-tauri/src/lib.rs) go to the
 *   same handlers the phone apps feed from Capacitor's appUrlOpen (pair/links.ts, spaces/inviteLinks.ts,
 *   pots/subscribeLink.ts), so each link type keeps one parser. Each handler ignores links that are not its kind.
 * - Tray › Lock wallet drops the session passKey and expires the session; the lock check (ServiceProvider) shows
 *   the lock screen on its next 5 s tick, as when the timeout passes.
 */
export const routeAppUrl = (url: string) => {
  if (!isAppUrl(url)) return;
  offerPairLink(url);
  if (SUBSCRIPTIONS_ENABLED && offerSubscribeLink(url)) return;
  offerAppLink(url);
};

export const initDesktop = async (chrome: any) => {
  await listen<string[]>('app-url', (e) => e.payload.forEach(routeAppUrl));
  try {
    const launch = await getCurrent();
    launch?.forEach(routeAppUrl);
  } catch (e) {
    console.warn('[desktop] launch link unavailable', e);
  }
  await listen('tray-lock', async () => {
    await chrome.storage.session.remove('passKey');
    await chrome.storage.local.set({ lastActiveTime: 0 });
  });
};
