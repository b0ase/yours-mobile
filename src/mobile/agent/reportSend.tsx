import { useEffect } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import type { ServiceContextProps } from '../../contexts/ServiceContext';
import { ChatApiError, saveSession, SESSION_EVENT } from '../chat/api';
import { kycClient, signedInClient } from '../kyc/kycWallet';
import { reportToB, type ReportResult } from './paid';
import {
  enqueueReport,
  failureReason,
  flushOutbox,
  logQueued,
  newReportId,
  queuedFor,
  reportMessageId,
  resetBackoff,
  type QueuedReport,
} from './reportOutbox';

type ApiContext = NonNullable<ServiceContextProps['apiContext']>;

/** bit-sign agent calls, signed in to bChatX; one fresh sign-in on a 401. */
// eslint-disable-next-line react-refresh/only-export-components
export const agentCaller =
  (apiContext: ApiContext) =>
  (m: 'GET' | 'POST', p: string, b?: unknown): Promise<unknown> =>
    signedInClient(apiContext)
      .then((c) => c.agentCall(m, p, b))
      .catch(async (e) => {
        if (!(e instanceof ChatApiError) || e.status !== 401) throw e;
        saveSession(null);
        return (await signedInClient(apiContext, kycClient())).agentCall(m, p, b);
      });

// eslint-disable-next-line react-refresh/only-export-components
export const currentAccountId = (s: ServiceContextProps['chromeStorageService'] | undefined): string | null => {
  try {
    return s?.getCurrentAccountObject().account?.addresses.identityAddress ?? null;
  } catch {
    return null;
  }
};

/**
 * Report to b, or keep it in the outbox when it can't go now. Never throws and never drops the report:
 * { sent } when bit-sign has it, { queued } when it's waiting on this device.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const sendOrQueueReport = async (
  apiContext: ApiContext | null | undefined,
  account: string | null,
  text: string,
): Promise<{ sent: ReportResult } | { queued: QueuedReport }> => {
  const id = newReportId();
  if (!apiContext) return { queued: enqueueReport(account, text, 'signin', undefined, undefined, id) };
  try {
    const sent = await reportToB(agentCaller(apiContext), text, reportMessageId(id));
    // bit-sign answered but could not log it: it waits in the outbox (same id), never shown as sent.
    if (!sent.ok) return { queued: enqueueReport(account, text, 'error', undefined, undefined, id) };
    return { sent };
  } catch (e) {
    const reason = failureReason(e);
    logQueued(reason, e);
    return { queued: enqueueReport(account, text, reason, undefined, undefined, id) };
  }
};

/** Retry now (Retry button / Sign in to send). */
// eslint-disable-next-line react-refresh/only-export-components
export const retryOutbox = (apiContext: ApiContext | null | undefined, account: string | null) =>
  apiContext ? flushOutbox(account, agentCaller(apiContext), { force: true }) : Promise.resolve(null);

/**
 * Sends queued reports in the background: on mount (app start / unlock / account switch), when the app comes
 * back to the front, when the network returns, and every minute. Each time only what is due: a report waits out its
 * backoff, and only the person's Retry (retryOutbox) sends one sooner (review of #557, L6).
 */
export const ReportOutboxRunner = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = currentAccountId(chromeStorageService);
  useEffect(() => {
    if (!apiContext) return;
    const call = agentCaller(apiContext);
    const run = () => {
      if (!queuedFor(account).length) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      void flushOutbox(account, call).catch(() => {});
    };
    const onVisible = () => document.visibilityState === 'visible' && run();
    // The cause is gone: what waited for it is due now (review of #557, N3).
    const onOnline = () => {
      resetBackoff(account, 'offline');
      run();
    };
    const onSession = () => {
      resetBackoff(account, 'signin');
      run();
    };
    run();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener(SESSION_EVENT, onSession);
    const timer = setInterval(run, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener(SESSION_EVENT, onSession);
      clearInterval(timer);
    };
  }, [apiContext, account]);
  return null;
};
