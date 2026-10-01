import { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Clock, ExternalLink, Github, Globe } from 'lucide-react';
import { BAPP_GROUPS, bappsIn, type BApp } from './bapps';
import { TopNav } from '../components/TopNav';
import { ONE_SAT_MARKET_URL, featuredApps } from '../utils/constants';
import { UNOFFICIAL_NOTICE } from './brandText';
import { openDappBrowser } from './dappBrowser';

/**
 * Browser tab (theme.settings.services.browser). Sites open in the in-app
 * dApp browser, where they get window.CWI and ask the wallet for permission.
 */

const RECENT_KEY = 'bwallet:recent-sites';
const MAX_RECENT = 6;

const readRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
};

const rememberRecent = (url: string) => {
  try {
    const next = [url, ...readRecent().filter((u) => u !== url)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: history is a convenience only
  }
};

/** Accepts "1sat.market", "https://…"; rejects anything that isn't http(s). */
export const normaliseUrl = (typed: string): string | null => {
  const text = typed.trim();
  if (!text || /\s/.test(text)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.href;
  } catch {
    return null;
  }
};

// Upstream's featured list, minus sites that no longer resolve (checked 2026-09-29).
const DEAD_HOSTS = new Set(['taleofshua.com']);

// Third-party apps (Apps › Other apps). Our own live in ./bapps.ts.
const apps = [
  { name: '1Sat Market', link: ONE_SAT_MARKET_URL, icon: undefined as string | undefined },
  { name: '1satsocial', link: 'https://1satsocial.online', icon: 'https://1satsocial.online/favicon.ico' },
  { name: 'Treechat', link: 'https://treechat.com', icon: 'https://treechat.com/assets/favicon.svg' },
  { name: 'Tempo', link: 'https://tempomusic.net', icon: 'https://tempomusic.net/favicon.ico' },
  ...featuredApps
    .filter((a) => a.link && a.name && !DEAD_HOSTS.has(new URL(a.link).hostname))
    .filter((a) => new URL(a.link).hostname !== 'yours.org')
    .map((a) => ({ name: a.name, link: a.link, icon: a.icon })),
];

const AppIcon = ({ src }: { src?: string }) => {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return <img src={src} alt="" onError={() => setFailed(true)} className="h-9 w-9 rounded-lg object-cover" />;
  }
  return (
    <div className="h-9 w-9 rounded-lg bg-[#2b2f36] flex items-center justify-center">
      <Globe size={16} style={{ color: '#A1FF8B' }} />
    </div>
  );
};

