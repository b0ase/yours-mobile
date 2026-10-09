import { useEffect, useMemo, useState } from 'react';
import bgVideo from '../brand/bg/wallet-card.mp4';
import bgPoster from '../brand/bg/wallet-card.jpg';
import mark from '../brand/bwalletx-glyph.svg';
import './wide.css';

/**
 * PROTOTYPE (demo/desktop-shell only): what bWalletX looks like as a wide-screen web app on wide
 * screens. Mounted by main.ts only with ?wide=1 (or VITE_WIDE_WEB=1) at >= 1100px wide.
 * Views use sample data; "Open live wallet" shows the real wallet column in a side panel.
 */

type View = 'wallet' | 'exchange' | 'mail' | 'calls' | 'feed' | 'chat' | 'spaces' | 'apps' | 'settings';
type Ccy = 'USD' | 'GBP';

const BSV_USD = 52.4;
const FX: Record<Ccy, { r: number; s: string }> = { USD: { r: 1, s: '$' }, GBP: { r: 0.79, s: '£' } };

const TOKENS = [
  { sym: 'BSV', name: 'Bitcoin SV', amt: 18.42051, usd: BSV_USD, ch: 2.1, c: '#eab308' },
  { sym: '$402', name: 'PATH402', amt: 12500, usd: 0.0184, ch: 6.4, c: '#a78bfa' },
  { sym: '$BOASE', name: 'b0ase Studio', amt: 4200000, usd: 0.00042, ch: -1.2, c: '#f5f5f4' },
  { sym: '$bMail', name: 'Bitcoin Email', amt: 880000, usd: 0.00011, ch: 12.8, c: '#38bdf8' },
  { sym: '$NPG', name: 'Ninja Punk Girls', amt: 1520, usd: 0.31, ch: 0.4, c: '#f472b6' },
  { sym: '$KINTSUGI', name: 'Kintsugi', amt: 250000, usd: 0.0009, ch: 3.3, c: '#fbbf24' },
  { sym: '$DIVVY', name: 'Divvy', amt: 61000, usd: 0.0021, ch: -4.6, c: '#34d399' },
];

const ACTIVITY = [
  { t: 'Received', who: '$alice', amt: '+0.25 BSV', when: '2m', in: true },
  { t: 'Paid like', who: 'bChat · #builders', amt: '−1¢', when: '14m', in: false },
  { t: 'bMail stamp', who: '$satchmo', amt: '+2¢', when: '1h', in: true },
  { t: 'Sent', who: '$kwegwong', amt: '−0.10 BSV', when: '3h', in: false },
  { t: 'Bought', who: '$402 · 2,500', amt: '−$46.00', when: 'Yesterday', in: false },
  { t: 'Subscription', who: 'bMovies', amt: '−1¢/day', when: 'Yesterday', in: false },
  { t: 'Received', who: '$npg', amt: '+120 $NPG', when: 'Mon', in: true },
];

const MAILS = [
  { id: 1, from: '$satchmo', sub: 'Overlay indexer is live', prev: 'Pushed the new BSV-21 lookup service, can you point bWalletX at it…', amt: '2¢', when: '09:41', unread: true },
  { id: 2, from: 'path402.com', sub: 'Your $402 mining receipt', prev: 'Proof of Indexing reward for block 921,044: 12 $402…', amt: '', when: '08:12', unread: true },
  { id: 3, from: '$alice', sub: 'Invoice for the logo work', prev: 'Hi Richard, attached is the final logo pack and invoice…', amt: '0.25 BSV', when: 'Yesterday', unread: true },
  { id: 4, from: '$kwegwong', sub: 'Show on Friday 🎟', prev: 'Tickets are minted, sending you two as ordinals…', amt: '1¢', when: 'Tue', unread: false },
  { id: 5, from: '$npg', sub: 'Dividend notice Q3', prev: 'NPG Ltd declares a dividend payable to $NPG holders…', amt: '', when: 'Mon', unread: false },
  { id: 6, from: '$divvy', sub: 'Distribution complete', prev: '1,204 holders paid in one transaction. Fees: 0.0004 BSV…', amt: '', when: 'Sun', unread: false },
];

