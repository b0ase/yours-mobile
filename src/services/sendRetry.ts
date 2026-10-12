/**
 * Retry queued sends on a schedule (12 Oct 2026).
 *
 * The toolbox Monitor only runs once when the wallet opens, and the big-send wake-ups (bigDelayed.ts) stop after
 * 10 min. A send still queued ('sending' / 'unsent') after that would wait for the next wallet wake, maybe hours.
 * While any queued send exists, an alarm (chrome.alarms in the extension, which survives the service worker
 * sleeping; the chromeShim interval on web and phones, which runs while the app is in front) runs SendWaiting and
 * the stuck-send review every SEND_RETRY_PERIOD_MINUTES. The alarm is cleared once nothing is queued. SendWaiting
 * uploads with the size-scaled timeout (bigBroadcast.ts). One run at a time: a tick during a run joins it.
 */

export const SEND_RETRY_ALARM = 'bwx-send-retry';
export const SEND_RETRY_PERIOD_MINUTES = 5;

export type SendRetryDeps = {
  /** Run the Monitor's SendWaiting task; resolves to its log text. */
  sendWaiting: () => Promise<unknown>;
  /** The stuck-send review; reports how many sends are still queued after it. */
  review: () => Promise<{ queued: number; error?: string }>;
  alarms: {
    create: (name: string, info: { periodInMinutes: number }) => unknown;
    clear: (name: string) => unknown;
  };
  log?: (m: string) => void;
};

export type SendRetry = {
  /** Retry now (alarm, resume, a send was queued). Joins a run already going. Resolves to the queued count. */
  tick: () => Promise<number>;
  /** Start the alarm (a send was just queued). No-op when it is already on. */
  arm: () => void;
  armed: () => boolean;
};

export function createSendRetry(deps: SendRetryDeps): SendRetry {
  const log = deps.log ?? ((m: string) => console.log(m));
  let isArmed = false;
  let running: Promise<number> | null = null;

  const arm = () => {
    if (isArmed) return;
    isArmed = true;
    deps.alarms.create(SEND_RETRY_ALARM, { periodInMinutes: SEND_RETRY_PERIOD_MINUTES });
  };
  const disarm = () => {
    // Clear even when this worker's flag is off: an alarm can outlive a service-worker restart.
    isArmed = false;
    void Promise.resolve(deps.alarms.clear(SEND_RETRY_ALARM)).catch(() => undefined);
  };

  const runOnce = async (): Promise<number> => {
    try {
      const r = await deps.sendWaiting();
      if (typeof r === 'string' && r.trim()) log(`[sendRetry] SendWaiting: ${r.trim()}`);
    } catch (e) {
      log(`[sendRetry] SendWaiting failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    let queued = 0;
    try {
      const r = await deps.review();
      if (r.error) {
        // Unknown state: keep retrying rather than stop with a send possibly waiting.
        log(`[sendRetry] review failed: ${r.error}`);
        arm();
        return -1;
      }
      queued = r.queued;
    } catch (e) {
      log(`[sendRetry] review failed: ${e instanceof Error ? e.message : String(e)}`);
      arm();
      return -1;
    }
    if (queued > 0) {
      if (!isArmed) log(`[sendRetry] ${queued} queued send(s); retrying every ${SEND_RETRY_PERIOD_MINUTES} min`);
      arm();
    } else disarm();
    return queued;
  };

  const tick = () => {
    if (!running)
      running = runOnce().finally(() => {
        running = null;
      });
    return running;
  };

  return { tick, arm, armed: () => isArmed };
}
