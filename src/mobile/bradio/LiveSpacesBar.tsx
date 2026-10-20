import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio } from 'lucide-react';
import { loadSession, SESSION_EVENT } from '../chat/api';
import { fetchLiveSpaces, type LiveReason, type LiveSpace } from './podcasts';

const POLL_MS = 60_000;
const REASON_LABEL: Record<LiveReason, string> = { following: 'Following', joined: 'Joined', popular: 'Popular' };
const f = (u: string, i?: RequestInit) => fetch(u, i);

/**
 * Home: Spaces live now from people you follow and your handle's rooms (GET /api/bitsign/spaces/live).
 * Tap → the Space (Spaces page, ?space=<slug>). Shows nothing when signed out, none are live, or the
 * endpoint isn't there. Mounted only where Spaces are on (BSPACES_ENABLED).
 */
export const LiveSpacesBar = () => {
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState<LiveSpace[]>([]);
  const [session, setSession] = useState(loadSession);

  useEffect(() => {
    const on = () => setSession(loadSession());
    window.addEventListener(SESSION_EVENT, on);
    return () => window.removeEventListener(SESSION_EVENT, on);
  }, []);

  useEffect(() => {
    if (!session?.handle) return setSpaces([]);
    let live = true;
    const load = () => void fetchLiveSpaces(f, session.handle, session.token).then((s) => live && setSpaces(s));
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [session]);

  if (!spaces.length) return null;
  return (
    <div className="flex flex-col gap-2" aria-label="Live Spaces">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider m-0" style={{ color: '#F76B15' }}>
        Live now
      </h2>
      <div className="flex flex-wrap gap-2">
        {spaces.map((s) => (
          <button
            key={s.slug}
            type="button"
            onClick={() => navigate(`/m/spaces?space=${encodeURIComponent(s.slug)}`)}
            className="shrink-0 flex items-center gap-2 rounded-full px-3 py-2 border cursor-pointer max-w-[260px]"
            style={{ background: '#2a1708', borderColor: '#F76B15' }}
          >
            {s.hostAvatar ? (
              <img src={s.hostAvatar} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" />
            ) : (
              <Radio size={14} color="#F76B15" className="shrink-0" />
            )}
            <span className="flex flex-col items-start min-w-0">
              <span className="text-xs font-bold text-white truncate max-w-full">{s.title}</span>
              <span className="text-[10px] text-[#98A2B3] truncate max-w-full">
                {[
                  s.host && `@${s.host}`,
                  s.listeners > 0 && `${s.listeners} listening`,
                  s.reason && REASON_LABEL[s.reason],
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
