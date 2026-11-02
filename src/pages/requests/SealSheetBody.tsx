import type { ReactNode } from 'react';
import type { SealSheet } from '../../services/sealPass';
import { Check, Chip } from '../../components/approval/ApprovalCard';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { CARD } from '../../components/approval/cardTheme';

/**
 * The one Seal sheet (services/sealPass.ts, owner 2 Nov 2026): what is sealed, by whom, where, and the most it can
 * cost, on one card with one button. The hero is the document's fingerprint, the same "#…" the phone shows under the
 * document, so the two can be matched at a glance. Used by BundleSheet; kept apart so it can be previewed alone.
 */
export const SEAL_SITE_SUB = 'One approval: signs and seals';
export const SEAL_BUTTON = 'Seal';

export const SealHero = ({ seal }: { seal: SealSheet }) => (
  <PayHero
    amount={`#${seal.docHash.slice(0, 8)}`}
    sub="Document fingerprint, as under the document"
    badge="SEAL"
    fontSize="min(60px, 8vh)"
  />
);

export const SealTitle = ({ seal }: { seal: SealSheet }) => <span style={{ color: CARD.gold }}>{seal.title}</span>;

export const SealSheetBody = (props: { seal: SealSheet; feeText: string; signingAs?: ReactNode }) => {
  const { seal, feeText, signingAs } = props;
  return (
    <div className="flex flex-col" style={{ gap: 8 }} data-testid="seal-sheet">
      <div
        className="flex items-center gap-2 flex-wrap"
        style={{ fontSize: 15, fontWeight: 600 }}
        data-testid="seal-signer"
      >
        <Check size={18} />
        Signed as <span style={{ color: CARD.gold }}>${seal.handle.replace(/^\$/, '')}</span>
        {seal.roles.length > 0 && <span style={{ color: CARD.muted, fontWeight: 400 }}>· {seal.roles.join(', ')}</span>}
      </div>
      <div className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 600 }} data-testid="seal-cost">
        <Check size={18} />
        Network fee only, at most {feeText}
      </div>
      <div className="flex flex-wrap" style={{ gap: 8 }}>
        <Chip>
          <Check />
          Only on {seal.site}
        </Chip>
        <Chip>
          <Check />
          Hashes on chain, not the document
        </Chip>
        <Chip>
          <Check />
          Next payment asks again
        </Chip>
      </div>
      {signingAs && (
        <p className="m-0" data-testid="signing-as" style={{ fontSize: 12, color: CARD.muted }}>
          Signing with {signingAs}
        </p>
      )}
    </div>
  );
};
