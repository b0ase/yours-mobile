import { FileSignature } from 'lucide-react';
import { signDocUrl } from './pendingDoc';
import { bchatxFrameRoute, docHashFor } from './signLink';
import { docButtonLabel, type SignableDoc } from './signableDocs';
import { openDappBrowser } from '../dappBrowser';
import { nativeSealRoute } from './nativeSeal';
import { FINISHING_SEAL_LINE, heldSealFor } from './sealStore';
import { useNavigate } from 'react-router-dom';

/**
 * One document's own button under its card in the chat (chat/signableDocs.ts): opens bChatX's page on THAT document,
 * the same page the room's banner opens. Signed or sealed documents open the same page to read.
 */
const DocSignButton = ({ ticker, doc }: { ticker: string; doc: SignableDoc }) => {
  const navigate = useNavigate();
  const href = signDocUrl(ticker, doc.id, docHashFor(ticker, doc.id));
  if (!href) return null;
  const sign = doc.state === 'sign';
  // A seal of it held on this phone (it may have been paid): "Finishing your seal…", never a fresh Sign button. The
  // native page shows what is happening and finishes it (owner, 23 Nov 2026: never sign the same document twice).
  const finishing = sign && !!nativeSealRoute(ticker, doc.id) && heldSealFor(doc.id);
  const label = finishing ? FINISHING_SEAL_LINE : docButtonLabel(doc.state);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        // ⚠ An unsigned document is signed and sealed NATIVELY (chat/NativeSealPage.tsx, 3 Nov 2026): the web page in the
        // dApp browser / frame never finished the seal on the phone. Signed or sealed ones open the page to read.
        const native = sign ? nativeSealRoute(ticker, doc.id) : null;
        if (native) return navigate(native);
        // In the bApp frame, where the seal's approval reaches the wallet (signLink.bchatxFrameRoute).
        const route = bchatxFrameRoute(href);
        if (route) return navigate(route);
        openDappBrowser(href).catch((err) => console.error('[review & sign]', err));
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="mt-1 mb-1 inline-flex items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-bold border-0"
      style={
        sign && !finishing
          ? { background: 'var(--bw-accent-hi)', color: '#1a1300' }
          : { background: 'rgba(0,0,0,0.3)', color: 'var(--bw-accent-hi)' }
      }
      aria-label={`${label}: ${doc.fileName || 'document'}`}
      data-testid={finishing ? 'doc-seal-finishing' : undefined}
    >
      <FileSignature size={15} />
      {label}
    </button>
  );
};

export default DocSignButton;
