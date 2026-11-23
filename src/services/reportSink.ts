/**
 * Wallet-core code (no UI) handing a report to b through the existing report path: the app's report outbox
 * (mobile/agent/reportOutbox.ts) registers itself here when it loads, and sends it with the outbox's own retries,
 * redaction (redactSecrets) and "Your reports" listing. Where no outbox is loaded (the extension's background, review
 * of f42df01f, 6), the report waits in chrome.storage.local, one key per report, and the outbox takes it in when a
 * wallet page loads it (or at once, when one is open). Callers pass text without keys or secrets; the outbox scrubs it.
 *
 * Claim-safe (review of 6888544a, 6): each report is its own key (a background write never rewrites a list, so none is
 * lost), and pages take them in one at a time under a Web Lock shared by every extension page, removing each by its
 * key only after the outbox has it: two open pages never both take the same report.
 */
/** `reportId`: the report's own id when the caller has one (the outbox sends it as message_id, so a resend dedupes). */
type Sink = (account: string | null | undefined, text: string, reportId?: string) => void;

/** One waiting report: chrome.storage.local `${WALLET_REPORT_PREFIX}${id}`. */
export const WALLET_REPORT_PREFIX = 'bwx.walletReport:';
/** Waiting reports kept at most (the oldest dropped): a repeating failure never fills storage. */
const PENDING_CAP = 20;
const MAX_TEXT = 4000;
const LOCK_NAME = 'bwx.walletReports';

type Pending = { account: string | null; text: string; at: number; reportId?: string };
type Area = {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};
type ChromeLike = {
  storage?: {
    local?: Area;
    onChanged?: { addListener(fn: (changes: Record<string, unknown>, area: string) => void): void };
  };
};
/** The Web Locks API as used here (navigator.locks); tests pass their own. */
export type Locks = { request<T>(name: string, fn: () => Promise<T>): Promise<T> };
const chromeOf = () => (globalThis as { chrome?: ChromeLike }).chrome;
const area = (): Area | undefined => chromeOf()?.storage?.local;
/** Without navigator.locks (a context that lacks it): this context's drains still run one at a time. */
let localTail: Promise<unknown> = Promise.resolve();
const localLocks: Locks = {
  request<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    const run = localTail.then(fn, fn);
    localTail = run.catch(() => undefined);
    return run;
  },
};
const defaultLocks = (): Locks => (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks ?? localLocks;

let sink: Sink | undefined;
/** This context's writes, in order (two in the same millisecond keep their order). */
let written = 0;

/** The report outbox registers here (once, when it loads). */
export function setReportSink(fn: Sink | undefined): void {
  sink = fn;
}

const waiting = (all: Record<string, unknown>) =>
  Object.entries(all ?? {})
    .filter(([k, v]) => k.startsWith(WALLET_REPORT_PREFIX) && !!v && typeof (v as Pending).text === 'string')
    .map(([k, v]) => [k, v as Pending] as const)
    // Keys sort by when they were written (padded time, then a counter).
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

/** Keep a report in chrome.storage.local for the outbox (its own key). True when kept. */
export async function queueForOutbox(
  account: string | null | undefined,
  text: string,
  reportId?: string,
): Promise<boolean> {
  const a = area();
  if (!a) return false;
  try {
    const id = `${Date.now().toString(36).padStart(10, '0')}-${(++written).toString(36).padStart(6, '0')}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const item: Pending = {
      account: account ?? null,
      text: text.slice(0, MAX_TEXT),
      at: Date.now(),
      ...(reportId ? { reportId } : {}),
    };
    await a.set({ [`${WALLET_REPORT_PREFIX}${id}`]: item });
    const over = waiting(await a.get(null)).slice(0, -PENDING_CAP);
    if (over.length) await a.remove(over.map(([k]) => k));
    return true;
  } catch {
    return false;
  }
}

/** Hand a report to b. Never throws. True when an outbox (or the wait for one) took it. */
export async function reportFromWallet(
  account: string | null | undefined,
  text: string,
  reportId?: string,
): Promise<boolean> {
  try {
    if (sink) {
      sink(account, text, reportId);
      return true;
    }
    if (await queueForOutbox(account, text, reportId)) return true;
    console.warn('[report] no report outbox in this context:', text);
    return false;
  } catch {
    return false;
  }
}

/**
 * Move the waiting reports into the outbox (`take`), each removed by its key once taken. Under the shared Web Lock:
 * one page at a time. Returns how many this call took.
 */
export async function drainPendingWalletReports(
  take: Sink,
  locks: Locks | undefined = defaultLocks(),
): Promise<number> {
  const a = area();
  if (!a) return 0;
  const run = async () => {
    let n = 0;
    try {
      for (const [key, r] of waiting(await a.get(null))) {
        // Still there (another page may have taken it before this lock): taken, then removed by its key.
        if (!(await a.get(key))?.[key]) continue;
        take(r.account, r.text, typeof r.reportId === 'string' ? r.reportId : undefined);
        await a.remove(key);
        n++;
      }
    } catch {
      // the rest stay for the next drain
    }
    return n;
  };
  return locks.request(LOCK_NAME, run);
}

/** The outbox's side: take in what is waiting now, and whatever the background writes while this page is open. */
export function takeWalletReports(take: Sink, locks: Locks = defaultLocks()): void {
  void drainPendingWalletReports(take, locks);
  try {
    chromeOf()?.storage?.onChanged?.addListener((changes, where) => {
      const added = Object.entries(changes).some(
        ([k, c]) => k.startsWith(WALLET_REPORT_PREFIX) && (c as { newValue?: unknown } | undefined)?.newValue,
      );
      if (where === 'local' && added) void drainPendingWalletReports(take, locks);
    });
  } catch {
    // no listener: the next load takes them in
  }
}
