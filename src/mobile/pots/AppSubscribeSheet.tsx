import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { siteName } from '../../services/approvalKind';
import type { AppSubscribeRequest } from './appSubscribe';
import { listPots } from './pots';

/**
 * The ONE approval sheet for "Subscribe with bWalletX" (docs/SUBSCRIBE-API.md), in the approval-card style: dollars
 * a month as the hero, who it pays, which pot pays it, and one Subscribe button. Nothing is paid by this sheet; the
 * charger (payDue.ts) pays the first month from the chosen pot right after, through the pot's spend limits.
 */
export const AppSubscribeSheet = (p: { req: AppSubscribeRequest; onAnswer: (potId: string | null) => void }) => {
  const pots = listPots();
  const [potId, setPotId] = useState(pots[0]?.identityAddress ?? '');
  const [details, setDetails] = useState(false);
  const site = siteName(p.req.appOrigin);
  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex flex-col"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
      role="dialog"
      aria-modal="true"
    >
      <ApprovalCard
        site={site}
        siteSub="wants a monthly subscription"
        onClose={() => p.onAnswer(null)}
        hero={<PayHero amount={`$${p.req.usdPerMonth.toFixed(2)}`} sub="a month" badge="SUBSCRIBE" />}
        title={
          <>
            Subscribe to <span style={{ color: CARD.gold }}>{p.req.merchantName}</span>
          </>
        }
        primary={{ label: 'Subscribe', onClick: () => p.onAnswer(potId), disabled: !potId }}
        secondary={{ label: 'Not now', onClick: () => p.onAnswer(null) }}
        error={pots.length ? undefined : 'Make a pot first (Pots & Locks), then try again. Only a pot can pay.'}
        detailsOpen={details}
        onToggleDetails={() => setDetails((d) => !d)}
        details={
          <div className="flex flex-col gap-1" style={{ fontSize: 13, color: CARD.muted }}>
            {p.req.description && <div>{p.req.description}</div>}
            <div>Pays: {p.req.payTo}</div>
            <div>Asked by: {p.req.appOrigin}</div>
            <div>
              Charged once a month in BSV at that day&apos;s rate, when you open the wallet. A missed month is paid
              once, never stacked. Nothing is locked or paid ahead.
            </div>
          </div>
        }
        testId="app-subscribe-sheet"
      >
        <div className="flex flex-wrap gap-2">
          <Chip>First month today</Chip>
          <Chip>Cancel any time</Chip>
          <Chip>Paid in BSV</Chip>
        </div>
        {pots.length > 0 && (
          <label className="flex items-center gap-2" style={{ fontSize: 14 }}>
            <span style={{ color: CARD.muted }}>Pays from</span>
            <select
              value={potId}
              onChange={(e) => setPotId(e.target.value)}
              className="flex-1 rounded-xl px-3 py-2"
              style={{ background: CARD.chip, color: CARD.ink, border: 0, fontSize: 14 }}
              aria-label="Pot that pays"
            >
              {pots.map((pot) => (
                <option key={pot.identityAddress} value={pot.identityAddress}>
                  {pot.emoji ? `${pot.emoji} ` : ''}
                  {pot.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </ApprovalCard>
    </div>,
    document.body,
  );
};
