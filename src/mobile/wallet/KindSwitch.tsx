import { useSyncExternalStore, type ReactNode } from 'react';
import { getWalletKind, setWalletKind, subscribeWalletKind, type WalletKind } from './walletKind';
import { walletKindsFor } from '../storeBuild';

export const useWalletKind = () => useSyncExternalStore(subscribeWalletKind, getWalletKind, getWalletKind);

// Store build: no Tickets (storeBuild.ts). Credits ($BCREDIT) are shelved in every build (2 Oct 2026):
// the code stays (src/mobile/credits, WalletKindGate kind="credits") but nothing opens it.
const KINDS: [WalletKind, string][] = walletKindsFor<[WalletKind, string]>([
  ['tokens', 'Tokens'],
  ['nfts', 'NFTs'],
  ['tickets', 'Tickets'],
]);
const SHOWN = new Set(KINDS.map(([k]) => k));

/** Tokens | NFTs | Tickets (sized so four fit a 320px phone), styled like Market's type switch (market/MarketPage.tsx). */
export const WalletKindSwitch = () => {
  const kind = useWalletKind();
  return (
    <div
      className="w-[92%] mx-auto mt-6 mb-3 flex gap-1 rounded-xl p-1 bg-[#17191E]"
      role="tablist"
      aria-label="Wallet type"
    >
      {KINDS.map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={kind === id}
          onClick={() => setWalletKind(id)}
          className="flex-1 min-w-0 rounded-lg py-2 px-0.5 text-[13px] font-bold border-0 outline-none cursor-pointer"
          style={{ background: kind === id ? '#A1FF8B' : 'transparent', color: kind === id ? '#010101' : '#98A2B3' }}
        >
          {label}
        </button>
      ))}
    </div>
  );
};

/** Renders its children only while the Wallet shows `kind`. */
export const WalletKindGate = ({ kind, children }: { kind: WalletKind; children: ReactNode }) =>
  useWalletKind() === kind && SHOWN.has(kind) ? <>{children}</> : null;
