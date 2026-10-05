/**
 * Penny Notes ($PNEE): a dollar stablecoin on BSV backed only by BSV locked in public vaults (docs/PENNY-NOTES.md).
 * A BSV-21 token with 2 decimals: 1 unit = 1¢, shown as dollars. Empty until the token is deployed (mainnet pilot).
 */
export const PNEE_TOKEN_ID = '';
export const PNEE_DECIMALS = 2;

/** A gold coin with a cent sign, as a data URI (no network fetch). */
export const PNEE_ICON =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f9dd63"/><stop offset="1" stop-color="#de973f"/></linearGradient></defs><circle cx="32" cy="32" r="31" fill="url(#g)"/><circle cx="32" cy="32" r="25" fill="none" stroke="#1a1300" stroke-opacity=".25" stroke-width="2"/><text x="32" y="44" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-weight="800" font-size="34" fill="#1a1300">¢</text></svg>',
  );
