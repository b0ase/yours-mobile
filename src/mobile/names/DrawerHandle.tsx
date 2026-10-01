import { useEffect, useState } from 'react';
import { AtSign, MessageCircle } from 'lucide-react';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom } from '../chat/nav';
import { tokenKey } from '../chat/tokenRooms';
import { getPersonalLink, onPersonalChange } from './personalToken';

/**
 * Account drawer: the current account's handle (full paymail / OpNS name) and a link to its
 * personal $NAME room, or a "Get your $name" button. Rendered by the mobile TopNav.
 */
export const DrawerHandle = ({
  identityAddress,
  paymail,
  handle,
  onGetName,
  onNavigate,
}: {
  identityAddress?: string;
  paymail: string;
  handle: string;
  onGetName: () => void;
  onNavigate: () => void;
}) => {
  const { handleSelect } = useBottomMenu();
  const [link, setLink] = useState(() => getPersonalLink(identityAddress));
  useEffect(() => {
    setLink(getPersonalLink(identityAddress));
    return onPersonalChange(() => setLink(getPersonalLink(identityAddress)));
  }, [identityAddress]);

  const name = paymail || handle;
  const roomKey = link ? tokenKey('bsv21', link.tokenId) : null;

  if (!name)
    return (
      <button
        type="button"
        onClick={onGetName}
        className="mx-2 mb-2 flex items-center gap-2 rounded-xl px-3 py-2.5 text-left cursor-pointer"
        style={{ background: '#17191E', border: '1px solid #3a2f0c' }}
      >
        <AtSign size={15} color="#FFD24D" />
        <span className="text-sm font-semibold" style={{ color: '#FFD24D' }}>
          Get your $name
        </span>
      </button>
    );

  return (
    <div
      className="mx-2 mb-2 flex flex-col gap-1.5 rounded-xl px-3 py-2.5"
      style={{ background: '#17191E', border: '1px solid #2b2f36' }}
    >
      <span className="text-[10px] uppercase tracking-widest" style={{ color: '#98A2B3' }}>
        Your handle
      </span>
      <span className="text-sm font-semibold break-all" style={{ color: '#FFD24D' }}>
        {name}
      </span>
      {paymail && handle && (
        <span className="text-[11px]" style={{ color: '#98A2B3' }}>
          OpNS: {handle}
        </span>
      )}
      {roomKey && (
        <button
          type="button"
          onClick={() => {
            requestChatRoom(roomKey);
            onNavigate();
            handleSelect(asMenuItem('chat'));
          }}
          className="self-start mt-0.5 flex items-center gap-1.5 bg-transparent border-0 p-0 cursor-pointer text-xs font-semibold"
          style={{ color: '#FFD24D' }}
        >
          <MessageCircle size={13} />
          Your ${link?.ticker} room{link?.roomTicker ? '' : ' (opening…)'}
        </button>
      )}
    </div>
  );
};
