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
import type { PayeeDestination } from './payeeBinding';
import type { Payee } from './pots';
import { resolvePayee } from './potSend';
import { SubscribeError } from './appSubscribe';
import { chargeSoon, potsRunning } from './potsEngine';
import { APP_NAME } from '../storeBuild';

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
  if (!potsRunning()) return Promise.reject(new SubscribeError(`Unlock ${APP_NAME}, then try again`));
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

/**
 * An app subscription's paymail payee, looked up with a standing order's set-up checks (fresh): its host must serve
 * an address the wallet can tie to its key, or the request is refused before the sheet (backlog rank 1).
 */
export const checkAppPayee = (
  p: Payee,
  resolve: (p: Payee, o: { ignorePin?: boolean; fresh?: boolean }) => Promise<PayeeDestination> = resolvePayee,
): Promise<PayeeDestination> => resolve(p, { ignorePin: true, fresh: true });

/** The real deps every entry point uses. */
export const subscribeDeps = (): SubscribeDeps => ({
  approve: askSubscribe,
  bsvUsd: () => cachedExchangeRate(),
  checkPayee: checkAppPayee,
  chargeSoon,
});
