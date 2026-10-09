import { TopNav } from '../../components/TopNav';
import { TermsGate } from '../ugc/UgcSheets';
import { CallsList } from './CallsList';
import { VideoBackground } from '../ui/VideoBackground';
import walletBg from '../brand/bg/wallet-card.mp4';
import walletPoster from '../brand/bg/wallet-card.jpg';

/**
 * bPhone Calls in the wallet's content area (/m/calls): top bar and tab bar stay visible (owner, 9 Oct 2026, as bMail).
 * The top bar's phone button (gold ring while here) or a bottom tab leaves. An active call (ringing, in-call, video)
 * is CallScreen, mounted app-wide above everything, so it still goes full-screen and interrupts from anywhere.
 */
const CallsPage = () => (
  <div
    className="relative isolate w-full h-full flex flex-col overflow-y-auto"
    style={{ background: '#0d0e11', paddingTop: '3.5rem', paddingBottom: 'var(--dock-h, 3.75rem)' }}
  >
    <VideoBackground src={walletBg} poster={walletPoster} scrim="dark" />
    <TopNav />
    <div className="px-4 pt-3 pb-2 text-lg font-semibold text-white">Calls</div>
    <TermsGate compact>
      {/* No onLeave: Message / Pay switch tab through the router, which leaves this route by itself. */}
      <CallsList bottomInset="var(--dock-h, 3.75rem)" />
    </TermsGate>
  </div>
);

export default CallsPage;
