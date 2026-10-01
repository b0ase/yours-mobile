import { MessageCircle } from 'lucide-react';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom } from './nav';
import { tokenKey } from './tokenRooms';

/**
 * "Room" — opens (or starts) this token's chatroom in the Chat tab. Mounted on the Wallet's
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
  if (!key) return null;
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
      Room
    </button>
  );
};
