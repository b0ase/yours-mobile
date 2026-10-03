import { MessageCircle, ShoppingCart, Tag } from 'lucide-react';
import type { ReactNode } from 'react';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom, requestMarketToken } from '../chat/nav';
import { tokenKey } from '../chat/tokenRooms';
import { marketTradingEnabled, tokenRoomsEnabled } from '../storeBuild';

/**
 * Buy · Sell · Chat under each token in Wallet › Tokens (owner, 3 Oct 2026). Buy opens the token in
 * the Market, Sell opens the token page (its Sell sheet lists an OrdLock), Chat opens the token's
 * room. Store build: no Buy/Sell (Market view-only) and no rooms, so nothing shows.
 */
export const TokenRowActions = ({ tokenId, onSell }: { tokenId: string; onSell: () => void }) => {
  const { handleSelect } = useBottomMenu();
  const trade = marketTradingEnabled();
  const rooms = tokenRoomsEnabled();
  if (!trade && !rooms) return null;

  const btn = (label: string, icon: ReactNode, onClick: () => void) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex flex-1 items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-bold border-0 outline-none cursor-pointer"
      style={{ background: '#17191E', color: '#FFD24D' }}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="flex w-full gap-2">
      {trade &&
        btn('Buy', <ShoppingCart size={13} />, () => {
          requestMarketToken({ kind: 'bsv21', id: tokenId });
          handleSelect(asMenuItem('market'));
        })}
      {trade && btn('Sell', <Tag size={13} />, onSell)}
      {rooms &&
        btn('Chat', <MessageCircle size={13} />, () => {
          const key = tokenKey('bsv21', tokenId);
          if (key) requestChatRoom(key);
          handleSelect(asMenuItem('chat'));
        })}
    </div>
  );
};
