import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getBuyQuote, payBuyQuote, type BuyQuote } from '../themeOrder/api';

const f: typeof fetch = (u, i) => fetch(u, i);

type Step =
  | { k: 'quoting' }
  | { k: 'ready'; q: BuyQuote }
  | { k: 'paying'; q: BuyQuote }
  | { k: 'error'; msg: string; q?: BuyQuote };

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
  onDone: () => void;
  onClose: () => void;
}) {
  const { apiContext } = useServiceContext();
  const [step, setStep] = useState<Step>({ k: 'quoting' });
  const [details, setDetails] = useState(false);
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
      await payBuyQuote(apiContext, f, q);
      onDone();
    } catch (e) {
      setStep({ k: 'error', msg: e instanceof Error ? e.message : 'Payment failed', q });
    }
  };

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
