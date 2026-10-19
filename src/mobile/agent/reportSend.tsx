import { useEffect } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import type { ServiceContextProps } from '../../contexts/ServiceContext';
import { ChatApiError, saveSession } from '../chat/api';
import { kycClient, signedInClient } from '../kyc/kycWallet';
import { reportToB, type ReportResult } from './paid';
import { enqueueReport, failureReason, flushOutbox, logQueued, queuedFor, type QueuedReport } from './reportOutbox';

type ApiContext = NonNullable<ServiceContextProps['apiContext']>;

/** bit-sign agent calls, signed in to bChatX; one fresh sign-in on a 401. */
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
export const sendOrQueueReport = async (
  apiContext: ApiContext | null | undefined,
  account: string | null,
  text: string,
): Promise<{ sent: ReportResult } | { queued: QueuedReport }> => {
  if (!apiContext) return { queued: enqueueReport(account, text, 'signin') };
  try {
    return { sent: await reportToB(agentCaller(apiContext), text) };
  } catch (e) {
    const reason = failureReason(e);
    logQueued(reason, e);
    return { queued: enqueueReport(account, text, reason) };
  }
};

/** Retry now (Retry button / Sign in to send). */
export const retryOutbox = (apiContext: ApiContext | null | undefined, account: string | null) =>
  apiContext ? flushOutbox(account, agentCaller(apiContext), { force: true }) : Promise.resolve(null);

/**
 * Sends queued reports in the background: on mount (app start / unlock / account switch), when the app comes
 * back to the front, when the network returns, and every minute for anything whose backoff is up.
 */
export const ReportOutboxRunner = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = currentAccountId(chromeStorageService);
  useEffect(() => {
    if (!apiContext) return;
    const call = agentCaller(apiContext);
    const run = (force: boolean) => {
      if (!queuedFor(account).length) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      void flushOutbox(account, call, { force }).catch(() => {});
    };
    const onVisible = () => document.visibilityState === 'visible' && run(true);
    const onOnline = () => run(true);
    run(true);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    const timer = setInterval(() => run(false), 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      clearInterval(timer);
    };
  }, [apiContext, account]);
  return null;
};