/** bApp icon: the site's icon, else a gold "b" monogram. */
const BAppIcon = ({ src }: { src?: string }) => {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setFailed(true)}
        className="h-10 w-10 rounded-xl object-cover bg-[#2b2f36] shrink-0"
      />
    );
  }
  return (
    <div
      className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0 font-bold text-lg"
      style={{ background: '#EAB300', color: '#010101' }}
    >
      b
    </div>
  );
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const BrowserPage = () => {
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [recent, setRecent] = useState(readRecent);
  const [section, setSection] = useState<'bapps' | 'other'>('bapps');

  const go = (url: string) => {
    setError('');
    rememberRecent(url);
    setRecent(readRecent());
    openDappBrowser(url).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = normaliseUrl(address);
    if (!url) return setError('Enter a web address, like 1sat.market');
    go(url);
  };

  const bappCard = (app: BApp) => (
    <div key={app.url} className="rounded-xl bg-[#17191E] px-3 py-3 flex flex-col gap-2">
      <button onClick={() => go(app.url)} className="flex items-center gap-3 text-left">
        <BAppIcon src={app.icon} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">{app.name}</span>
            <span
              className="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase"
              style={
                app.status === 'live'
                  ? { background: '#EAB30022', color: '#FFD24D' }
                  : { background: '#2b2f36', color: '#98A2B3' }
              }
            >
              {app.status === 'live' ? 'Live' : 'Demo'}
            </span>
          </div>
          <div className="text-[11px] text-[#98A2B3] leading-snug">{app.verb}</div>
        </div>
        <ExternalLink size={14} className="shrink-0" style={{ color: '#98A2B3' }} />
      </button>
      <div className="flex items-center gap-2 text-[10px] pl-[3.25rem]">
        <span className="rounded-full px-2 py-0.5 font-semibold bg-[#2b2f36] text-[#98A2B3]">
          {app.source ? 'Open source' : 'Closed source'}
        </span>
        {app.source && (
          <button onClick={() => go(app.source!)} className="flex items-center gap-1 text-[#98A2B3]">
            <Github size={11} /> {new URL(app.source).pathname.slice(1)}
          </button>
        )}
      </div>
    </div>
  );

  const row = (key: string, title: string, subtitle: string, onClick: () => void, icon: React.ReactNode) => (
    <motion.button
      key={key}
      whileTap={{ scale: 0.985 }}
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-xl px-4 py-3 text-left bg-[#17191E]"
    >
      <div className="flex items-center gap-3 min-w-0">
        {icon}
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white truncate">{title}</div>
          <div className="text-[11px] text-[#98A2B3] truncate">{subtitle}</div>
        </div>
      </div>
      <ExternalLink size={14} className="shrink-0" style={{ color: '#98A2B3' }} />
    </motion.button>
  );

  return (
    <div
      className="flex w-full flex-col items-center overflow-x-hidden overflow-y-auto pb-20"
      style={{ height: '100%', background: '#010101' }}
    >
      <TopNav />
      <div className="w-full px-4 pb-6 pt-16 flex flex-col gap-5">
        <form onSubmit={submit} className="flex flex-col gap-2">
          <h1 className="text-lg font-bold text-white">Browse BSV apps</h1>
          <p className="text-xs text-[#98A2B3] leading-relaxed">
            Sites open inside the wallet and can ask to use it. You approve every request.
          </p>
          <div className="flex items-center gap-2 rounded-xl border border-[#344054] bg-[#17191E] px-3">
            <Globe size={16} style={{ color: '#98A2B3' }} />
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Search or enter address"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 bg-transparent py-3 text-white outline-none placeholder:text-[#667085]"
              aria-label="Web address"
            />
            <button type="submit" aria-label="Go" className="p-2">
              <ArrowRight size={18} style={{ color: '#A1FF8B' }} />
            </button>
          </div>
          {error && <p className="text-xs text-[#F97066]">{error}</p>}
        </form>

        <div className="flex gap-1 rounded-xl p-1 bg-[#17191E]">
          {(
            [
              ['bapps', 'bApps'],
              ['other', 'Other apps'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              className="flex-1 rounded-lg py-1.5 text-xs font-semibold"
              style={{
                background: section === id ? '#2b2f36' : 'transparent',
                color: section === id ? '#fff' : '#98A2B3',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {section === 'bapps' ? (
          <section className="flex flex-col gap-2">
            {BAPP_GROUPS.map((g) => (
              <div key={g.id} className="flex flex-col gap-2">
                {g.id === 'work' && <h2 className="pt-3 text-sm font-bold text-white">All bApps</h2>}
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#667085] pt-1">{g.label}</h2>
                {bappsIn(g.id).map((app) => bappCard(app))}
              </div>
            ))}
          </section>
        ) : (
          <section className="flex flex-col gap-2">
            {apps.map((app) =>
              row(`a:${app.link}`, app.name, hostOf(app.link), () => go(app.link), <AppIcon src={app.icon} />),
            )}
            <p className="text-[10px] text-[#667085] text-center">Not made by The Bitcoin Corporation.</p>
          </section>
        )}

        {recent.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#667085]">Recent</h2>
            {recent.map((url) =>
              row(`r:${url}`, hostOf(url), url, () => go(url), <Clock size={18} style={{ color: '#98A2B3' }} />),
            )}
          </section>
        )}

        <p className="text-[10px] leading-relaxed text-[#667085] text-center px-2">{UNOFFICIAL_NOTICE}</p>
      </div>
    </div>
  );
};

export default BrowserPage;
