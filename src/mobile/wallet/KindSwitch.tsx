import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { getMediaView, getWalletKind, setWalletKind, subscribeWalletKind, type WalletKind } from './walletKind';

export const useWalletKind = () => useSyncExternalStore(subscribeWalletKind, getWalletKind, getWalletKind);
export const useMediaView = () => useSyncExternalStore(subscribeWalletKind, getMediaView, getMediaView);

const KINDS: [WalletKind, string][] = [
  ['tokens', 'Tokens'],
  ['nfts', 'NFTs'],
  ['credits', 'Credits'],
];

/** Tokens | NFTs | Credits, styled like Market's type switch (market/MarketPage.tsx). */
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
          className="flex-1 rounded-lg py-2 text-sm font-bold border-0 outline-none cursor-pointer"
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

/** /m/media (the retired Media tab): Wallet on its NFTs view. */
export const WalletNftsRedirect = () => {
  useEffect(() => setWalletKind('nfts'), []);
  return <Navigate to="/bsv-wallet" replace />;
};
