import { useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { TopNav } from '../../components/TopNav';
import { lastUrlFor, openDappBrowser } from '../dappBrowser';

/**
 * Chat tab (v1): bChat in the in-app dApp browser, so it gets window.CWI and
 * signs in with this wallet. Reopens where bChat last was this session.
 */
const BCHAT = 'https://www.bitcoinchat.online';

const ChatPage = () => {
  const [error, setError] = useState('');
  const openChat = () => {
    setError('');
    openDappBrowser(lastUrlFor(new URL(BCHAT).origin) ?? BCHAT).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };
  useEffect(openChat, []);

  return (
    <div className="flex w-full flex-col items-center pb-20" style={{ height: 'calc(75%)', background: '#010101' }}>
      <TopNav />
      <div className="w-full px-6 pt-32 flex flex-col items-center gap-3 text-center">
        <img
          src="https://www.bitcoinchat.online/bchat-apple-touch-icon.png"
          alt=""
          className="h-16 w-16 rounded-2xl"
          onError={(e) => (e.currentTarget.style.display = 'none')}
        />
        <h1 className="text-lg font-bold text-white">bChat</h1>
        <p className="text-xs text-[#98A2B3]">Chat, voice and video messages, tokenised group chats. Signs in with this wallet.</p>
        <button
          onClick={openChat}
          className="mt-2 flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold"
          style={{ background: '#A1FF8B', color: '#010101' }}
        >
          <MessageCircle size={16} /> Open bChat
        </button>
        {error && <p className="text-xs text-[#F97066]">{error}</p>}
      </div>
    </div>
  );
};

export default ChatPage;
