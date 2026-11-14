/**
 * "Let this one call through" answers (the Seal sheet, pinned-site mints, stream passes).
 *
 * The permission manager stores every non-spending grant it is given and ignores `ephemeral`, with expiry 0 meaning
 * never (b-Aware 25 Oct 2026). Its stored protocol grant is keyed by site, protocol and counterparty only: not the
 * operation, not the keyID. Up to 5.2.56 these answers were a 60-second grant (oneShotGrant), so for a minute anything
 * the site asked on that protocol rode it with no sheet: an encrypt let through for a mint covered a decrypt, a
 * signature or an HMAC of the same records (b-Aware row 207, izkalavender 3 Nov 2026; ferimarliadi9 13 Nov), and a
 * mint's label covered every level-1 call under that name. There is no time-window answer any more.
 */

/**
 * grantPermission arguments that answer ONLY the request in flight. Nothing is stored (guardSharedKeySigning releases
 * a `oneUse` answer without a store write), so:
 *  - the very next call on that protocol finds no grant and comes back to the background to be judged on its own;
 *  - the waiting call is released in the same turn the answer is decided, with no store write to wait for, so no
 *    other call (a decrypt shares an encrypt's request key) can join the request while the answer is on its way;
 *  - a standing grant the user gives meanwhile on a sheet is never overwritten.
 * Without that guard (a bare manager) the expiry still makes it a grant that is already over (1 = one second after
 * 1970; 0 would mean never).
 */
export const oneUseGrant = (requestID: string) => ({ requestID, ephemeral: true, expiry: 1, oneUse: true as const });

/** True for grantPermission arguments built by oneUseGrant. */
export const isOneUseAnswer = (params: unknown): boolean =>
  !!params && typeof params === 'object' && (params as { oneUse?: unknown }).oneUse === true;
