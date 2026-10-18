import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUp, Bell, ChevronRight, History, Music, Pause, PiggyBank, Play, SkipForward } from 'lucide-react';
import bGlyph from '../brand/bwallet-glyph.svg';
import { setAgentDraft } from '../agent/handoff';
import { AGENT_ROUTE } from '../tabs/agentEntry';
import { getItems, subscribeItems } from '../notify/store';
import { getState, next, playQueue, subscribe, toggle } from '../media/player';
import { FEATURED_TRACKS, featuredQueue } from '../media/featured/featured';
import { listPots, listSubs, onPotsChange } from '../pots/pots';

const HistoryScreen = lazy(() => import('../wallet/HistoryScreen'));
const PotsScreen = lazy(() => import('../pots/PotsScreen'));
const BsvPriceChart = lazy(() => import('../wallet/PriceChart').then((m) => ({ default: m.BsvPriceChart })));

/** One module's frame: themed surface (light on light themes, never a dark card on white), title row. */
export const Panel = ({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section className="bw-home-panel">
    <header className="bw-home-head">
      {icon}
      <span className="bw-home-title">{title}</span>
      {action}
    </header>
    {children}
  </section>
);

// ── Ask b ─────────────────────────────────────────────────────────────────────────────────────────────────────

const SUGGESTIONS = ['How do I send BSV to a $name?', 'Make my wallet look different', 'What can I do with my tokens?'];

/** One line and a few chips; each opens Ask b with the text already typed (agent/handoff.ts). Nothing is sent here. */
export const AskBModule = () => {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const open = (t: string) => {
    if (t.trim()) setAgentDraft(t.trim());
    navigate(AGENT_ROUTE);
  };
  return (
    <section className="bw-home-panel bw-home-ask">
      <form
        className="bw-home-askrow"
        onSubmit={(e) => {
          e.preventDefault();
          open(text);
        }}
      >
        <img src={bGlyph} alt="" width={22} height={22} />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask b anything…"
          aria-label="Ask b"
          enterKeyHint="go"
        />
        <button type="submit" aria-label="Open Ask b" className="bw-home-askgo">
          <ArrowUp size={16} strokeWidth={2.5} />
        </button>
      </form>
      <div className="bw-home-chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="bw-home-chip" onClick={() => open(s)}>
            {s}
          </button>
        ))}
      </div>
    </section>
  );
};

// ── History ───────────────────────────────────────────────────────────────────────────────────────────────────

/** History as a module (it left the top row): opens the same Activity / History screen. */
export const HistoryModule = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="bw-home-panel bw-home-tile" onClick={() => setOpen(true)}>
        <History size={20} className="bw-home-ico" aria-hidden="true" />
        <span className="bw-home-tiletext">
          <span className="bw-home-title">History</span>
          <span className="bw-home-sub">Every payment in and out</span>
        </span>
        <ChevronRight size={16} className="bw-home-muted" aria-hidden="true" />
      </button>
      {open && (
        <Suspense fallback={null}>
          <HistoryScreen onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
};

// ── BSV price chart ───────────────────────────────────────────────────────────────────────────────────────────

export const PriceChartModule = () => (
  <Panel title="BSV price">
    <Suspense fallback={<div style={{ height: 140 }} />}>
      <BsvPriceChart />
    </Suspense>
  </Panel>
);

// ── Pots ──────────────────────────────────────────────────────────────────────────────────────────────────────

const usePots = () => {
  const [, bump] = useState(0);
  useEffect(() => onPotsChange(() => bump((n) => n + 1)), []);
  const pots = listPots();
  const subs = listSubs().filter((s) => s.status !== 'cancelled' && s.status !== 'ended');
  return { pots, subs };
};

export const PotsModule = () => {
  const { pots, subs } = usePots();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="bw-home-panel bw-home-tile" onClick={() => setOpen(true)}>
        <PiggyBank size={20} className="bw-home-ico" aria-hidden="true" />
        <span className="bw-home-tiletext">
          <span className="bw-home-title">Pots</span>
          <span className="bw-home-sub">
            {pots.length
              ? `${pots.length} ${pots.length === 1 ? 'pot' : 'pots'} · ${subs.length} regular ${subs.length === 1 ? 'payment' : 'payments'}`
              : 'Put money aside for regular payments'}
          </span>
        </span>
        <ChevronRight size={16} className="bw-home-muted" aria-hidden="true" />
      </button>
      {open && (
        <Suspense fallback={null}>
          <PotsScreen onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
};

// ── Notifications ─────────────────────────────────────────────────────────────────────────────────────────────

const ago = (at: number) => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
};

/** The latest from chat, payments and the feed (notify/store.ts, the same list as the bell). */
export const NotificationsModule = () => {
  const navigate = useNavigate();
  const items = useSyncExternalStore(subscribeItems, getItems, getItems);
  const latest = items.slice(0, 3);
  const unread = items.filter((i) => !i.read).length;
  return (
    <Panel
      title="Notifications"
      icon={<Bell size={16} className="bw-home-ico" aria-hidden="true" />}
      action={
        <button type="button" className="bw-home-link" onClick={() => navigate('/m/notifications')}>
          {unread ? `${unread} new` : 'All'}
        </button>
      }
    >
      {latest.length ? (
        <ul className="bw-home-list">
          {latest.map((i) => (
            <li key={i.id}>
              <button type="button" onClick={() => navigate('/m/notifications')}>
                <span className={i.read ? 'bw-home-dot' : 'bw-home-dot on'} aria-hidden="true" />
                <span className="bw-home-tiletext">
                  <span className="bw-home-line">{i.title}</span>
                  <span className="bw-home-sub bw-home-line">{i.body}</span>
                </span>
                <span className="bw-home-sub">{ago(i.at)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="bw-home-sub m-0">Nothing new. Messages, payments and replies show here.</p>
      )}
    </Panel>
  );
};

// ── Music ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** What's playing (media/player.ts), or the free featured track to start with. */
export const MusicModule = () => {
  const navigate = useNavigate();
  const [s, setS] = useState(getState);
  useEffect(() => subscribe(setS), []);
  const track = s.queue[s.index];
  const free = FEATURED_TRACKS[0];
  const art = track?.artwork ?? free?.artwork;
  return (
    <Panel
      title="Music"
      icon={<Music size={16} className="bw-home-ico" aria-hidden="true" />}
      action={
        <button type="button" className="bw-home-link" onClick={() => navigate('/m/media')}>
          Media
        </button>
      }
    >
      <div className="bw-home-music">
        {art && <img src={art} alt="" width={52} height={52} />}
        <span className="bw-home-tiletext">
          <span className="bw-home-line">{track ? track.title : free ? free.title : 'Nothing playing'}</span>
          <span className="bw-home-sub bw-home-line">
            {track ? (s.playing ? 'Playing' : 'Paused') : free ? `${free.artist} · free to play` : ''}
          </span>
        </span>
        {track ? (
          <>
            <button type="button" className="bw-home-round" aria-label={s.playing ? 'Pause' : 'Play'} onClick={toggle}>
              {s.playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            {s.index < s.queue.length - 1 && (
              <button type="button" className="bw-home-round ghost" aria-label="Next" onClick={() => void next()}>
                <SkipForward size={16} />
              </button>
            )}
          </>
        ) : (
          free && (
            <button
              type="button"
              className="bw-home-round"
              aria-label="Play"
              onClick={() => playQueue(featuredQueue(free), 0)}
            >
              <Play size={16} />
            </button>
          )
        )}
      </div>
    </Panel>
  );
};
