/**
 * Queued sends that never reach the network: give up on them and give the money back.
 *
 * vexvoid.com, 12 Oct 2026: a big video mint (36582df1…) was signed, the broadcaster gave no verdict, and the
 * toolbox queued it ('sending'). The Monitor's SendWaiting task retries such a send every few minutes, forever,
 * and its inputs stay locked. That one did land (mined in block 970724), but a send that never will would keep
 * the user's money locked with no way out: abortAction refuses a 'sending' action.
 *
 * Here, after GIVE_UP_MS, a queued send the network has no copy of is cancelled: its proven-tx request is marked
 * 'invalid' (SendWaiting stops), and the action is marked failed, which releases its inputs. A send the network
 * already has, or whose status can't be read cleanly, is never touched (knownOnChain fails closed). A permanent
 * rejection is already failed by the toolbox itself (OneSatServices REJECTED -> invalidTx), inputs released.
 *
 * The repeat guard (repeatGuard.ts) is unchanged: its window (1 h) ends long before GIVE_UP_MS, so a cancel here
 * can't let a site build an identical second payment while the first is still going out.
 */

/** How long a queued send may stay unconfirmed before the wallet gives up on it. */
export const GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** Never give up on a send the wallet has tried fewer times than this (a wallet that was closed for a day). */
export const MIN_ATTEMPTS = 6;

export type QueuedSend = {
  transactionId: number;
  txid: string;
  createdAt: number;
  /** The proven-tx request's broadcast attempts (0 when unknown). */
  attempts: number;
  description?: string;
  satoshis?: number;
};

export type StuckVerdict = 'wait' | 'give-up';

/** Pure: should the wallet give up on this queued send now? (Chain state is checked separately, after.) */
export function stuckVerdict(s: Pick<QueuedSend, 'createdAt' | 'attempts'>, now: number): StuckVerdict {
  if (!Number.isFinite(s.createdAt)) return 'wait';
  return now - s.createdAt >= GIVE_UP_MS && s.attempts >= MIN_ATTEMPTS ? 'give-up' : 'wait';
}

export type ReleaseDeps = {
  /** Outgoing actions in status 'sending' with their request's attempts (read only). */
  listQueued: () => Promise<QueuedSend[]>;
  /** True when the network has (or may have) this txid. Must fail closed: an error counts as known. */
  knownOnChain: (txid: string) => Promise<boolean>;
  /** Stop retrying and release the inputs: request -> 'invalid', action -> 'failed'. */
  cancel: (s: QueuedSend) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
};

export type ReleaseReport = { queued: number; released: QueuedSend[]; kept: string[]; error?: string };

export async function releaseStuckSends(deps: ReleaseDeps): Promise<ReleaseReport> {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? ((m: string) => console.log(m));
  const report: ReleaseReport = { queued: 0, released: [], kept: [] };
  try {
    const queued = (await deps.listQueued()).filter((s) => /^[0-9a-f]{64}$/i.test(s.txid));
    report.queued = queued.length;
    for (const s of queued) {
      if (stuckVerdict(s, now) === 'wait') continue;
      let known = true;
      try {
        known = await deps.knownOnChain(s.txid);
      } catch {
        known = true;
      }
      if (known) {
        report.kept.push(s.txid);
        continue;
      }
      try {
        await deps.cancel(s);
        report.released.push(s);
        log(`[stuckSends] gave up on ${s.txid} after ${s.attempts} attempts; inputs released`);
      } catch (e) {
        console.warn('[stuckSends] cancel failed for', s.txid, e);
      }
    }
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    console.error('[stuckSends] failed:', e);
  }
  return report;
}

/** What the user is told, in plain words. */
export function releasedMessage(released: Pick<QueuedSend, 'description'>[]): string {
  const n = released.length;
  const what = n === 1 && released[0].description ? `"${released[0].description.slice(0, 60)}"` : `${n} payments`;
  return (
    `${what} never reached the network, so your wallet cancelled ${n === 1 ? 'it' : 'them'}. ` +
    `Nothing was paid, and the money is spendable again.`
  );
}
