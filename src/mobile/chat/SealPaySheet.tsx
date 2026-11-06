import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ApprovalCard, Check, Chip } from '../../components/approval/ApprovalCard';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { CARD } from '../../components/approval/cardTheme';
import { dollarsFirst, type PriceState } from '../../utils/dollarsFirst';
import type { SealSheetInfo } from './sealScreen';

/**
 * The native seal's payment approval: the wallet's own approval card (components/approval/ApprovalCard + PayHero,
 * the same sheet the phone shows for card, theme, name and subscription payments), dollars first. Shown EVERY time
 * the Sign & seal button is pressed (sealApproval.approveSealWithSheet); Approve then asks Face ID / passcode, or the
 * wallet password. Cancel / ✕: nothing signed, nothing paid.
 */
export const SealPaySheet = (p: {
  info: SealSheetInfo;
  price: PriceState;
  busy: boolean;
  onApprove: () => void;
  onCancel: () => void;
}) => {
  const [details, setDetails] = useState(false);
  const { info } = p;
  const amount = info.feeSats ? dollarsFirst(info.feeSats, p.price) : null;
  return createPortal(
    <div
      className="fixed inset-0 z-[1110] flex flex-col"
      data-testid="seal-pay-sheet"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <ApprovalCard
        ours
        site="bWalletX"
        siteSub={`$${info.ticker} room · sign and seal`}
        onClose={p.onCancel}
        closeLabel="Cancel"
        closeDisabled={p.busy}
        hero={
          <PayHero
            amount={amount ? amount.main : 'Network fee'}
            sub={amount ? `about ${amount.sub}` : undefined}
            badge="SEAL"
          />
        }
        title={
          <>
            Seal <span style={{ color: CARD.gold }}>{info.title}</span> on Bitcoin
          </>
        }
        primary={{
          label: p.busy ? 'Confirming…' : 'Approve & seal',
          onClick: p.onApprove,
          disabled: p.busy,
          busy: p.busy,
        }}
        secondary={{ label: 'Cancel', onClick: p.onCancel, disabled: p.busy }}
        details={
          <span>
            Signs {info.blocks === 1 ? 'your signature block' : `${info.blocks} signature blocks`} with your wallet key
            and puts the document&apos;s hashes on chain in one transaction (the document itself stays private). You pay
            only the network fee, from ${info.handle}&apos;s wallet. Every seal asks here first.
          </span>
        }
        detailsOpen={details}
        onToggleDetails={() => setDetails(!details)}
      >
        <div className="flex flex-col" style={{ gap: 8 }}>
          <div className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 600 }}>
            <Check size={18} />
            From <span style={{ color: CARD.gold }}>${info.handle}</span>&apos;s wallet
          </div>
          <div className="flex flex-wrap" style={{ gap: 8 }}>
            <Chip>Room ${info.ticker}</Chip>
            <Chip>
              <span className="font-mono">#{info.docHash}</span>
            </Chip>
          </div>
        </div>
      </ApprovalCard>
    </div>,
    document.body,
  );
};
