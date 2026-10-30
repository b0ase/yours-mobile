/**
 * A site asks for the wallet before any wallet exists (fresh install, bChatX /welcome sign-in, 30 Oct 2026).
 *
 * Before: ensureWallet rejected at once with "No wallet exists - create wallet first". The site showed an error and
 * the person never saw Create / Restore. Now the site's call waits, the wallet's setup screen opens and says which
 * site asked, and the call carries on once a wallet is created or restored (the background resolves the waiters
 * after the account switch that ends both flows). Closing the setup window or running out of time rejects with a
 * clear, coded error. Nothing is approved here: the site's request still goes through the permission sheets.
 */
import type { Timers } from './preApprovalTimeout';

/** Creating a wallet means writing down 12 words; restoring means finding them. Unlock's 60 s is far too short. */
export const SETUP_WAIT_MS = 5 * 60_000;

export const WALLET_SETUP_CLOSED_CODE = 'ERR_WALLET_SETUP_CLOSED';
export const WALLET_SETUP_CLOSED_MESSAGE =
  'bWalletX was closed before a wallet was set up. Nothing was shared; create or restore a wallet in bWalletX, then try again. (ERR_WALLET_SETUP_CLOSED)';
export const WALLET_SETUP_TIMEOUT_CODE = 'ERR_WALLET_SETUP_TIMEOUT';
export const WALLET_SETUP_TIMEOUT_MESSAGE =
  'No bWalletX wallet was set up in time. Nothing was shared; create or restore a wallet in bWalletX, then try again. (ERR_WALLET_SETUP_TIMEOUT)';

const coded = (message: string, code: string, status: number) => Object.assign(new Error(message), { code, status });
export const walletSetupClosedError = () => coded(WALLET_SETUP_CLOSED_MESSAGE, WALLET_SETUP_CLOSED_CODE, 401);
export const walletSetupTimeoutError = () => coded(WALLET_SETUP_TIMEOUT_MESSAGE, WALLET_SETUP_TIMEOUT_CODE, 408);

/** [message, code, status] rows so the background's `{success:false, error}` reply carries the code to the site. */
export const WALLET_SETUP_CODED: [string, string, number][] = [
  [WALLET_SETUP_CLOSED_MESSAGE, WALLET_SETUP_CLOSED_CODE, 401],
  [WALLET_SETUP_TIMEOUT_MESSAGE, WALLET_SETUP_TIMEOUT_CODE, 408],
];

export interface WalletWaiter<W> {
  resolve: (wallet: W) => void;
  reject: (error: Error) => void;
}

export interface SetupWaitDeps<W> extends Timers {
  /** The shared queue (the background's pendingWalletWaiters); resolved after create / restore, rejected on close. */
  waiters: WalletWaiter<W>[];
  /** Opens the setup screen. Called once, by the first call to wait. */
  openSetup: () => void;
  ms?: number;
}

/** Queue one site call behind wallet setup; the first call opens the setup screen. */
export function waitForWalletSetup<W>(deps: SetupWaitDeps<W>): Promise<W> {
  const setT = deps.setTimer ?? ((f: () => void, m: number) => setTimeout(f, m));
  const clearT = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  return new Promise<W>((resolve, reject) => {
    const waiter: WalletWaiter<W> = {
      resolve: (w) => {
        clearT(timer);
        resolve(w);
      },
      reject: (e) => {
        clearT(timer);
        reject(e);
      },
    };
    deps.waiters.push(waiter);
    const timer = setT(() => {
      const i = deps.waiters.indexOf(waiter);
      if (i >= 0) deps.waiters.splice(i, 1);
      reject(walletSetupTimeoutError());
    }, deps.ms ?? SETUP_WAIT_MS);
    if (deps.waiters.length === 1) deps.openSetup();
  });
}

const HOST_RE = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i;

/** The asking site's host for the setup screen, or undefined when it is not a plain host (never free text). */
export const setupHost = (originator?: unknown): string | undefined => {
  if (typeof originator !== 'string' || !originator) return undefined;
  try {
    const host = new URL(originator.includes('://') ? originator : `https://${originator}`).host;
    return HOST_RE.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
};

/** The line on the setup screen: why it opened. */
export const setupReason = (host?: string): string =>
  `${host ?? 'A site'} wants to sign you in. Restore your wallet or create a new one.`;
