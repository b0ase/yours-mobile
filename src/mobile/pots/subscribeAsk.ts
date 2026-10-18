/**
 * The one "Subscribe with bWalletX" approval sheet, shared by every entry point (docs/SUBSCRIBE-API.md):
 * the bApp frame (BappFrameHost), the in-app browser (dappBrowser.ts) and the Chrome extension (content.ts →
 * the wallet page, extensionSubscribe.ts). Each caller has already bound the request to the origin the browser
 * reported; this module only queues ONE sheet at a time and answers with the pot the user chose (or null).
 *
 * ⚠ bWalletX only: every caller checks SUBSCRIPTIONS_ENABLED, so a store build never shows it.
 */
import { cachedExchangeRate } from '../../utils/wallet';
import type { AppSubscribeRequest, SubscribeDeps } from './appSubscribe';
import { SubscribeError } from './appSubscribe';
import { chargeSoon, potsRunning } from './potsEngine';

type Ask = { req: AppSubscribeRequest; resolve: (potId: string | null) => void };
let current: Ask | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Another wallet sheet (e.g. the bApp frame's own confirm) is up: a second ask is refused. */
let busy: () => boolean = () => false;
export const setSubscribeBusy = (f: () => boolean) => {
  busy = f;
};

/** Shows the sheet. Resolves with the chosen pot id, or null (declined, or a sheet is already open). */
export const askSubscribe = (req: AppSubscribeRequest): Promise<string | null> => {
  if (!potsRunning()) return Promise.reject(new SubscribeError('Unlock bWalletX, then try again'));
  if (current || busy()) return Promise.resolve(null);
  return new Promise((resolve) => {
    current = { req, resolve };
    emit();
  });
};

export const answerSubscribeAsk = (potId: string | null) => {
  const a = current;
  current = null;
  emit();
  a?.resolve(potId);
};

/** For the host component (useSyncExternalStore). */
export const watchSubscribeAsk = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
export const currentSubscribeAsk = () => current?.req ?? null;

/** The real deps every entry point uses. */
export const subscribeDeps = (): SubscribeDeps => ({
  approve: askSubscribe,
  bsvUsd: () => cachedExchangeRate(),
  chargeSoon,
});
