import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { Check } from 'lucide-react';
import { playChime } from '../../components/sent/chime';
import { useServiceContext } from '../../hooks/useServiceContext';
import { artDataUri, receiptArtUrl } from '../storeReceipt/art';
import { getBuyQuote, payBuyQuote, type BuyQuote, type BuyResult } from '../themeOrder/api';

const f: typeof fetch = (u, i) => fetch(u, i);

type Step =
  | { k: 'quoting' }
  | { k: 'ready'; q: BuyQuote }
  | { k: 'paying'; q: BuyQuote }
  | { k: 'error'; msg: string; q?: BuyQuote }
  | { k: 'done'; res: BuyResult };

/**
 * Buy one store theme ($1): the server's quote → ONE approval sheet → Pay. The wallet builds the payment without
 * sending it and the server checks and broadcasts it, so a refused claim moves no money (themeOrder/api.ts).
 */
export function BuySheet({
  pack,
  label,
  onDone,
  onClose,
}: {
  pack: string;
  label: string;
  /** After a successful buy: the pack is owned; `apply` is true when they tapped Apply now. */
  onDone: (apply: boolean) => void;
  onClose: () => void;
}) {
  const { apiContext } = useServiceContext();
  const [step, setStep] = useState<Step>({ k: 'quoting' });
  const [details, setDetails] = useState(false);
  const [bigReceipt, setBigReceipt] = useState(false);
  useEffect(() => {
    let live = true;
    getBuyQuote(f, apiContext.wallet, pack)
      .then((q) => live && setStep({ k: 'ready', q }))
      .catch((e) => live && setStep({ k: 'error', msg: e instanceof Error ? e.message : 'Could not get a price' }));
    return () => {
      live = false;
    };
  }, [apiContext.wallet, pack]);

  const pay = async () => {
    if (step.k !== 'ready') return;
    const q = step.q;
    setStep({ k: 'paying', q });
    try {
      // The shop's picture on the receipt (owner: an NPG purchase prints NPG art); plain gold if it can't load.
      const art = await artDataUri(receiptArtUrl(pack));
      const res = await payBuyQuote(apiContext, f, q, { label, art });
      setStep({ k: 'done', res });
      playChime();
    } catch (e) {
      setStep({ k: 'error', msg: e instanceof Error ? e.message : 'Payment failed', q });
    }
  };

  if (step.k === 'done') {
    const { res } = step;
    const svgUri = res.receiptSvg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(res.receiptSvg)}` : null;
    return createPortal(
      <div
        role="dialog"
        aria-label={`You own ${label}`}
        className="fixed inset-0 z-[1110] flex flex-col items-center overflow-y-auto px-5"
        style={{
          background: CARD.bg,
          paddingTop: 'calc(env(safe-area-inset-top) + 40px)',
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 24px)',
        }}
      >
        <div
          className="flex items-center justify-center rounded-full"
          style={{ width: 72, height: 72, background: CARD.gold, color: '#0B0A08' }}
        >
          <Check size={40} strokeWidth={3} aria-hidden="true" />
        </div>
        <h2 className="m-0 mt-4 text-center text-2xl font-extrabold text-white">
          You own <span style={{ color: CARD.gold }}>{label}</span>!
        </h2>
        <p className="m-0 mt-1 text-center text-sm" style={{ color: '#98A2B3' }}>
          Thank you. It's yours to keep, on every device you sign in to.
        </p>
        {svgUri ? (
          <>
            <button
              type="button"
              aria-label="View receipt"
              onClick={() => setBigReceipt(true)}
              className="mt-5 w-full max-w-[360px] cursor-pointer border-0 bg-transparent p-0"
            >
              <img src={svgUri} alt={`Receipt for ${label}`} className="block w-full rounded-2xl" />
            </button>
            <p className="m-0 mt-2 text-center text-xs" style={{ color: '#98A2B3' }}>
              Receipt saved to your Collectibles.{' '}
              <button
                type="button"
                onClick={() => setBigReceipt(true)}
                className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold underline"
                style={{ color: CARD.gold }}
              >
                View receipt
              </button>
            </p>
          </>
        ) : (
          <p className="m-0 mt-5 text-center text-xs" style={{ color: '#98A2B3' }}>
            Paid · {res.txid.slice(0, 10)}…
          </p>
        )}
        <div className="mt-6 flex w-full max-w-[360px] flex-col gap-2">
          <button
            type="button"
            onClick={() => onDone(true)}
            className="min-h-[48px] cursor-pointer rounded-2xl border-0 text-base font-bold"
            style={{ background: CARD.gold, color: '#0B0A08' }}
          >
            Apply now
          </button>
          <button
            type="button"
            onClick={() => onDone(false)}
            className="min-h-[44px] cursor-pointer rounded-2xl border border-[#2b2f36] bg-transparent text-sm font-semibold text-white"
          >
            Done
          </button>
        </div>
        {bigReceipt && svgUri && (
          <div
            role="dialog"
            aria-label="Receipt"
            className="fixed inset-0 z-[1111] flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,.92)' }}
            onClick={() => setBigReceipt(false)}
          >
            <img src={svgUri} alt={`Receipt for ${label}`} className="block max-h-full w-full max-w-[640px] rounded-2xl" />
          </div>
        )}
      </div>,
      document.body,
    );
  }

  const q = step.k === 'quoting' ? undefined : step.q;
  const busy = step.k === 'paying' || step.k === 'quoting';
  return createPortal(
    <div
      className="fixed inset-0 z-[1110] flex flex-col"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <ApprovalCard
        ours
        site="bWalletX"
        siteSub="Store"
        onClose={onClose}
        closeLabel="Close"
        closeDisabled={step.k === 'paying'}
        hero={
          <PayHero
            amount={`$${q?.usd ?? 1}`}
            sub={q ? `${q.sats.toLocaleString()} sats · yours to keep` : 'Getting the price…'}
          />
        }
        title={
          <>
            Buy <span style={{ color: CARD.gold }}>{label}</span>
          </>
        }
        primary={{
          label: step.k === 'paying' ? 'Paying…' : `Pay $${q?.usd ?? 1}`,
          onClick: () => void pay(),
          disabled: busy || !q,
          busy: step.k === 'paying',
        }}
        secondary={{ label: 'Not now', onClick: onClose, disabled: step.k === 'paying' }}
        details={
          q ? (
            <span>
              {q.sats.toLocaleString()} sats to bWalletX for the {label} theme, with a purchase reference on chain. The
              price holds until {new Date(q.expires_at).toLocaleTimeString()}.
            </span>
          ) : undefined
        }
        detailsOpen={details}
        onToggleDetails={() => setDetails(!details)}
        error={step.k === 'error' ? step.msg : undefined}
      >
        <div className="flex flex-wrap" style={{ gap: 8 }}>
          <Chip>Theme</Chip>
          <Chip>Yours to keep</Chip>
          <Chip>Paid in BSV</Chip>
        </div>
      </ApprovalCard>
    </div>,
    document.body,
  );
}
