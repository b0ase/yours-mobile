import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useBackClose } from '../backStack';
import bGlyph from '../brand/bwallet-glyph.svg';
import { TopNav } from '../../components/TopNav';
import { AgentConversation } from './AgentConversation';
import { useKeyboardInset } from '../ui/keyboardInset';

/**
 * /m/agent — the b agent, opened by the top bar's centre b ("Ask b" in the phone layout) or the b agent tile in Apps.
 * Helps people use bWallet (guide.ts). Not free: either the user's own provider key (direct from the device) or
 * pay per message in BSV (paid.ts). See agent.ts. The conversation itself is AgentConversation.tsx.
 */
const LINE = '#2b2f36';

const AgentPage = () => {
  const navigate = useNavigate();
  const close = () => navigate(-1);
  useBackClose(true, close);
  // iOS doesn't resize the page for the keyboard: lift the composer above it (ui/keyboardInset.ts).
  const keyboard = useKeyboardInset();
  return (
    // Top padding = the fixed TopNav (h-14); bottom = the tab bar / dock (--dock-h) so the composer sits above it.
    <div
      className="w-full h-full flex flex-col"
      style={{
        background: '#010101',
        paddingTop: '3.5rem',
        paddingBottom: keyboard ? `${keyboard}px` : 'var(--dock-h, 3.75rem)',
      }}
    >
      <TopNav />
      <div className="flex items-center gap-2 px-2 py-1 shrink-0" style={{ borderBottom: `1px solid ${LINE}` }}>
        <button aria-label="Back" onClick={close} className="p-2">
          <ArrowLeft size={20} color="#fff" />
        </button>
        <img src={bGlyph} alt="" width={22} height={22} />
        <h1 className="text-lg font-bold text-white shrink-0">b agent</h1>
      </div>
      <AgentConversation />
    </div>
  );
};

export default AgentPage;
