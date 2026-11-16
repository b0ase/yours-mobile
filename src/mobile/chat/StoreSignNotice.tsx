import { FileSignature } from 'lucide-react';
import type { ChatRoom } from './messages';
import { storeSignLink } from './pendingDoc';

/**
 * A store build has no "Review & sign" in a room (BUREAU_ENABLED is off), so a room with a document waiting for
 * signature would otherwise show nothing to tap (owner and CEO, 16 Nov 2026: an investor could not find where to
 * sign). Until signing in rooms is in the store build, say where to sign: the room's bChatX page in the browser.
 * The URL is rebuilt from the ticker and document id (pendingDoc.ts); nothing a server sent is opened as a URL.
 */

const StoreSignNotice = ({ room }: { room: ChatRoom }) => {
  const href = storeSignLink(room);
  if (!href) return null;
  return (
    <div
      className="mx-3 mt-2 rounded-2xl px-3 py-2.5 flex items-center gap-3"
      style={{ background: '#141414', border: '1px solid #1f2127' }}
    >
      <FileSignature size={18} className="shrink-0" style={{ color: 'var(--bw-accent-hi)' }} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-white">Document waiting for signature</div>
        <div className="text-[12px]" style={{ color: '#9a9a9a' }}>
          Open bchatx.com in your browser to sign.
        </div>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold"
        style={{ background: 'var(--bw-accent)', color: 'var(--bw-on-accent)' }}
      >
        Open bchatx.com
      </a>
    </div>
  );
};

export default StoreSignNotice;
