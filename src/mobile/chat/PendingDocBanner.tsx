import { useState } from 'react';
import { FileSignature } from 'lucide-react';
import type { ChatRoom } from './messages';
import { docToOffer, signDocUrl } from './pendingDoc';
import { takeRoomDoc } from './segmentNav';
import { bchatxFrameRoute, docHashFor } from './signLink';
import { openDappBrowser } from '../dappBrowser';
import { useNavigate } from 'react-router-dom';

/**
 * "A document is waiting for your signature" at the top of a room: the room's pinned pending_doc, or the one a tapped
 * notification named (owner, 28 Oct 2026: a signable minute posted to $BCORPBOARD rang the phone, and the tap had
 * nowhere to land). Review & sign opens the room's bChatX page on that document (chat/pendingDoc.ts).
 */
const PendingDocBanner = ({ room, inChat }: { room: ChatRoom; inChat?: (docId: string) => boolean }) => {
  // Taken once, when this room opens: a tap for this room (and this document) highlights the banner.
  const navigate = useNavigate();
  const [fromPush] = useState(() => takeRoomDoc(room.ticker));
  const doc = docToOffer(room, fromPush);
  const href = doc ? signDocUrl(room.ticker, doc, docHashFor(room.ticker, doc)) : null;
  // A document whose card in the chat already has its own button needs no second, unnamed one up here.
  if (!href || !doc || inChat?.(doc)) return null;
  return (
    <div
      className="mx-3 mt-2 rounded-2xl px-3 py-2.5 flex items-center gap-3"
      style={{
        background: '#141414',
        border: `1px solid ${fromPush ? 'var(--bw-accent-hi)' : '#1f2127'}`,
      }}
      role="status"
    >
      <FileSignature size={20} color="var(--bw-accent-hi)" className="shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-white">Document waiting for signature</div>
        <div className="text-[11px]" style={{ color: '#8a8f98' }}>
          Read it, sign your block and seal on bChatX.
        </div>
      </div>
      {/* bChatX in the bApp frame, where the seal's approval reaches the wallet (signLink.bchatxFrameRoute); the dApp
          browser / a tab only when bChatX can't be framed. */}
      <button
        type="button"
        onClick={() => {
          const route = bchatxFrameRoute(href);
          if (route) return navigate(route);
          openDappBrowser(href).catch((e) => console.error('[review & sign]', e));
        }}
        className="shrink-0 rounded-xl px-3 py-2 text-[13px] font-bold border-0"
        style={{ background: 'var(--bw-accent-hi)', color: '#1a1300' }}
      >
        Review &amp; sign
      </button>
    </div>
  );
};

export default PendingDocBanner;
