/**
 * bMail error copy: raw transport errors ("failed to retrieve messages from any host", fetch/HTTP
 * failures) never reach the UI. The detail goes to the console; the screen gets one friendly line.
 */
export const BMAIL_OFFLINE = "Can't reach bMail right now. Pull down to try again.";
export const BMAIL_OFFLINE_ACTION = "Can't reach bMail right now. Try again in a moment.";

const RAW =
  /any host|failed to (retrieve|fetch|send|acknowledge)|fetch|network|timed? ?out|timeout|http \d{3}|status \d{3}|econn|enotfound|load failed|socket|cors|overlay|lookup|host|json|unexpected token|undefined|null/i;

/** True when the message is a transport/technical error rather than something written for a person. */
export const isRawMailError = (msg: string) => !msg || RAW.test(msg) || msg.length > 140;

/**
 * Message for the UI. `whole` = the inbox refresh (always the friendly line); otherwise app-written
 * messages (e.g. "Not enough BSV") pass through and technical ones become `fallback`.
 */
export const friendlyMailError = (e: unknown, opts: { whole?: boolean; fallback?: string } = {}): string => {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  console.warn('[bMail]', e);
  if (opts.whole || isRawMailError(msg)) return opts.fallback ?? BMAIL_OFFLINE;
  return msg;
};
