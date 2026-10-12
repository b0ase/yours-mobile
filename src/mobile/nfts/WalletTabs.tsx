import { useNavigate } from 'react-router-dom';
import { setWalletKind, type WalletKind } from '../wallet/walletKind';
import { STORE_BUILD, STORE_HIDDEN_WALLET_KINDS } from '../storeBuild';

/**
 * Desktop Wallet section tabs (owner, 12 Oct 2026): Tokens | NFTs | Friends | Tickets | Credits. Tokens is
 * a view of /wallet (walletKind.ts); NFTs, Friends, Tickets and Credits are their own pages at /wallet/nfts, /wallet/friends, /wallet/tickets and
 * /wallet/credits (url/publicUrl.ts). Kinds a store edition hides stay hidden.
 */
const TABS: { id: WalletKind; label: string; to: string }[] = [
  { id: 'tokens', label: 'Tokens', to: '/bsv-wallet' },
  { id: 'nfts', label: 'NFTs', to: '/m/nfts' },
  { id: 'friends', label: 'Friends', to: '/m/friends' },
  { id: 'tickets', label: 'Tickets', to: '/m/tickets' },
  { id: 'credits', label: 'Credits', to: '/m/credits' },
];

const walletTabs = () => TABS.filter((t) => !(STORE_BUILD && STORE_HIDDEN_WALLET_KINDS.includes(t.id)));

export const WalletTabs = ({ active }: { active: WalletKind }) => {
  const navigate = useNavigate();
  return (
    <div className="flex gap-1 px-4 pt-3" role="tablist" aria-label="Wallet">
      {walletTabs().map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === active}
          onClick={() => {
            if (t.to === '/bsv-wallet') setWalletKind(t.id);
            navigate(t.to);
          }}
          className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${
            t.id === active ? 'bg-[#F5B800] text-[#010101]' : 'text-[#D0D5DD] hover:bg-white/10'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
};
