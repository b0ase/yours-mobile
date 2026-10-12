/**
 * Paying a token's indexer (the BSV-21 overlay) only for the exact amount the user confirmed.
 *
 * TERANODE, 12 Oct 2026 (web.bwalletx.com, iOS Safari, 5.2.13): 0.1 BSV went to the TERANODE indexer from the
 * "Overlay not funded" prompt. The prompt hid the amount when the template lookup failed, still showed Fund, never
 * asked twice and never said the payment is not refundable. @1sat/actions fundBsv21Overlay fetches the template
 * itself and pays whatever it says, so it cannot be told what the user agreed to.
 *
 * This wraps it: fetch the template ourselves, refuse if the total differs from the confirmed sats, then run
 * fundBsv21Overlay with a bsv21 service whose getFundingTemplate returns that same checked template, so the action
 * cannot pay a different (newer) amount than the one we compared.
 */

export type FundingTemplate = {
  outputs: { lockingScript: string; satoshis: number; outputDescription: string }[];
};

export const fundingTotal = (template: FundingTemplate | undefined | null): number =>
  (template?.outputs ?? []).reduce((sum, o) => sum + (Number.isFinite(o.satoshis) ? o.satoshis : 0), 0);

/**
 * About how many future token transfers (all holders) the payment covers. sendBsv21 pays fee_per_output per token
 * output, and a normal transfer has two (recipient + change). Undefined when the fee is unknown.
 */
export const transfersCovered = (sats: number, feePerOutput: number | undefined, balance = 0): number | undefined => {
  if (!feePerOutput || feePerOutput <= 0 || sats <= 0) return undefined;
  return Math.floor((sats + Math.max(0, balance)) / (feePerOutput * 2));
};

export const formatBsvAmount = (sats: number): string =>
  `${(sats / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 })} BSV`;

/** The prompt's wording; one place so tests pin it. */
export const fundingCopy = (sats: number, ticker: string, covers: number | undefined): string =>
  `Pays ${formatBsvAmount(sats)} to the ${ticker} indexer. Not refundable.` +
  (covers !== undefined ? ` Covers about ${covers.toLocaleString('en-US')} future transfers for all holders.` : '');

export type FundResult = { txid?: string; error?: string; status?: unknown; templateSats?: number };

type Bsv21Like = { getFundingTemplate(tokenId: string): Promise<FundingTemplate> };
type CtxLike = { services?: { bsv21?: Bsv21Like } };
type FundAction<C> = { execute(ctx: C, input: { tokenId: string }): Promise<FundResult> };

/**
 * Fund the overlay for exactly `confirmedSats`. Never pays without a confirmed positive amount, and refuses with
 * `funding-amount-changed` (templateSats = the new total) when the indexer now asks for something else.
 */
export async function fundOverlayExact<C extends CtxLike>(
  ctx: C,
  tokenId: string,
  confirmedSats: number | undefined,
  action: FundAction<C>,
): Promise<FundResult> {
  if (!confirmedSats || !Number.isFinite(confirmedSats) || confirmedSats <= 0)
    return { error: 'funding-amount-unknown' };
  const bsv21 = ctx.services?.bsv21;
  if (!bsv21) return { error: 'services-required' };
  let template: FundingTemplate;
  try {
    template = await bsv21.getFundingTemplate(tokenId);
  } catch {
    return { error: 'funding-template-unavailable' };
  }
  const total = fundingTotal(template);
  if (total === 0) return { error: 'funding-not-needed', templateSats: 0 };
  if (total !== confirmedSats) return { error: 'funding-amount-changed', templateSats: total };
  // Same object, with the template pinned to the one we checked.
  const pinned = new Proxy(bsv21 as object, {
    get(target, prop) {
      if (prop === 'getFundingTemplate') return async () => template;
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const services = new Proxy(ctx.services as object, {
    get(target, prop) {
      if (prop === 'bsv21') return pinned;
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const pinnedCtx = { ...ctx, services } as C;
  return action.execute(pinnedCtx, { tokenId });
}
