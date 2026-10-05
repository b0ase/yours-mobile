/**
 * Penny Notes ($PNEE): a dollar stablecoin on BSV backed only by BSV locked in public vaults (docs/PENNY-NOTES.md).
 * A BSV-21 token with 2 decimals: 1 unit = 1¢, shown as dollars. Empty until the token is deployed (mainnet pilot).
 */
export const PNEE_TOKEN_ID = '1599c4e49a28c7791295f50613e1545aa9246dd592ae8b8f696b81916a475ae4_0';
export const PNEE_DECIMALS = 2;

/** Navy disc, split gold ring, one gold line curling into two round loops and a tall loop (a nod to MNEE upside down). Inline: no network fetch. */
export const PNEE_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 228 228"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFC93C"/><stop offset="1" stop-color="#F29A1F"/></linearGradient></defs><circle cx="114" cy="114" r="114" fill="#05121F"/><path d="M14 102 A100 100 0 0 1 214 102" fill="none" stroke="url(#g)" stroke-width="14" stroke-linecap="round"/><path d="M214 126 A100 100 0 0 1 14 126" fill="none" stroke="url(#g)" stroke-width="14" stroke-linecap="round"/><path d="M28 116 H78 A21 21 0 1 0 99 137 V82 C99 74 95 70 95 62 A19 16 0 0 1 133 62 C133 70 129 74 129 82 V137 A21 21 0 1 0 150 116 H200" fill="none" stroke="url(#g)" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>',
);

/**
 * PNEEs the 1Sat overlay hasn't indexed yet (its submit endpoint returned 500s in Oct 2026, so transfers went
 * missing there). GorillaPool's older BSV-20/21 index still sees them: sum unspent outputs at these addresses.
 * Display only: spending still needs the overlay to admit the outputs. Returns the amount in dollars (2 decimals).
 */
export const unindexedPnee = async (addresses: string[]): Promise<number> => {
  if (!PNEE_TOKEN_ID) return 0;
  let units = 0;
  for (const a of [...new Set(addresses.filter(Boolean))]) {
    try {
      const r = await fetch(`https://ordinals.gorillapool.io/api/bsv20/${a}/id/${PNEE_TOKEN_ID}`);
      if (!r.ok) continue;
      const rows = (await r.json()) as { amt?: string; spend?: string; status?: number }[];
      for (const o of Array.isArray(rows) ? rows : []) if (!o.spend && o.status === 1) units += Number(o.amt) || 0;
    } catch {
      /* index unreachable: show nothing extra */
    }
  }
  return units / 10 ** PNEE_DECIMALS;
};
