/**
 * Telling "no internet" apart from a real fault (owner's Android, 19 Oct 2026). The phone sat on an LTE link that
 * Android reported as connected but never validated: every request failed DNS, navigator.onLine stayed true, and
 * the wallet showed "Sync failing: signal is aborted without reason" while "Report to b" quietly fell back to the
 * chat. Both now say plainly that the phone is offline.
 */
export const OFFLINE_TEXT = "You're offline";

const NETWORK_PATTERNS = [
  /failed to fetch/i, // Chrome / Android WebView
  /load failed/i, // Safari / WKWebView
  /networkerror/i, // Firefox
  /network request failed/i,
  /couldn't reach /i, // nameFailedFetch's wording
  /signal is aborted/i, // AbortSignal.timeout / controller.abort() on a hung request
  /the operation was aborted/i,
  /timed? ?out/i,
  /err_(name_not_resolved|internet_disconnected|network_changed|connection_(refused|reset|closed|timed_out)|address_unreachable)/i,
];

const messageOf = (e: unknown) =>
  typeof e === 'string'
    ? e
    : e instanceof Error
      ? `${e.name}: ${e.message}`
      : String((e as { message?: unknown })?.message ?? '');

/** A failure that a working connection would not have had (DNS, dropped socket, timeout), not a server answer. */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) return true;
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) return true;
  const m = messageOf(e);
  return !!m && NETWORK_PATTERNS.some((p) => p.test(m));
}

/** navigator.onLine only knows false for sure; true just means "some link is up" (Android: even unvalidated). */
export const knownOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
