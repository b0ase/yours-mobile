import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { BUREAU_ENABLED } from '../storeBuild';
import { TopNav } from '../../components/TopNav';
import { BMailScreen } from './BMailScreen';
import { VideoBackground } from '../ui/VideoBackground';
import walletBg from '../brand/bg/wallet-card.mp4';
import walletPoster from '../brand/bg/wallet-card.jpg';

/**
 * bMail in the wallet's content area (/m/bmail): top bar and tab bar stay visible (owner, 9 Oct 2026). Leaving goes
 * back to wherever it was opened from; a bottom-tab tap navigates away directly. Compose is still a full-screen sheet.
 */
const BMailPage = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const want = params.get('tab');
  // ?tab=agreements: the Agreements box has its own wide page.
  if (BUREAU_ENABLED && want === 'agreements') return <Navigate to="/m/bmail/agreements" replace />;
  const tab = want === 'requests' || want === 'quarantine' || want === 'bin' ? want : 'inbox';
  return (
    // Top padding = the fixed TopNav (h-14); bottom = the tab bar / dock (--dock-h), as AgentPage.
    <div
      className="relative isolate w-full h-full flex flex-col"
      style={{ background: '#0d0e11', paddingTop: '3.5rem', paddingBottom: 'var(--dock-h, 3.75rem)' }}
    >
      {/* The Wallet tab's own clip and scrim (same files, so no extra download once the wallet has loaded). */}
      <VideoBackground src={walletBg} poster={walletPoster} scrim="dark" />
      <TopNav />
      <BMailScreen key={tab} initialTab={tab} onClose={() => navigate(-1)} />
    </div>
  );
};

export default BMailPage;