const ROOMS = [
  { id: 'builders', name: '# builders', last: 'b: merged the scan fix', n: 4, live: false },
  { id: 'bwalletx', name: '# bwalletx', last: '$alice: 5.1.90 looks good', n: 0, live: true },
  { id: 'npg', name: '# ninja-punk-girls', last: '$npg: drop at 8pm', n: 12, live: false },
  { id: 'kwegwong', name: '# kwegwong', last: 'voice room open', n: 0, live: true },
  { id: 'satchmo', name: '$satchmo', last: 'sounds good', n: 1, live: false },
];

const MSGS = [
  { who: '$alice', t: 'The wide layout is so much nicer for bMail.', at: '10:02' },
  { who: '$satchmo', t: 'Can the token table sort by value? That is what I always want.', at: '10:03' },
  { who: 'b', t: 'Done: click any column header in Wallet › Tokens. Tip me 5¢ if it helps.', at: '10:04', bot: true },
  { who: '$b0asex', t: 'Tipped. Ship it to test 🚀', at: '10:05', me: true, tip: '5¢' },
  { who: '$kwegwong', t: 'Space at 8pm tonight, I will pin it here.', at: '10:07' },
];

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const I = {
  wallet: 'M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7zm0 0 2-3h12M16 13.5h2',
  exchange: 'M7 7h13l-4-4M17 17H4l4 4',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  calls: 'M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 6a2 2 0 0 1 2-2',
  feed: 'M4 5h16M4 12h16M4 19h10',
  chat: 'M21 12a8 8 0 0 1-12 7l-5 1 1-4a8 8 0 1 1 16-4z',
  spaces: 'M12 3a4 4 0 0 1 4 4v4a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4zM5 11a7 7 0 0 0 14 0M12 18v3',
  apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-2-4-2 1-2-1V4h-4v3l-2 1-2-1-2 4 2 1v0l-2 1 2 4 2-1 2 1v3h4v-3l2-1 2 1 2-4z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  send: 'M4 12 20 4l-6 16-3-7z',
  down: 'M12 4v14M6 12l6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  reply: 'M10 8 4 13l6 5M4 13h11a5 5 0 0 1 5 5',
  archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
  live: 'M12 12m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10',
  panel: 'M3 4h18v16H3zM15 4v16',
};

const NAV: { id: View; label: string; icon: string; badge?: string; live?: boolean; key: string }[] = [
  { id: 'wallet', label: 'Wallet', icon: I.wallet, key: 'w' },
  { id: 'exchange', label: 'Exchange', icon: I.exchange, key: 'x' },
  { id: 'mail', label: 'bMail', icon: I.mail, badge: '3', key: 'm' },
  { id: 'calls', label: 'Calls', icon: I.calls, key: 'l' },
  { id: 'feed', label: 'Feed', icon: I.feed, key: 'f' },
  { id: 'chat', label: 'Chat', icon: I.chat, badge: '17', key: 'c' },
  { id: 'spaces', label: 'Spaces', icon: I.spaces, live: true, key: 's' },
  { id: 'apps', label: 'bApps', icon: I.apps, key: 'a' },
];

