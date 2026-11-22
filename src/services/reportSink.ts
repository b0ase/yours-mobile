/**
 * Wallet-core code (no UI) handing a report to b through the existing report path: the app's report outbox
 * (mobile/agent/reportOutbox.ts) registers itself here when it loads, and sends it with the outbox's own retries,
 * redaction (redactSecrets) and "Your reports" listing. Where no outbox is loaded (the extension's background), the
 * report goes to the console only. Callers pass text without keys or secrets; the outbox scrubs it again.
 */
type Sink = (account: string | null | undefined, text: string) => void;

let sink: Sink | undefined;

/** The report outbox registers here (once, when it loads). */
export function setReportSink(fn: Sink | undefined): void {
  sink = fn;
}

/** Hand a report to b. Never throws. True when an outbox took it. */
export function reportFromWallet(account: string | null | undefined, text: string): boolean {
  try {
    if (!sink) {
      console.warn('[report] no report outbox in this context:', text);
      return false;
    }
    sink(account, text);
    return true;
  } catch {
    return false;
  }
}
