/**
 * Wallet-core code (no UI) handing a report to b through the existing report path: the app's report outbox
 * (mobile/agent/reportOutbox.ts) registers itself here when it loads, and sends it with the outbox's own retries,
 * redaction (redactSecrets) and "Your reports" listing. Where no outbox is loaded (the extension's background, review
 * of f42df01f, 6), the report waits in chrome.storage.local and the outbox takes it in when a wallet page loads it (or
 * at once, when one is open). Callers pass text without keys or secrets; the outbox scrubs it again.
 */
type Sink = (account: string | null | undefined, text: string) => void;

/** Reports waiting for an outbox (chrome.storage.local), oldest first. */
export const PENDING_WALLET_REPORTS_KEY = 'bwx.pendingWalletReports';
/** Waiting reports kept at most (the oldest dropped): a repeating failure never fills storage. */
const PENDING_CAP = 20;
const MAX_TEXT = 4000;

type Pending = { account: string | null; text: string; at: number };
type Area = {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
};
type ChromeLike = {
  storage?: {
    local?: Area;
    onChanged?: { addListener(fn: (changes: Record<string, unknown>, area: string) => void): void };
  };
};
const chromeOf = () => (globalThis as { chrome?: ChromeLike }).chrome;
const area = (): Area | undefined => chromeOf()?.storage?.local;

let sink: Sink | undefined;

/** The report outbox registers here (once, when it loads). */
export function setReportSink(fn: Sink | undefined): void {
  sink = fn;
}

/** Keep a report in chrome.storage.local for the outbox. True when kept. */
export async function queueForOutbox(account: string | null | undefined, text: string): Promise<boolean> {
  const a = area();
  if (!a) return false;
  try {
    const got = (await a.get(PENDING_WALLET_REPORTS_KEY))?.[PENDING_WALLET_REPORTS_KEY];
    const list = Array.isArray(got) ? (got as Pending[]) : [];
    const next = [...list, { account: account ?? null, text: text.slice(0, MAX_TEXT), at: Date.now() }].slice(
      -PENDING_CAP,
    );
    await a.set({ [PENDING_WALLET_REPORTS_KEY]: next });
    return true;
  } catch {
    return false;
  }
}

/** Hand a report to b. Never throws. True when an outbox (or the wait for one) took it. */
export async function reportFromWallet(account: string | null | undefined, text: string): Promise<boolean> {
  try {
    if (sink) {
      sink(account, text);
      return true;
    }
    if (await queueForOutbox(account, text)) return true;
    console.warn('[report] no report outbox in this context:', text);
    return false;
  } catch {
    return false;
  }
}

let draining: Promise<number> | undefined;
/** Move the waiting reports into the outbox (`take`), then clear them. Returns how many. */
export function drainPendingWalletReports(take: Sink): Promise<number> {
  draining ??= (async () => {
    const a = area();
    if (!a) return 0;
    try {
      const got = (await a.get(PENDING_WALLET_REPORTS_KEY))?.[PENDING_WALLET_REPORTS_KEY];
      if (!Array.isArray(got) || !got.length) return 0;
      await a.remove(PENDING_WALLET_REPORTS_KEY);
      let n = 0;
      for (const r of got as Pending[])
        if (r && typeof r.text === 'string' && r.text) {
          take(r.account, r.text);
          n++;
        }
      return n;
    } catch {
      return 0;
    }
  })().finally(() => {
    draining = undefined;
  });
  return draining;
}

/** The outbox's side: take in what is waiting now, and whatever the background writes while this page is open. */
export function takeWalletReports(take: Sink): void {
  void drainPendingWalletReports(take);
  try {
    chromeOf()?.storage?.onChanged?.addListener((changes, where) => {
      if (where === 'local' && PENDING_WALLET_REPORTS_KEY in changes) void drainPendingWalletReports(take);
    });
  } catch {
    // no listener: the next load takes them in
  }
}
