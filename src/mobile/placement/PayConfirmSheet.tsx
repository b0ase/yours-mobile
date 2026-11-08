/**
 * bShares: what a Pay tap is about to do, shown before anything is signed (review 8 Nov 2026, #3). The amount dollars
 * first with the sats under it (utils/dollarsFirst, as every approval sheet), the company treasury it goes to, and the
 * issuer's terms from the quote, which paying agrees to. Cancel comes first and has the focus; then Pay. After
 * "a payment may have gone out" (payFlow check-first), the warning heads the sheet and Cancel is the filled button.
 * Theme colours only (no dark card on light packs), gold accent. Lazy PLACEMENT_ENABLED chunk only (store-safe).
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { useBackClose } from '../backStack';
import { fetchExchangeRate } from '../../utils/wallet';
import { dollarsFirst, dollarsInline, priceFrom, type PriceState } from '../../utils/dollarsFirst';
import { bsv, pounds, tickerLabel, type Company, type PlacementOffer } from './placement';
import type { PlacementQuote } from './api';

const INK = 'var(--bw-text)';
const MUTED = 'var(--bw-muted)';
const LINE = 'var(--bw-line)';
const GOLD = 'var(--bw-accent)';

export const PayConfirmSheet = ({
  company,
  offer,
  quote,
  warning,
  onPay,
  onCancel,
}: {
  company: Company;
  offer: PlacementOffer;
  quote: PlacementQuote;
  /** Set when an earlier payment may have gone out: shown first, and Pay becomes "Pay again anyway". */
  warning?: string | null;
  onPay: () => void | Promise<void>;
  onCancel: () => void;
}) => {
  const [price, setPrice] = useState<PriceState>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    fetchExchangeRate('main')
      .then((r) => live && setPrice(priceFrom(r, true)))
      .catch(() => live && setPrice({ status: 'unavailable' }));
    return () => {
      live = false;
    };
  }, []);
  useBackClose(true, onCancel);
  const sats = quote.outputs[0]?.satoshis ?? offer.sats;
  const amount = dollarsFirst(sats, price);
  const t = company.treasury ?? quote.offer?.treasury ?? null;
  const terms = quote.terms_text?.trim();
  const filled = { background: GOLD, color: 'var(--bw-on-accent)', border: `1px solid ${GOLD}` };
  const outline = { background: 'transparent', color: INK, border: `1px solid ${LINE}` };
  const sheet = (
    <div className="fixed inset-0 z-[200] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Confirm bShares payment"
        className="w-full rounded-t-3xl px-5 pt-5 flex flex-col gap-3 max-h-[92vh] overflow-y-auto"
        style={{
          background: 'var(--bw-surface)',
          color: INK,
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-bold">
          Pay for {offer.shares.toLocaleString('en-GB')} {tickerLabel(offer.ticker)} shares
        </div>
        {warning && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl px-3 py-2 text-sm"
            style={{ background: 'rgba(245,158,11,0.12)', color: INK }}
          >
            <AlertTriangle size={16} className="shrink-0 mt-0.5" style={{ color: '#F59E0B' }} aria-hidden="true" />
            <span>{warning}</span>
          </div>
        )}
        <div className="flex flex-col items-center gap-0.5 py-1">
          <div className="text-4xl font-extrabold" style={{ color: GOLD }}>
            {amount.main}
          </div>
          <div className="text-xs" style={{ color: MUTED }}>
            {amount.sub}
          </div>
        </div>
        <div className="text-sm text-center">
          to <b>{company.name}</b> treasury{t ? ` (${t.m}-of-${t.n})` : ''}
        </div>
        <p className="m-0 text-xs text-center" style={{ color: MUTED }}>
          {pounds(offer.pricePence)} a share · {bsv(sats)} at {pounds(offer.gbpPerBsvPence)}/BSV ({offer.rateDate})
        </p>
        <div className="flex flex-col gap-1">
          <div className="text-xs font-bold" style={{ color: MUTED }}>
            The issuer&apos;s terms
          </div>
          <div
            className="rounded-xl px-3 py-2 text-xs whitespace-pre-wrap overflow-y-auto"
            style={{ border: `1px solid ${LINE}`, maxHeight: '32vh', color: INK }}
            tabIndex={0}
            aria-label="The issuer's terms"
          >
            {terms || 'The issuer has not published terms text for this offer.'}
          </div>
          <p className="m-0 text-[11px]" style={{ color: MUTED }}>
            Paying agrees to these terms. Nothing is signed until you tap Pay.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            data-testid="bshares-sheet-cancel"
            autoFocus
            onClick={onCancel}
            className="flex-1 h-12 rounded-xl text-sm font-bold cursor-pointer"
            style={warning ? filled : outline}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid={warning ? 'bshares-sheet-pay-anyway' : 'bshares-sheet-pay'}
            onClick={onPay}
            className="flex-1 h-12 rounded-xl text-sm font-bold cursor-pointer"
            style={warning ? outline : filled}
          >
            {warning ? 'Pay again anyway' : `Pay ${dollarsInline(sats, price)}`}
          </button>
        </div>
      </div>
    </div>
  );
  // No document outside a browser (unit tests render the tree directly).
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body);
};
