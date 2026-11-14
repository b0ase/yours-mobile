import { useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useBackClose } from '../backStack';
import bGlyph from '../brand/bwallet-glyph.svg';
import { TopNav } from '../../components/TopNav';
import { AgentConversation } from './AgentConversation';
import { useKeyboardInset } from '../ui/keyboardInset';
import { AppsBar, useSwipeUpToApps } from '../look/AppsButton';
import { usePhoneLayout } from '../phone/flag';
import { appScreenRoute } from '../phone/screens';

/**
 * /m/ask-b — the b agent, opened by the top bar's centre b ("Ask b" in the phone layout) or the b agent tile in Apps.
 * Helps people use bWallet (guide.ts). Not free: either the user's own provider key (direct from the device) or
 * pay per message in BSV (paid.ts). See agent.ts. The conversation itself is AgentConversation.tsx.
 */
const LINE = '#2b2f36';

const AgentPage = () => {
  const navigate = useNavigate();
  // The first screen after launch (screens.ts startRoute) has nothing to go back to: Back leaves the app as on any home.
  const opening = !!(useLocation().state as { opening?: boolean } | null)?.opening;
  const close = () => navigate(-1);
  useBackClose(!opening, close);
  // iOS doesn't resize the page for the keyboard: lift the composer above it (ui/keyboardInset.ts).
  const keyboard = useKeyboardInset();
  // Phone layout: the b opens this page; the apps are the gold bar under the header, or one swipe up.
  const phone = usePhoneLayout();
  const appsReach = phone && !keyboard;
  const toApps = useCallback(() => navigate(appScreenRoute(0)), [navigate]);
  const page = useRef<HTMLDivElement>(null);
  useSwipeUpToApps(appsReach, toApps, page);
  return (
    // Top padding = the fixed TopNav (h-14); bottom = the tab bar / dock (--dock-h) so the composer sits above it.
    <div
      ref={page}
      className="w-full h-full flex flex-col"
      style={{
        background: 'var(--bw-bg)',
        paddingTop: '3.5rem',
        paddingBottom: keyboard ? `${keyboard}px` : 'var(--dock-h, 3.75rem)',
      }}
    >
      <TopNav />
      {/* Phone (owner, 9 Nov 2026): no title row; this page is the home of the app, with nowhere to go back to. */}
      {!phone && (
        <div
          className={`flex items-center gap-2 py-1 shrink-0 ${opening ? 'px-4' : 'px-2'}`}
          style={{ borderBottom: `1px solid ${LINE}`, minHeight: opening ? '2.75rem' : undefined }}
        >
          {!opening && (
            <button aria-label="Back" onClick={close} className="p-2">
              <ArrowLeft size={20} color="#fff" />
            </button>
          )}
          <img src={bGlyph} alt="" width={22} height={22} />
          <h1 className="text-lg font-bold text-white shrink-0">Ask b</h1>
        </div>
      )}
      {appsReach && <AppsBar onGo={toApps} />}
      <AgentConversation />
    </div>
  );
};

export default AgentPage;
