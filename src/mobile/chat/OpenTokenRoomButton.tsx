import { tokenRoomsEnabled } from '../storeBuild';
import { MessageCircle, ShoppingCart } from 'lucide-react';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom, requestMarketToken } from './nav';
import { tokenKey } from './tokenRooms';

/**
 * "Chat" — opens (or starts) this token's chatroom in the Chat tab. Mounted on the Wallet's
 * token page by a build-time insert (vite.config.mobile.ts → SendBsv21View) and on Market token
 * pages.
 */
export const OpenTokenRoomButton = ({
  kind = 'bsv21',
  id,
  className,
  style,
}: {
  kind?: 'bsv21' | 'coll';
  id: string | undefined;
  className?: string;
  style?: React.CSSProperties;
}) => {
  const { handleSelect } = useBottomMenu();
  const key = id ? tokenKey(kind, id) : null;
  // Store build: token rooms don't open (storeBuild.ts).
  if (!key || !tokenRoomsEnabled()) return null;
  return (
    <button
      type="button"
      onClick={() => {
        requestChatRoom(key);
        handleSelect(asMenuItem('chat'));
      }}
      className={
        className ??
        'flex items-center justify-center gap-2 flex-1 h-11 rounded-xl text-sm font-bold outline-none border cursor-pointer'
      }
      style={style ?? { background: '#17191E', borderColor: '#3a2f0c', color: '#FFD24D' }}
    >
      <MessageCircle size={14} />
      Chat
    </button>
  );
};

/** Token page "Buy": that token's page in bWalletX's own Market tab (not the external 1Sat site). */
export const BuyTokenButton = ({ kind = 'bsv21', id }: { kind?: 'bsv21' | 'coll'; id: string | undefined }) => {
  const { handleSelect } = useBottomMenu();
  if (!id) return null;
  return (
    <button
      type="button"
      onClick={() => {
        requestMarketToken({ kind, id });
        handleSelect(asMenuItem('market'));
      }}
      className="flex items-center justify-center gap-2 flex-1 h-11 rounded-xl text-sm font-bold outline-none border cursor-pointer"
      style={{ background: '#17191E', borderColor: '#3a2f0c', color: '#FFD24D' }}
    >
      <ShoppingCart size={14} />
      Buy
    </button>
  );
};
