/**
 * A tapped "Shared account payment" push (kind partner_account_*, url /m/lock): opens the Lock page and the request.
 * PushEngine sits outside the router, so it only records the request; OpenPartnerRequest (inside the router) goes to
 * /m/lock, and the partnership's Shared account takes the id when it mounts or hears the event.
 */
export const PARTNER_REQUEST_EVENT = 'bwallet:open-partner-request';
let pending: { ticker: string; id: string | null } | null = null;

export const requestPartnerRequest = (ticker: string, id: string | null) => {
  pending = { ticker, id };
  try {
    window.dispatchEvent(new Event(PARTNER_REQUEST_EVENT));
  } catch {
    /* no window (tests) */
  }
};

/** True while a tap is waiting for the Lock page to open. */
export const partnerRequestWaiting = () => pending !== null;

/** The request id for this partnership, once (null id = just open the partnership). Undefined when none is waiting. */
export const takePartnerRequest = (ticker: string): string | null | undefined => {
  if (!pending || pending.ticker !== ticker.toUpperCase()) return undefined;
  const { id } = pending;
  pending = null;
  return id;
};