const useFmt = (ccy: Ccy) =>
  useMemo(() => {
    const { r, s } = FX[ccy];
    return (usd: number) => {
      const v = usd * r;
      return s + v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
  }, [ccy]);

/* ---------------- Wallet ---------------- */

const Chart = () => {
  const pts = [40, 42, 41, 45, 44, 48, 47, 52, 50, 55, 58, 56, 61, 60, 64, 63, 67, 71, 69, 74, 72, 78, 81, 79, 84];
  const w = 600;
  const h = 120;
  const max = Math.max(...pts);
  const min = Math.min(...pts);
  const xy = pts.map((p, i) => [(i / (pts.length - 1)) * w, h - ((p - min) / (max - min)) * (h - 10) - 5]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg className="ww-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="wwfill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffd24d" stopOpacity="0.28" />
          <stop offset="1" stopColor="#ffd24d" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill="url(#wwfill)" />
      <path d={line} fill="none" stroke="#ffd24d" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

type SortKey = 'name' | 'amt' | 'value';

const WalletView = ({ fmt }: { fmt: (n: number) => string }) => {
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: 'value', desc: true });
  const total = TOKENS.reduce((s, t) => s + t.amt * t.usd, 0);
  const rows = [...TOKENS].sort((a, b) => {
    const v =
      sort.k === 'name' ? a.sym.localeCompare(b.sym) : sort.k === 'amt' ? a.amt - b.amt : a.amt * a.usd - b.amt * b.usd;
    return sort.desc ? -v : v;
  });
  const th = (k: SortKey, label: string, right = false) => (
    <th className={right ? 'r' : ''} onClick={() => setSort((s) => ({ k, desc: s.k === k ? !s.desc : true }))}>
      {label}
      {sort.k === k && <span className="ww-sort">{sort.desc ? '↓' : '↑'}</span>}
    </th>
  );
  return (
    <div className="ww-wallet">
      <div className="ww-wallet-main">
        <div className="ww-hero">
          <div className="ww-card">
            <div className="ww-card-top">
              <img src={mark} alt="" width={26} height={26} />
              <span className="ww-muted">Main account</span>
            </div>
            <div>
              <div className="ww-card-bal">{fmt(total)}</div>
              <div className="ww-muted">18.42051 BSV · $b0asex</div>
            </div>
            <div className="ww-card-addr">1BwX…q7Lr ⧉</div>
          </div>
          <div className="ww-panel ww-hero-chart">
            <div className="ww-row-between">
              <div>
                <div className="ww-muted ww-small">Portfolio</div>
                <div className="ww-big">{fmt(total)}</div>
                <div className="ww-up">▲ {fmt(total * 0.034)} (3.4%) this month</div>
              </div>
              <div className="ww-seg">
                {['1D', '1W', '1M', '1Y', 'All'].map((p) => (
                  <button key={p} className={p === '1M' ? 'on' : ''}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <Chart />
            <div className="ww-actions">
              <button className="ww-btn gold">
                <Icon d={I.send} /> Send
              </button>
              <button className="ww-btn">
                <Icon d={I.down} /> Receive
              </button>
              <button className="ww-btn">
                <Icon d={I.plus} /> Buy BSV
              </button>
              <button className="ww-btn">
                <Icon d={I.exchange} /> Swap
              </button>
            </div>
          </div>
        </div>
        <div className="ww-panel ww-flush">
          <div className="ww-panel-head">
            <span>Tokens</span>
            <span className="ww-muted ww-small">{TOKENS.length} assets · click a column to sort</span>
          </div>
          <table className="ww-table">
            <thead>
              <tr>
                {th('name', 'Name')}
                {th('amt', 'Amount', true)}
                <th className="r">Price</th>
                <th className="r">24h</th>
                {th('value', 'Value', true)}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.sym}>
                  <td>
                    <span className="ww-tok" style={{ background: t.c }}>
                      {t.sym.replace('$', '').slice(0, 2)}
                    </span>
                    <b>{t.sym}</b> <span className="ww-muted">{t.name}</span>
                  </td>
                  <td className="r mono">{t.amt.toLocaleString('en-GB', { maximumFractionDigits: 5 })}</td>
                  <td className="r mono ww-muted">{t.usd < 0.01 ? fmt(t.usd * 1000) + '/k' : fmt(t.usd)}</td>
                  <td className={'r mono ' + (t.ch >= 0 ? 'ww-up' : 'ww-down')}>
                    {t.ch >= 0 ? '+' : ''}
                    {t.ch}%
                  </td>
                  <td className="r mono">
                    <b>{fmt(t.amt * t.usd)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <aside className="ww-panel ww-side">
        <div className="ww-panel-head">
          <span>Recent activity</span>
          <a className="ww-link">View all</a>
        </div>
        {ACTIVITY.map((a, i) => (
          <div key={i} className="ww-act">
            <span className={'ww-act-dot ' + (a.in ? 'in' : 'out')}>{a.in ? '↓' : '↑'}</span>
            <div className="ww-grow">
              <div>{a.t}</div>
              <div className="ww-muted ww-small">{a.who}</div>
            </div>
            <div className="r">
              <div className={a.in ? 'ww-up mono' : 'mono'}>{a.amt}</div>
              <div className="ww-muted ww-small">{a.when}</div>
            </div>
          </div>
        ))}
        <div className="ww-panel-head" style={{ marginTop: 12 }}>
          <span>Pots</span>
        </div>
        {[
          ['Subscriptions', '1¢/day', 0.62],
          ['Tips jar', '$4.10', 0.35],
        ].map(([n, v, p]) => (
          <div key={n as string} className="ww-pot">
            <div className="ww-row-between">
              <span>{n}</span>
              <span className="mono ww-muted">{v}</span>
            </div>
            <div className="ww-bar">
              <i style={{ width: `${(p as number) * 100}%` }} />
            </div>
          </div>
        ))}
      </aside>
    </div>
  );
};

/* ---------------- bMail ---------------- */

const MailView = () => {
  const [sel, setSel] = useState(1);
  const m = MAILS.find((x) => x.id === sel) ?? MAILS[0];
  return (
    <div className="ww-three">
      <nav className="ww-panel ww-folders">
        <button className="ww-btn gold ww-compose">
          <Icon d={I.plus} /> Compose <kbd>C</kbd>
        </button>
        {[
          ['Inbox', '3'],
          ['Paid', '2'],
          ['Starred', ''],
          ['Sent', ''],
          ['Drafts', '1'],
          ['Spam (unpaid)', '41'],
          ['Archive', ''],
        ].map(([f, n], i) => (
          <a key={f} className={'ww-folder' + (i === 0 ? ' on' : '')}>
            <span>{f}</span>
            {n && <span className="ww-muted">{n}</span>}
          </a>
        ))}
        <div className="ww-note ww-small ww-muted">
          Senders attach a stamp. Unknown senders without one go to Spam, so your inbox stays human.
        </div>
      </nav>
      <section className="ww-panel ww-flush ww-list">
        <div className="ww-panel-head">
          <span>Inbox</span>
          <span className="ww-muted ww-small">$b0asex@bmail</span>
        </div>
        {MAILS.map((x) => (
          <button key={x.id} className={'ww-mail' + (x.id === sel ? ' on' : '') + (x.unread ? ' unread' : '')} onClick={() => setSel(x.id)}>
            <div className="ww-row-between">
              <b>{x.from}</b>
              <span className="ww-muted ww-small">{x.when}</span>
            </div>
            <div className="ww-row-between">
              <span className="ww-mail-sub">{x.sub}</span>
              {x.amt && <span className="ww-chip">{x.amt}</span>}
            </div>
            <div className="ww-muted ww-small ww-clip">{x.prev}</div>
          </button>
        ))}
      </section>
      <article className="ww-panel ww-reader">
        <div className="ww-row-between">
          <h2>{m.sub}</h2>
          <div className="ww-tools">
            <button className="ww-icon-btn" title="Reply">
              <Icon d={I.reply} />
            </button>
            <button className="ww-icon-btn" title="Archive">
              <Icon d={I.archive} />
            </button>
          </div>
        </div>
        <div className="ww-from">
          <span className="ww-av">{m.from.replace('$', '')[0].toUpperCase()}</span>
          <div>
            <b>{m.from}</b>
            <div className="ww-muted ww-small">to $b0asex · {m.when}</div>
          </div>
          {m.amt && <span className="ww-chip gold">Paid {m.amt} to reach you</span>}
        </div>
        <div className="ww-body">
          <p>Hi Richard,</p>
          <p>{m.prev.replace('…', '.')}</p>
          <p>
            The message is end-to-end encrypted to your identity key and the stamp landed in your wallet as soon as you
            opened it. Reply costs nothing to people already in your contacts.
          </p>
          <p>Cheers,<br />{m.from}</p>
        </div>
        <div className="ww-replybox">
          <input placeholder={`Reply to ${m.from}…`} />
          <button className="ww-btn gold">
            <Icon d={I.send} /> Send
          </button>
        </div>
      </article>
    </div>
  );
};

/* ---------------- Chat ---------------- */

const ChatView = () => {
  const [room, setRoom] = useState('builders');
  return (
    <div className="ww-three chat">
      <nav className="ww-panel ww-flush ww-rooms">
        <div className="ww-panel-head">
          <span>Rooms</span>
          <button className="ww-icon-btn">
            <Icon d={I.plus} />
          </button>
        </div>
        {ROOMS.map((r) => (
          <button key={r.id} className={'ww-room' + (r.id === room ? ' on' : '')} onClick={() => setRoom(r.id)}>
            <div className="ww-grow">
              <div>
                {r.name} {r.live && <span className="ww-live">LIVE</span>}
              </div>
              <div className="ww-muted ww-small ww-clip">{r.last}</div>
            </div>
            {r.n > 0 && <span className="ww-badge">{r.n}</span>}
          </button>
        ))}
      </nav>
      <section className="ww-panel ww-flush ww-convo">
        <div className="ww-panel-head">
          <span># {room}</span>
          <span className="ww-muted ww-small">214 members · on-chain via bChat</span>
        </div>
        <div className="ww-msgs">
          {MSGS.map((m, i) => (
            <div key={i} className={'ww-msg' + (m.me ? ' me' : '') + (m.bot ? ' bot' : '')}>
              <span className="ww-av">{m.who === 'b' ? 'b' : m.who.replace('$', '')[0].toUpperCase()}</span>
              <div>
                <div>
                  <b>{m.who}</b> <span className="ww-muted ww-small">{m.at}</span>
                  {m.tip && <span className="ww-chip gold">tipped {m.tip}</span>}
                </div>
                <div>{m.t}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="ww-replybox">
          <input placeholder={`Message # ${room} · 1¢ per post`} />
          <button className="ww-btn gold">
            <Icon d={I.send} />
          </button>
        </div>
      </section>
      <aside className="ww-panel ww-details">
        <div className="ww-space">
          <div className="ww-row-between">
            <span className="ww-live">LIVE SPACE</span>
            <span className="ww-muted ww-small">38 listening</span>
          </div>
          <h3>Friday build review</h3>
          <div className="ww-speakers">
            {['B', 'A', 'S', 'K'].map((s, i) => (
              <span key={s} className={'ww-av lg' + (i === 0 ? ' talking' : '')}>
                {s}
              </span>
            ))}
          </div>
          <button className="ww-btn gold wide">
            <Icon d={I.spaces} /> Join Space
          </button>
        </div>
        <div className="ww-panel-head">
          <span>About</span>
        </div>
        <p className="ww-muted ww-small">People building bApps on BSV. Posts cost 1¢, likes pay the author.</p>
        <div className="ww-panel-head">
          <span>Pinned</span>
        </div>
        <div className="ww-pin">bWalletX 5.1.90 test build notes</div>
        <div className="ww-pin">Pay b to build: how it works</div>
        <div className="ww-panel-head">
          <span>Room token</span>
        </div>
        <div className="ww-row-between">
          <span>$BUILD</span>
          <span className="mono ww-up">+4.2%</span>
        </div>
      </aside>
    </div>
  );
};

const Placeholder = ({ v }: { v: View }) => (
  <div className="ww-panel ww-empty">
    <h2>{NAV.find((n) => n.id === v)?.label ?? 'Settings'}</h2>
    <p className="ww-muted">
      In this prototype only Wallet, bMail and Chat have wide layouts. Open the live wallet (right panel) to use the
      real screen.
    </p>
  </div>
);

/* ---------------- Shell ---------------- */

export const WideShell = ({ liveUrl }: { liveUrl: string }) => {
  const [view, setView] = useState<View>(() => (new URLSearchParams(location.search).get('view') as View) || 'wallet');
  const [ccy, setCcy] = useState<Ccy>('USD');
  const [live, setLive] = useState(false);
  const [cmd, setCmd] = useState(false);
  const fmt = useFmt(ccy);

  useEffect(() => {
    let g = false;
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCmd((c) => !c);
        return;
      }
      if (e.key === 'Escape') setCmd(false);
      if (typing) return;
      if (g) {
        const n = NAV.find((x) => x.key === e.key);
        if (n) setView(n.id);
        g = false;
        return;
      }
      if (e.key === 'g') g = true;
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={'ww-root' + (live ? ' with-live' : '')}>
      <video className="ww-bg" src={bgVideo} poster={bgPoster} autoPlay muted loop playsInline />
      <div className="ww-scrim" />
      <aside className="ww-sidebar">
        <div className="ww-brand">
          <img src={mark} alt="" width={28} height={28} />
          <span>
            bWallet<b>X</b>
          </span>
        </div>
        <button className="ww-account">
          <span className="ww-av">B</span>
          <div className="ww-grow">
            <div>$b0asex</div>
            <div className="ww-muted ww-small">Main · 18.42 BSV</div>
          </div>
          <span className="ww-muted">⌄</span>
        </button>
        <nav className="ww-nav">
          {NAV.map((n) => (
            <button key={n.id} className={view === n.id ? 'on' : ''} onClick={() => setView(n.id)} title={`g ${n.key}`}>
              <Icon d={n.icon} />
              <span className="ww-grow">{n.label}</span>
              {n.badge && <span className="ww-badge">{n.badge}</span>}
              {n.live && <span className="ww-livedot" />}
            </button>
          ))}
        </nav>
        <div className="ww-nav ww-nav-bottom">
          <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}>
            <Icon d={I.settings} />
            <span className="ww-grow">Settings</span>
          </button>
          <button>
            <Icon d={I.lock} />
            <span className="ww-grow">Lock</span>
            <kbd>⌘L</kbd>
          </button>
          <div className="ww-keys ww-muted">
            <kbd>g</kbd> <kbd>w</kbd> wallet · <kbd>g</kbd> <kbd>m</kbd> mail · <kbd>c</kbd> compose
          </div>
        </div>
      </aside>
      <main className="ww-main">
        <header className="ww-top">
          <button className="ww-search" onClick={() => setCmd(true)}>
            <Icon d={I.search} />
            <span className="ww-grow">Search, or ask b to do something…</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="ww-top-right">
            <button className="ww-icon-btn" title="Scan / receive">
              <Icon d={I.qr} />
            </button>
            <button className="ww-icon-btn ww-bell" title="Notifications">
              <Icon d={I.bell} />
              <i />
            </button>
            <div className="ww-seg">
              {(['USD', 'GBP'] as Ccy[]).map((c) => (
                <button key={c} className={ccy === c ? 'on' : ''} onClick={() => setCcy(c)}>
                  {c}
                </button>
              ))}
            </div>
            <button className={'ww-btn' + (live ? ' gold' : '')} onClick={() => setLive((l) => !l)} title="Show the real wallet">
              <Icon d={I.panel} /> {live ? 'Hide live wallet' : 'Open live wallet'}
            </button>
          </div>
        </header>
        <div className="ww-content">
          {view === 'wallet' && <WalletView fmt={fmt} />}
          {view === 'mail' && <MailView />}
          {view === 'chat' && <ChatView />}
          {!['wallet', 'mail', 'chat'].includes(view) && <Placeholder v={view} />}
        </div>
      </main>
      {live && (
        <aside className="ww-live-pane">
          <iframe src={liveUrl} title="bWalletX (live)" />
        </aside>
      )}
      <button className="ww-b" title="Hold to talk to b (⌘K to type)" onClick={() => setCmd(true)}>
        b
      </button>
      {cmd && (
        <div className="ww-cmd-wrap" onClick={() => setCmd(false)}>
          <div className="ww-cmd" onClick={(e) => e.stopPropagation()}>
            <div className="ww-cmd-in">
              <span className="ww-b sm">b</span>
              <input autoFocus placeholder="Send 5¢ to $alice, open bMail, swap 1 BSV to $402…" />
            </div>
            {[
              ['Go to Wallet', 'g w'],
              ['Go to bMail', 'g m'],
              ['Compose bMail', 'c'],
              ['Send BSV…', ''],
              ['Receive (show QR)', ''],
              ['Start a Space', ''],
              ['Ask b to build a feature (paid)', ''],
            ].map(([t, k], i) => (
              <div key={t} className={'ww-cmd-row' + (i === 0 ? ' on' : '')}>
                <span>{t}</span>
                {k && <kbd>{k}</kbd>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
