/**
 * Talk › Calendar (/m/calendar): the one calendar of scheduled Spaces — the same events as bChatX and
 * bcalx.com (CalendarView.tsx). "Open the Space" opens it in bSpaces. bWalletX only (BSPACES_ENABLED).
 */
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { CalendarView } from './CalendarView';
import { BCALX_ORIGIN } from './calendar';

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#8a8f98';
const LINE = '#1f2127';

const CalendarPage = () => {
  const navigate = useNavigate();
  return (
    <div className="min-h-full flex flex-col" style={{ background: 'var(--bw-bg)', color: '#fff' }}>
      <header className="flex items-center gap-2 px-2 py-2" style={{ borderBottom: `1px solid ${LINE}` }}>
        <button onClick={() => navigate(-1)} className="p-2" aria-label="Back">
          <ArrowLeft size={22} color={GOLD} />
        </button>
        <div className="flex-1">
          <div className="text-[17px] font-bold">Calendar</div>
          <div className="text-[11px]" style={{ color: MUTED }}>
            Scheduled Spaces · the same calendar on bChatX and bcalx.com
          </div>
        </div>
        <a
          href={BCALX_ORIGIN}
          target="_blank"
          rel="noreferrer"
          className="px-2 text-[12px] font-semibold"
          style={{ color: GOLD }}
        >
          bcalx.com ↗
        </a>
      </header>
      <div className="flex-1 overflow-y-auto bw-dock-pad">
        <CalendarView
          title="Upcoming"
          onJoin={(ticker, name) =>
            navigate(`/m/spaces?open=${encodeURIComponent(ticker)}&name=${encodeURIComponent(name)}`)
          }
        />
      </div>
    </div>
  );
};

export default CalendarPage;
