/**
 * chrome.runtime.sendMessage transport for the extension's own pages (replaces @1sat/wallet's chromeTransport).
 *
 * Differences from upstream:
 * - When Chrome says the message never reached the background ("Could not establish connection. Receiving end does
 *   not exist" — the service worker was stopped or restarting), it waits briefly and sends ONCE more. Safe for every
 *   call, createAction included: an undelivered message ran nothing, so nothing was built, signed or broadcast.
 * - It never retries when the message was delivered (port closed mid-call, or an error answer): that call may have
 *   built or broadcast a transaction, and a blind retry could pay twice.
 * - Errors keep their technical fields (`code`, `detail` from the background) for the Details panel, and an empty
 *   answer is an error, not a TypeError.
 */
import { NOT_DELIVERED } from './sendErrors';

type Send = (message: unknown, cb: (response: unknown) => void) => void;
type Runtime = { id?: string; lastError?: { message?: string }; sendMessage: Send };

export interface TransportError extends Error {
  code?: string;
  detail?: string;
  delivered: boolean;
}

const err = (message: string, delivered: boolean, fields: { code?: string; detail?: string } = {}): TransportError =>
  Object.assign(new Error(message), { delivered, ...fields }) as TransportError;

const once = (rt: Runtime, action: string, params: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    try {
      rt.sendMessage({ action, params, originator: rt.id }, (response) => {
        const le = rt.lastError;
        if (le) {
          const m = le.message || 'Chrome messaging failed';
          reject(err(m, !NOT_DELIVERED.test(m)));
          return;
        }
        const r = response as
          | { success?: boolean; data?: unknown; error?: unknown; code?: unknown; detail?: unknown }
          | undefined;
        if (!r || typeof r !== 'object') {
          reject(err('The wallet background answered nothing (message port closed before a response)', true));
          return;
        }
        if (r.success) resolve(r.data);
        else
          reject(
            err(typeof r.error === 'string' && r.error ? r.error : 'Unknown error', true, {
              code: typeof r.code === 'string' ? r.code : undefined,
              detail: typeof r.detail === 'string' ? r.detail : undefined,
            }),
          );
      });
    } catch (e) {
      // sendMessage throws synchronously when the extension context is gone (reloaded/updated).
      const m = e instanceof Error ? e.message : String(e);
      reject(err(m, !NOT_DELIVERED.test(m)));
    }
  });

export const makeResilientTransport =
  (
    getRuntime: () => Runtime | undefined = () => (globalThis as { chrome?: { runtime?: Runtime } }).chrome?.runtime,
    wait = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) =>
  async (action: string, params: unknown): Promise<unknown> => {
    const rt = getRuntime();
    if (!rt?.sendMessage) throw err('Extension context invalidated: reopen bWalletX', false);
    try {
      return await once(rt, action, params);
    } catch (e) {
      if ((e as TransportError).delivered !== false) throw e;
      console.warn(
        `[transport] ${action} not delivered (${(e as Error).message}); waking the background and retrying once`,
      );
      await wait(300);
      return once(rt, action, params);
    }
  };
