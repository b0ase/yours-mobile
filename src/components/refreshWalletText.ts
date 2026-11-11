/**
 * Plain words for the home REFRESH WALLET checklist (HomeShortcuts.tsx).
 *
 * Owner, 11 Nov 2026: after the Store incident the run ended "1 thing needs a look" with nothing saying what, and the
 * sync row said only "An internal error has occurred." That sentence is what 1Sat's backup server (wallet.1sat.app)
 * answers for any error that isn't a wallet error (services/syncErrorDetail.ts), so on its own it says neither where it
 * failed nor what to do. Here each failure gets a plain line naming the cause, and the summary names every row that
 * needs a look with its next step. The raw error stays available behind Details and in the background console.
 */

export type RefreshStepKey = 'sync' | 'resync' | 'missing';

/** What the sync row says when "Sync with my other devices" failed (raw: the background's error text). */
export function syncFailureText(raw: string | undefined): string {
  const r = raw ?? '';
  const safe = 'Your coins on this device are safe and nothing was sent.';
  if (/An internal error has occurred|WERR_INTERNAL/i.test(r))
    return `Couldn't sync with your backup (1Sat, wallet.1sat.app): it answered with an error, so this device's changes weren't saved there. ${safe}`;
  if (/network error 507|storage-payment-failed|StoragePaymentError|Insufficient Storage/i.test(r))
    return `Couldn't update your backup (1Sat): it is asking for its storage fee. ${safe}`;
  if (/network error 429|rate limit/i.test(r)) return `Your backup (1Sat) is busy right now. ${safe}`;
  if (/did not answer in time|still answering an earlier request|took too long|timed? ?out/i.test(r))
    return `Couldn't reach your backup (1Sat) in time. ${safe}`;
  if (/backup storage is not connected/i.test(r)) return `Couldn't connect to your backup (1Sat). ${safe}`;
  if (/network error|Failed to fetch|NetworkError|Load failed|ECONN|ENOTFOUND/i.test(r))
    return `Couldn't reach your backup (1Sat). ${safe}`;
  if (/site action is in progress/i.test(r)) return `A connected site is part-way through something. ${safe}`;
  if (/push waits for/i.test(r)) return `Waiting for a payment to finish first. ${safe}`;
  if (/Wallet not (initialized|available)|still opening/i.test(r)) return `The wallet is still opening. ${safe}`;
  return `Couldn't sync with your other devices. ${safe}`;
}

/** The plain next step for a row that needs a look. */
export function nextStep(key: RefreshStepKey, raw: string | undefined, found = false): string {
  const r = raw ?? '';
  switch (key) {
    case 'sync':
      if (/network error 507|storage-payment-failed|StoragePaymentError|Insufficient Storage/i.test(r))
        return 'Your other devices won’t see this device’s latest changes until the backup is paid. Tap Details and send them to support.';
      if (/site action is in progress|push waits for|still opening|not (initialized|available)/i.test(r))
        return 'Tap REFRESH WALLET again in a minute.';
      return 'Nothing to do now. The wallet keeps retrying by itself; tap REFRESH WALLET again later. Until it works, your other devices won’t show this device’s latest changes. If it keeps failing, tap Details and send them to support.';
    case 'resync':
      return 'Tap REFRESH WALLET again in a minute.';
    case 'missing':
      return found ? 'Check the coins below and tap Add it back.' : 'Tap REFRESH WALLET again later.';
  }
}

export type LookItem = { key: RefreshStepKey; title: string; text: string; raw?: string; found?: boolean };

/** "1 thing needs a look" / "2 things need a look", and one line per row: what it is and what to do. */
export function needsLookSummary(failed: LookItem[]): { heading: string; lines: string[] } {
  const n = failed.length;
  if (!n) return { heading: 'All checked. Your coins are safe.', lines: [] };
  return {
    heading: `${n} ${n === 1 ? 'thing needs' : 'things need'} a look`,
    lines: failed.map((s) => `${s.title}: ${nextStep(s.key, s.raw ?? s.text, s.found)}`),
  };
}
