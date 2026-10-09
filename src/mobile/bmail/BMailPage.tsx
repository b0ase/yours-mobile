import { useNavigate, useSearchParams } from 'react-router-dom';
import { TopNav } from '../../components/TopNav';
import { BMailScreen } from './BMailScreen';
import { WIDE_ON } from '../wide/flag';

/**
 * bMail in the wallet's content area (/m/bmail): top bar and tab bar stay visible (owner, 9 Oct 2026). Leaving goes
 * back to wherever it was opened from; a bottom-tab tap navigates away directly. Compose is still a full-screen sheet.
 */
const BMailPage = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tab = params.get('tab') === 'requests' ? 'requests' : 'inbox';
  return (
    // Top padding = the fixed TopNav (h-14); bottom = the tab bar / dock (--dock-h), as AgentPage.
    <div
      className="w-full h-full flex flex-col"
      style={{ background: '#0d0e11', paddingTop: '3.5rem', paddingBottom: 'var(--dock-h, 3.75rem)' }}
    >
      <TopNav />
      <BMailScreen key={tab} initialTab={tab} wide={WIDE_ON} onClose={() => navigate(-1)} />
    </div>
  );
};

export default BMailPage;
