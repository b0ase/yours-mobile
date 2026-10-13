import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { fmtSats, fmtUsd } from '../money/money';
import { usdOrSats } from './opnsSell';

const Sheet = (p: { children: ReactNode }) =>
  createPortal(
    <div
      className="fixed inset-0 z-[420] flex flex-col"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {p.children}
    </div>,
    document.body,
  );

/** The one approval for buying a listed name (Exchange › Names and the bMint search). */
export const OpnsBuySheet = (p: {
  name: string;
  priceSats: number;
  rate: number;
  site: string;
  onAllow: () => void;
  onClose: () => void;
}) => (
  <Sheet>
    <ApprovalCard
      ours
      site="bWalletX"
      siteSub={p.site}
      onClose={p.onClose}
      hero={<PayHero amount={usdOrSats(p.priceSats, p.rate)} sub={fmtSats(p.priceSats)} />}
      title={
        <>
          Buy <span style={{ color: CARD.gold }}>{p.name}</span>
        </>
      }
      primary={{ label: 'Allow', onClick: p.onAllow }}
      secondary={{ label: 'Not now', onClick: p.onClose }}
    >
      <div className="flex flex-wrap gap-2">
        <Chip>OpNS name</Chip>
        <Chip>Plus a small network fee</Chip>
        <Chip>Locked to your wallet</Chip>
      </div>
    </ApprovalCard>
  </Sheet>
);

/** The one approval for listing several names: count and total at the rate shown. */
export const OpnsSellSheet = (p: {
  names: string[];
  totalSats: number;
  totalUsd: number;
  onAllow: () => void;
  onClose: () => void;
}) => (
  <Sheet>
    <ApprovalCard
      ours
      site="bWalletX"
      siteSub="bMint · Sell OpNS names"
      onClose={p.onClose}
      hero={<PayHero amount={fmtUsd(p.totalUsd)} sub={`${fmtSats(p.totalSats)} if all sell`} badge="SELL" />}
      title={
        <>
          List <span style={{ color: CARD.gold }}>{p.names.length}</span> {p.names.length === 1 ? 'name' : 'names'} for
          sale
        </>
      }
      primary={{ label: 'Allow', onClick: p.onAllow }}
      secondary={{ label: 'Not now', onClick: p.onClose }}
    >
      <div className="flex flex-wrap gap-2">
        {p.names.slice(0, 24).map((n) => (
          <Chip key={n}>{n}</Chip>
        ))}
        {p.names.length > 24 && <Chip>+{p.names.length - 24} more</Chip>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Chip>Anyone can buy at this price</Chip>
        <Chip>Cancel any time</Chip>
      </div>
    </ApprovalCard>
  </Sheet>
);

/** Moving a listed name into the Vault: one approval to cancel its listing. */
export const OpnsVaultCancelSheet = (p: {
  name: string;
  onAllow: () => void;
  onKeepListed: () => void;
  onClose: () => void;
}) => (
  <Sheet>
    <ApprovalCard
      ours
      site="bWalletX"
      siteSub="bMint · OpNS Vault"
      onClose={p.onClose}
      hero={<PayHero amount="Vault" sub="Plus a small network fee" badge="KEEP" />}
      title={
        <>
          Keep <span style={{ color: CARD.gold }}>{p.name}</span> and cancel its listing
        </>
      }
      primary={{ label: 'Allow', onClick: p.onAllow }}
      secondary={{ label: 'Vault only, keep listed', onClick: p.onKeepListed }}
    >
      <div className="flex flex-wrap gap-2">
        <Chip>Nobody can buy it after this</Chip>
        <Chip>Never auto-listed again</Chip>
      </div>
    </ApprovalCard>
  </Sheet>
);
