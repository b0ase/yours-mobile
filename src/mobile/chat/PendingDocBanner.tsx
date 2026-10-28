import { useState } from 'react';
import { FileSignature } from 'lucide-react';
import type { ChatRoom } from './messages';
import { docToOffer, offerBanner, pendingOfferOf, signDocUrl } from './pendingDoc';
import { takeRoomDoc } from './segmentNav';
import { docHashFor } from './signLink';
import { openDappBrowser } from '../dappBrowser';

/**
 * "A document is waiting for your signature" at the top of a room: the room's pinned pending_doc, or the one a tapped
 * notification named (owner, 28 Oct 2026: a signable minute posted to $BCORPBOARD rang the phone, and the tap had
 * nowhere to land). Review & sign opens the room's bChatX page on that document (chat/pendingDoc.ts).
 */
const PendingDocBanner = ({ room, me, roomName }: { room: ChatRoom; me: string; roomName?: string }) => {
  // Taken once, when this room opens: a tap for this room (and this document) highlights the banner.
  const [fromPush] = useState(() => takeRoomDoc(room.ticker));
  const doc = docToOffer(room, fromPush);
  const href = doc ? signDocUrl(room.ticker, doc, docHashFor(room.ticker, doc)) : null;
  if (!href) return null;
  // Offer-first contracts: the same words as the bChatX card (sender and recipient see different text).
  const offer = pendingOfferOf(room);
  const view = offer ? offerBanner(offer, me) : null;
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
        {roomName && (
          <div className="text-[11px] truncate" style={{ color: '#8a8f98' }}>
            {roomName}
          </div>
        )}
        <div className="text-[13px] font-semibold text-white">
          {view ? view.title : 'Document waiting for signature'}
        </div>
        <div className="text-[11px]" style={{ color: '#8a8f98' }}>
          {view ? view.line : 'Read it, sign your block and seal on bChatX.'}
        </div>
        {view?.youAre && (
          <div className="text-[11px]" style={{ color: '#8a8f98' }}>
            {view.youAre}.
          </div>
        )}
      </div>
      {/* The wallet's own browser on the phone (connected, so signed in; owner 28 Oct 2026: Safari opened signed
          out). A tab on the web wallet and extension (openDappBrowser). */}
      <button
        type="button"
        onClick={() => openDappBrowser(href).catch((e) => console.error('[review & sign]', e))}
        className="shrink-0 rounded-xl px-3 py-2 text-[13px] font-bold border-0"
        style={{ background: 'var(--bw-accent-hi)', color: '#1a1300' }}
      >
        {view ? (view.button ?? 'Open') : 'Review & sign'}
      </button>
    </div>
  );
};

export default PendingDocBanner;
