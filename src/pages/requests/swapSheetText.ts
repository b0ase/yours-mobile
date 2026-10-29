import type { SwapSheet } from '../../mobile/p2p/swap/swapActions';

const bsv = (sats: number) => `${(sats / 1e8).toFixed(8)} BSV`;
const usd = (n: number) => `$${n.toFixed(2)}`;

/** Words and rows for the swap sheet. Pure (swapSheetText.test.ts). */
export function swapSheetRows(s: SwapSheet & { originator?: string }) {
  const sym = s.symbol ? `$${s.symbol}` : 'tokens';
  const price = `${bsv(s.priceSats)} (${usd(s.usdAtRate)})`;
  const rows: [string, string][] = [
    [s.side === 'offer' ? 'You give' : 'You get', `${s.tokens} ${sym}`],
    [s.side === 'offer' ? 'You get' : 'You pay', price],
    [
      'Contract price',
      s.terms.priceSats !== undefined
        ? `${s.terms.priceSats.toLocaleString('en-US')} sats`
        : usd(s.terms.priceUsd ?? 0),
    ],
    ['Rate', `$${s.rate.toFixed(2)} per BSV (${s.rateSource})`],
  ];
  if (s.overlayFeeSats > 0) rows.push(['Indexing fee', bsv(s.overlayFeeSats)]);
  rows.push(['Contract', s.terms.ref], ['Document hash', `${s.terms.docHash.slice(0, 16)}…`]);
  if (s.terms.sellerKey) rows.push(['Seller wallet', `${s.terms.sellerKey.slice(0, 16)}…`]);
  if (s.terms.expiresAt)
    rows.push(['Offer expires', new Date(s.terms.expiresAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC']);
  const title =
    s.side === 'offer'
      ? `Offer ${s.tokens} ${sym} for ${usd(s.usdAtRate)}`
      : `Swap ${usd(s.usdAtRate)} for ${s.tokens} ${sym}`;
  const note =
    s.side === 'offer'
      ? `${s.split ? `First the wallet sets aside exactly ${s.tokens} ${sym} (a small token send to yourself). ` : ''}Then it signs your half only: your tokens move only in the buyer's transaction, which must pay you ${price}. Nothing is broadcast now.`
      : 'One transaction: the tokens come to you and the price goes to the seller, with the contract hash on chain. If it does not broadcast, nothing moves.';
  return { title, rows, note, action: s.side === 'offer' ? 'Sign offer' : 'Pay and swap' };
}
