/**
 * The description the wallet gives a Store payment (payQuote / payBuyQuote), with nothing else of the Store in this
 * module, so a store build can still recognise one (13 Nov 2026).
 *
 * A store build has no paid Store and no theme orders (storeBuild.ts THEME_STORE_PAID_ENABLED; docs/STORE-AUDIT.md: no
 * `api/theme-orders` / `bwx-theme-order` in its bundle), so it never makes or asks about a Store payment. It can still
 * HOLD one: device sync brings the account's unsent ('nosend') rows from a bWalletX device that paid the Store. Such a
 * payment must get the same longer cross-device hold there as on any other device that didn't make it
 * (services/unsentExpiry.ts 1b, STORE_OTHER_DEVICE_TTL_S), never the shorter default.
 */
import type { StoreKind } from '../../services/unsentExpiry';

/** The descriptions payQuote / payBuyQuote give their payments (wallet/txHistory.ts labels them by these). */
export const STORE_PAYMENT_DESC = /^(Theme purchase · |bWalletX theme edition$)/;

/**
 * services/unsentExpiry.ts storeKind in a store build: a payment described as a Store payment is 'other-device' (this
 * build can't have made it), anything else 'not-store'. The description alone, without the memo check
 * (storeHeard.ts storePaymentOf), can only match MORE actions than the full check does, and a match only lengthens the
 * hold; 'mine' (the early release) is never returned, and a store build wires no storeAsk for it anyway.
 */
export const storeKindSynced = async (a: { description?: string }): Promise<StoreKind> =>
  STORE_PAYMENT_DESC.test(a.description ?? '') ? 'other-device' : 'not-store';
