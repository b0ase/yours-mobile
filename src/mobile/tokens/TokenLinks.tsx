/**
 * A token's website / app / X / Telegram / bChat links (linkData.ts), as small chips showing the domain.
 * Renders nothing when the token has none. Every link is external: a tap asks first, then opens it in the
 * in-app dApp browser (a new tab on web and extension).
 */
import { useEffect, useState } from 'react';
import { AppWindow, Globe, MessageCircle, Send } from 'lucide-react';
import { openDappBrowser } from '../dappBrowser';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom } from '../chat/nav';
import { tokenKey } from '../chat/tokenRooms';
import { tokenRoomsEnabled } from '../storeBuild';
import { fetchDeployJson, parseLinks, parseUtility, type LinkKind, type TokenLink } from './linkData';

const XMark = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden fill="currentColor">
    <path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
  </svg>
);
const ICON: Record<LinkKind, React.ReactNode> = {
  website: <Globe size={12} />,
  app: <AppWindow size={12} />,
  x: <XMark />,
  telegram: <Send size={12} />,
  bchat: <MessageCircle size={12} />,
};
const NAME: Record<LinkKind, string> = { website: 'Website', app: 'App', x: 'X', telegram: 'Telegram', bchat: 'bChat' };

/**
 * A token's profile lines: the default right (holders can enter its room), the issuer's own Utility
 * statement when published, and its links. `room={false}` where the page already has a room button row.
 */
export const TokenLinks = ({
  tokenId,
  sym,
  extra,
  room = true,
}: {
  tokenId?: string;
  sym?: string;
  extra?: unknown;
  room?: boolean;
}) => {
  const { handleSelect } = useBottomMenu();
  const [deploy, setDeploy] = useState<unknown>(null);
  const [ask, setAsk] = useState<TokenLink | null>(null);
  useEffect(() => {
    let live = true;
    setDeploy(null);
    if (tokenId) void fetchDeployJson(tokenId).then((j) => live && setDeploy(j));
    return () => {
      live = false;
    };
  }, [tokenId]);
  // The issuer's own on-chain deploy fields lead; a launchpad's API fills gaps.
  const links = parseLinks(deploy, extra);
  const utility = parseUtility(deploy, extra);
  const key = tokenId && room && tokenRoomsEnabled() ? tokenKey('bsv21', tokenId.replace('.', '_')) : null;
  if (!links.length && !utility && !key) return null;
  const ticker = sym ? `$${sym.replace(/^\$/, '')}` : 'this token';
  return (
    <div className="flex flex-col gap-1.5">
      {key && (
        <button
          type="button"
          onClick={() => {
            requestChatRoom(key);
            handleSelect(asMenuItem('chat'));
          }}
          className="self-start text-left text-[11px] text-[#98A2B3]"
        >
          Holders can enter the <span style={{ color: '#FFD24D', fontWeight: 600 }}>{ticker} room ›</span>
        </button>
      )}
      {utility && (
        <p className="text-[11px] text-[#98A2B3] m-0 break-words">
          <span className="font-semibold text-[#D0D5DD]">Issuer says:</span> {utility}{' '}
          <span className="text-[#667085]">(not checked by bWalletX)</span>
        </p>
      )}
      <div className="flex flex-wrap gap-1.5" aria-label="Token links">
        {links.map((l) => (
          <button
            key={l.kind}
            type="button"
            onClick={() => setAsk(l)}
            title={`${NAME[l.kind]}: ${l.label}`}
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold max-w-[60%]"
            style={{ background: '#0F1013', color: '#D0D5DD', border: '1px solid #2b2f36' }}
          >
            {ICON[l.kind]}
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{l.label}</span>
          </button>
        ))}
      </div>
      {ask && (
        <div className="flex flex-col gap-2 rounded-xl p-3 border" style={{ background: '#0F1013', borderColor: '#3a2f0c' }}>
          <p className="text-xs text-white m-0 break-all">
            Open {NAME[ask.kind]} <b>{ask.label}</b>?
          </p>
          <p className="text-[11px] text-[#98A2B3] m-0">
            The token&apos;s issuer set this link. It&apos;s an outside site that bWalletX hasn&apos;t checked; never enter your
            recovery phrase there.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setAsk(null)}
              className="flex-1 h-9 rounded-lg text-xs font-semibold bg-[#2b2f36] text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const url = ask.url;
                setAsk(null);
                void openDappBrowser(url);
              }}
              className="flex-1 h-9 rounded-lg text-xs font-bold"
              style={{ background: '#FFD24D', color: '#010101' }}
            >
              Open
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
