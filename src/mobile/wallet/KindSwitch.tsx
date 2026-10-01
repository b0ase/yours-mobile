import { useSyncExternalStore, type ReactNode } from 'react';
import { getWalletKind, setWalletKind, subscribeWalletKind, type WalletKind } from './walletKind';

export const useWalletKind = () => useSyncExternalStore(subscribeWalletKind, getWalletKind, getWalletKind);

const KINDS: [WalletKind, string][] = [
  ['tokens', 'Tokens'],
  ['nfts', 'NFTs'],
  ['tickets', 'Tickets'],
  ['credits', 'Credits'],
];

/** Tokens | NFTs | Tickets | Credits (four fit a 320px phone: smaller text and padding), styled like Market's type switch (market/MarketPage.tsx). */
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
  useWalletKind() === kind ? <>{children}</> : null;
