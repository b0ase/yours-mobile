import { useCallback, useEffect, useRef, useState } from 'react';
import { readWide, setBadge, type BappEntry, type Section, type Wide } from './bapps';
import './bapp-host.css';

/**
 * PROTOTYPE (demo/desktop-shell): bApps in the wide layout, shell protocol v2
 * (@bwalletx/connect 0.4.0, docs/WIDE-SHELL.md + docs/SHELL-PROTOCOL.md in bwalletx-connect).
 *
 * The wallet draws the sidebar entry, the bApp's `wide.sections` column and every money / permission
 * sheet; the bApp draws everything inside its frame. The frame is sandboxed without top navigation,
 * so the app can never navigate the wallet, and it never sees balances or keys.
 *
 * Trust rules (same as v1): we only talk to the frame we opened, only at its exact registered origin,
 * never with '*', and we send section ids, never URLs.
 */

const ICONS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  coin: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9h4a2 2 0 0 1 0 4H9v4M9 13h5',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  exchange: 'M7 7h13l-4-4M17 17H4l4 4',
  chat: 'M21 12a8 8 0 0 1-12 7l-5 1 1-4a8 8 0 1 1 16-4z',
  wallet: 'M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7zm0 0 2-3h12M16 13.5h2',
  feed: 'M4 5h16M4 12h16M4 19h10',
  dot: 'M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
};
const SIcon = ({ name }: { name?: string }) => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={ICONS[name ?? ''] ?? ICONS.dot} />
  </svg>
);

/* ---------- the host ---------- */
type Status = 'loading' | 'ready' | 'error';

export function BappHost({ app, onClose }: { app: BappEntry; onClose?: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [wide, setWide] = useState<Wide | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [active, setActive] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const wideRef = useRef<Wide | null>(null);
  const prevTitle = useRef(document.title);

  // 1. Manifest from the app's own origin (public JSON; the app sends CORS for it).
  useEffect(() => {
    let off = false;
    setStatus('loading');
    setConnected(false);
    fetch(`${app.origin}/.well-known/bapp.json`, { credentials: 'omit', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        if (off) return;
        const w = readWide(j);
        if (!w) throw new Error('bad manifest');
        wideRef.current = w;
        setWide(w);
        const first = w.sections.find((s) => s.path === w.home) ?? w.sections[0];
        setActive(first?.id ?? null);
        setSrc(app.origin + (first?.path ?? w.home));
        setStatus('ready');
      })
      .catch(() => !off && setStatus('error'));
    return () => {
      off = true;
    };
  }, [app.origin]);

  const post = useCallback(
    (msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(msg, app.origin),
    [app.origin],
  );
  const sendLayout = useCallback(() => {
    const el = frame.current;
    const w = wideRef.current;
    if (!el || !w) return;
    const width = Math.round(el.getBoundingClientRect().width);
    const standalone = matchMedia('(display-mode: standalone)').matches;
    post({ type: 'bapp:layout', v: 2, layout: width >= w.minWidth ? 'wide' : 'phone', width, ...(standalone ? { standalone } : {}) });
  }, [post]);

  // 2. Handshake: hello until ready (the app may still be booting), then layout; resend layout on resize.
  const onLoad = useCallback(() => {
    setConnected(false);
    let tries = 0;
    const t = setInterval(() => {
      if (++tries > 40) return clearInterval(t);
      post({ type: 'bapp:hello', v: 2 });
    }, 250);
    post({ type: 'bapp:hello', v: 2 });
    helloTimer.current = t;
  }, [post]);
  const helloTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(() => connectedRef.current && sendLayout());
    ro.observe(el);
    return () => ro.disconnect();
  }, [src, sendLayout]);
  const connectedRef = useRef(false);

  // 3. Messages from the app: only our frame, only its exact origin.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== app.origin) return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || typeof d !== 'object' || typeof d.type !== 'string' || !d.type.startsWith('bapp:')) return;
      const known = (s: unknown): s is string => typeof s === 'string' && !!wideRef.current?.sections.some((x) => x.id === s);
      switch (d.type) {
        case 'bapp:ready':
          if (helloTimer.current) clearInterval(helloTimer.current);
          connectedRef.current = true;
          setConnected(true);
          if (known(d.section)) setActive(d.section);
          sendLayout();
          break;
        case 'bapp:active':
          if (known(d.section)) setActive(d.section);
          break;
        case 'bapp:badge':
          if (typeof d.count === 'number' && Number.isFinite(d.count)) setBadge(app.id, Math.max(0, Math.min(9999, Math.floor(d.count))));
          break;
        case 'bapp:title':
          // eslint-disable-next-line no-control-regex -- strip control characters from the app's title
          if (typeof d.title === 'string') document.title = `${d.title.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80)} — bWalletX`;
          break;
        case 'bapp:menu':
          // The wide shell's account drawer (flag.ts WW_OPEN; an event so this file stands alone).
          window.dispatchEvent(new CustomEvent('ww:open', { detail: 'drawer' }));
          break;
        case 'bapp:close':
          onClose?.();
          break;
      }
    };
    addEventListener('message', onMsg);
    return () => removeEventListener('message', onMsg);
  }, [app.id, app.origin, onClose, sendLayout]);

  useEffect(() => {
    const t = prevTitle.current;
    return () => {
      document.title = t;
      if (helloTimer.current) clearInterval(helloTimer.current);
    };
  }, []);

  const pick = (s: Section) => {
    setActive(s.id);
    if (connected) post({ type: 'bapp:navigate', v: 2, section: s.id });
    else setSrc(app.origin + s.path); // not connected (yet): just load the page
  };

  return (
    <div className="bwx-bapp" data-bapp={app.id}>
      <nav className="bwx-bapp-sections" aria-label={`${app.name} sections`}>
        <div className="bwx-bapp-head">
          {wide?.icon ? <img src={app.origin + wide.icon} alt="" width={26} height={26} /> : <span className="bwx-bapp-ph" />}
          <span className="bwx-bapp-name">{wide?.name ?? app.name}</span>
          <span className={`bwx-bapp-dot ${connected ? 'on' : ''}`} title={connected ? 'Connected' : 'Connecting…'} />
        </div>
        {wide?.sections.map((s) => (
          <button key={s.id} className={active === s.id ? 'on' : ''} aria-current={active === s.id ? 'page' : undefined} onClick={() => pick(s)}>
            <SIcon name={s.icon} />
            <span>{s.label}</span>
          </button>
        ))}
        <div className="bwx-bapp-foot">
          <span>{new URL(app.origin).host}</span>
          {onClose && (
            <button className="bwx-bapp-close" onClick={onClose} title={`Close ${app.name}`}>
              ✕
            </button>
          )}
        </div>
      </nav>
      <div className="bwx-bapp-stage">
        {status === 'error' && <div className="bwx-bapp-msg">Couldn’t reach {app.name} ({new URL(app.origin).host}).</div>}
        {status === 'loading' && <div className="bwx-bapp-msg">Opening {app.name}…</div>}
        {src && (
          <iframe
            ref={frame}
            className="bwx-bapp-frame"
            title={app.name}
            src={src}
            onLoad={onLoad}
            // No allow-top-navigation: the app can't move the wallet. Popups open in a new tab.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
            allow="autoplay; fullscreen; clipboard-write; picture-in-picture"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        )}
      </div>
    </div>
  );
}

