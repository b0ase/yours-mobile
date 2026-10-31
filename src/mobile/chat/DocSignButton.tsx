import { FileSignature } from 'lucide-react';
import { signDocUrl } from './pendingDoc';
import { docHashFor } from './signLink';
import { docButtonLabel, type SignableDoc } from './signableDocs';
import { openDappBrowser } from '../dappBrowser';

/**
 * One document's own button under its card in the chat (chat/signableDocs.ts): opens bChatX's page on THAT document,
 * the same page the room's banner opens. Signed or sealed documents open the same page to read.
 */
const DocSignButton = ({ ticker, doc }: { ticker: string; doc: SignableDoc }) => {
  const href = signDocUrl(ticker, doc.id, docHashFor(ticker, doc.id));
  if (!href) return null;
  const sign = doc.state === 'sign';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openDappBrowser(href).catch((err) => console.error('[review & sign]', err));
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="mt-1 mb-1 inline-flex items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-bold border-0"
      style={
        sign
          ? { background: 'var(--bw-accent-hi)', color: '#1a1300' }
          : { background: 'rgba(0,0,0,0.3)', color: 'var(--bw-accent-hi)' }
      }
      aria-label={`${docButtonLabel(doc.state)}: ${doc.fileName || 'document'}`}
    >
      <FileSignature size={15} />
      {docButtonLabel(doc.state)}
    </button>
  );
};

export default DocSignButton;
