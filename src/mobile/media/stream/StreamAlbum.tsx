import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pause, Play, Square } from 'lucide-react';
import type { PrivateKey } from '@bsv/sdk';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { pauseAudio } from '../player';
import { albumUrl, fetchManifest, getPayTo, postSegment, type Manifest } from './api';
import { albumView } from './album';
import { HEADLINE_ALBUM } from '../featured/featured';
import { VEXVOID_STILLS, VEXVOID_THUMBS } from '../featured/stills';
import { StillsBanner } from '../featured/StillsBanner';
import { StreamEngine } from './engine';
import { PerSecondKeySource } from './keySource';
import { paymentsPerSecond, SessionPayer, type PayerSnapshot } from './payer';
import { ACTIVE_SESSIONS, forgetSession, openSession, sweepFirst } from './session';
import { estimateTotal, SEGMENT_FEE } from './tx';

/** The album's free headline track, played from the wallet's own copy (featured.ts) by the page. */
export type Headline = { playing: boolean; duration?: number; onPlay: () => void };

/**
 * Media › the album page ("Echoes in the Abyss" by VexVoid): the free headline track first, then the
 * pay-per-second streaming (bWalletX only, PAY_STREAM_ENABLED). One budget approval funds a
 * session key; after that each 1-second segment is its own transaction (Teranode throughput demo), with no
 * popups. Stop, leaving, or 60 s hidden returns what's left to the wallet.
 */
const GOLD = '#FFD24D';
const PANEL = '#111216';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const HIDDEN_STOP_MS = 60_000;

type Session = { id: string; key: PrivateKey; payer: SessionPayer; engine: StreamEngine };

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export default function StreamAlbum({ headline }: { headline: Headline }) {
  const { apiContext } = useServiceContext();
  const wallet = apiContext?.wallet;
  const [m, setM] = useState<Manifest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | { track: number; from?: number; topUp?: boolean }>(null);
  const [busy, setBusy] = useState(false);
  const [snap, setSnap] = useState<PayerSnapshot | null>(null);
  const [track, setTrack] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [returned, setReturned] = useState<string | null>(null);
  const [, tick] = useState(0);
  const session = useRef<Session | null>(null);

  useEffect(() => {
    fetchManifest()
      .then(setM)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  const view = m
    ? albumView(
        m,
        {
          title: HEADLINE_ALBUM.title,
          artist: HEADLINE_ALBUM.artist,
          cover: HEADLINE_ALBUM.cover,
          headlineTitle: HEADLINE_ALBUM.headline.title,
        },
        albumUrl('manifest.json'),
      )
    : null;
  // The budget covers the paid tracks only: the headline is free.
  const albumSeconds = m && view ? view.paid.reduce((s, p) => s + p.track.segments * m.segmentSeconds, 0) : 0;

  /** Stop paying and return the leftover to the wallet. */
  const end = useCallback(async () => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    s.engine.stop();
    s.payer.close();
    setPlaying(false);
    if (!wallet) return;
    try {
      const sats = await sweepFirst(wallet, s.key, s.payer.sweepCandidates());
      forgetSession(s.id);
      setReturned(sats ? `${sats} sats returned to your wallet` : null);
    } catch (e) {
      ACTIVE_SESSIONS.delete(s.id);
      // The record stays; the next app start sweeps it (session.ts recoverSessions).
      setReturned(`Couldn't return the budget yet (${e instanceof Error ? e.message : e}). It will be retried.`);
    }
  }, [wallet]);

  // Leaving the page ends the session; hidden for 60 s does too.
  useEffect(() => () => void end(), [end]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onVis = () => {
      if (t) clearTimeout(t);
      t = document.hidden ? setTimeout(() => void end(), HIDDEN_STOP_MS) : null;
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onVis);
    return () => {
      if (t) clearTimeout(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onVis);
    };
  }, [end]);
  useEffect(() => {
    if (!playing) return;
    const i = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, [playing]);

  const start = async (budget: number, index: number, from = 0) => {
    if (!wallet || !m) return;
    setBusy(true);
    setProblem(null);
    setReturned(null);
    try {
      await end();
      const { id, key, coin } = await openSession(wallet, budget);
      const payer = new SessionPayer({
        key,
        coin,
        getPayTo: (t, n) => getPayTo(t, n),
        post: (b) => postSegment(b),
        onChange: setSnap,
      });
      const engine = new StreamEngine(m, new PerSecondKeySource(payer, key), {
        onTrack: setTrack,
        onPlaying: setPlaying,
        onAlbumEnd: () => void end(),
        onError: (e) => {
          if (payer.status === 'out') setSheet({ track: engine.index, from: engine.seg, topUp: true });
          else setProblem(e instanceof Error ? e.message : String(e));
        },
      });
      session.current = { id, key, payer, engine };
      setSnap(payer.snapshot());
      setSheet(null);
      pauseAudio();
      void engine.playTrack(index, from);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const playAt = (index: number) => {
    const s = session.current;
    if (!s) return setSheet({ track: index });
    if (s.engine.index === index) return s.engine.paused ? s.engine.resume() : s.engine.pause();
    void s.engine.playTrack(index);
  };

  const retry = () => {
    const s = session.current;
    if (!s) return;
    s.payer.resync();
    setProblem(null);
    void s.engine.playTrack(s.engine.index, s.engine.seg);
  };

  const title = view?.title ?? HEADLINE_ALBUM.title;
  const artist = view?.artist ?? HEADLINE_ALBUM.artist;
  const cover = view?.cover ?? HEADLINE_ALBUM.cover;
  const st = snap?.stats;
  const s = session.current;
  const playHeadline = () => {
    void end();
    headline.onPlay();
  };
  const thumb = (n: number) => VEXVOID_THUMBS[n % VEXVOID_THUMBS.length];
  return (
    <section
      className="flex flex-col gap-5"
      style={{ border: `1px solid ${LINE}`, borderRadius: 6, overflow: 'hidden' }}
    >
      <StillsBanner stills={VEXVOID_STILLS} className="w-full">
        <div className="flex flex-col md:flex-row gap-5 md:gap-8 p-4 md:p-6">
          <img
            src={cover}
            onError={(e) => {
              if (e.currentTarget.src !== HEADLINE_ALBUM.cover) e.currentTarget.src = HEADLINE_ALBUM.cover;
            }}
            alt={`${title} cover`}
            className="w-full md:w-[260px] shrink-0 aspect-square object-cover"
            style={{ borderRadius: 6, boxShadow: '0 10px 30px rgba(0,0,0,0.7)', background: '#000' }}
          />
          <div className="flex-1 min-w-0 flex flex-col justify-end gap-2">
            <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: GOLD }}>
              Album
            </div>
            <h2 className="text-3xl md:text-5xl font-black text-white leading-tight">{title}</h2>
            <div className="text-sm text-white/80">
              {artist}
              {m ? ` · ${view!.paid.length + 1} tracks` : ''}
            </div>
            <div className="text-sm mt-1" style={{ color: '#e6e8ec' }}>
              Headline track: {HEADLINE_ALBUM.headline.title} · <span style={{ color: GOLD }}>free</span>
            </div>
            <div className="text-xs" style={{ color: MUTED }}>
              Other tracks: 1 sat/sec to the artist + network fee
            </div>
            <div className="mt-2">
              <button
                onClick={playHeadline}
                className="px-5 py-2 text-sm font-bold inline-flex items-center gap-2"
                style={{ background: GOLD, color: '#1a1300', borderRadius: 4 }}
              >
                {headline.playing ? <Pause size={16} /> : <Play size={16} fill="#1a1300" />}
                {headline.playing ? 'Pause' : 'Listen free'}
              </button>
            </div>
          </div>
        </div>
      </StillsBanner>
      <div className="flex flex-col gap-3 px-4 md:px-6 pb-4 md:pb-6">
        {st && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs" style={{ color: MUTED }}>
            <Stat label="To the artist" value={`${st.artistSats} sats`} />
            <Stat label="Network fees" value={`${st.feeSats} sats`} />
            <Stat label="Payments" value={String(st.payments)} />
            <Stat label="Payments/sec" value={paymentsPerSecond(st.recent).toFixed(2)} />
            <Stat label="Budget left" value={`${snap?.balance ?? 0} sats`} />
          </div>
        )}
        {st?.lastTxid && (
          <a
            className="text-[11px] break-all underline-offset-4 hover:underline"
            style={{ color: GOLD }}
            href={`https://whatsonchain.com/tx/${st.lastTxid}`}
            target="_blank"
            rel="noreferrer"
          >
            Last payment {st.lastTxid}
          </a>
        )}
        {problem && (
          <div className="flex items-center gap-3 text-xs">
            <span className="text-[#F97066]">Payments stopped: {problem}</span>
            {s && snap?.status === 'error' && (
              <button onClick={retry} className="font-bold" style={{ color: GOLD }}>
                Resync and continue
              </button>
            )}
          </div>
        )}
        {returned && (
          <div className="text-xs" style={{ color: MUTED }}>
            {returned}
          </div>
        )}
        {s && (
          <div className="flex gap-2">
            <button
              onClick={() => (s.engine.paused ? s.engine.resume() : s.engine.pause())}
              className="px-4 py-2 text-sm font-bold flex items-center gap-2"
              style={{ background: GOLD, color: '#1a1300', borderRadius: 4 }}
            >
              {playing ? <Pause size={16} /> : <Play size={16} fill="#1a1300" />}
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              onClick={() => void end()}
              className="px-4 py-2 text-sm font-bold flex items-center gap-2"
              style={{ border: `1px solid ${LINE}`, color: MUTED, borderRadius: 4 }}
            >
              <Square size={14} /> Stop and return budget
            </button>
          </div>
        )}
        <div className="flex flex-col" style={{ borderTop: `1px solid ${LINE}` }}>
          <button
            onClick={playHeadline}
            className="flex items-center gap-3 py-2 text-left"
            style={{ borderBottom: `1px solid ${LINE}`, background: 'rgba(255,210,77,0.06)' }}
          >
            <span className="w-6 text-xs text-right" style={{ color: GOLD }}>
              {headline.playing ? '▶' : 1}
            </span>
            <img src={thumb(0)} alt="" className="w-9 h-9 object-cover shrink-0" style={{ borderRadius: 3 }} />
            <span className="flex-1 min-w-0">
              <span className="block text-sm text-white truncate">{HEADLINE_ALBUM.headline.title}</span>
              <span className="block text-[10px] font-bold uppercase tracking-widest" style={{ color: GOLD }}>
                Headline track
              </span>
            </span>
            <span className="text-xs" style={{ color: MUTED }}>
              {headline.duration ? fmt(headline.duration) : ''}
            </span>
            <span
              className="px-2 py-0.5 text-[10px] font-bold uppercase"
              style={{ border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 4 }}
            >
              Free
            </span>
          </button>
          {!m && (
            <div className="py-2 text-xs" style={{ color: MUTED }}>
              {loadError ? 'The other tracks are unavailable right now.' : 'Loading the other tracks…'}
            </div>
          )}
          {m &&
            view!.paid.map(({ index: i, track: t }, row) => (
              <button
                key={t.trackId}
                onClick={() => playAt(i)}
                className="flex items-center gap-3 py-2 text-left"
                style={{ borderBottom: `1px solid ${LINE}` }}
              >
                <span className="w-6 text-xs text-right" style={{ color: track === i ? GOLD : MUTED }}>
                  {track === i && playing ? '▶' : row + 2}
                </span>
                <img
                  src={thumb(row + 1)}
                  alt=""
                  className="w-9 h-9 object-cover shrink-0"
                  style={{ borderRadius: 3 }}
                />
                <span className="flex-1 min-w-0 text-sm text-white truncate">{t.title}</span>
                <span className="text-xs" style={{ color: MUTED }}>
                  {fmt(t.segments * m.segmentSeconds)}
                </span>
                <span className="text-[10px] font-bold uppercase" style={{ color: MUTED }}>
                  1 sat/sec
                </span>
              </button>
            ))}
        </div>
      </div>
      {sheet && m && (
        <BudgetSheet
          albumSeconds={albumSeconds}
          satsPerSecond={m.satsPerSegment}
          topUp={!!sheet.topUp}
          busy={busy}
          onCancel={() => {
            setSheet(null);
            if (sheet.topUp) void end();
          }}
          onAllow={(b) => void start(b, sheet.track, sheet.from)}
        />
      )}
    </section>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="p-2" style={{ background: PANEL, borderRadius: 4 }}>
    <div className="text-[10px] uppercase tracking-widest">{label}</div>
    <div className="text-sm font-bold text-white">{value}</div>
  </div>
);

/** One approval before the first play: the most this album can spend. No popups after it. */
function BudgetSheet(p: {
  albumSeconds: number;
  satsPerSecond: number;
  topUp: boolean;
  busy: boolean;
  onAllow: (sats: number) => void;
  onCancel: () => void;
}) {
  const options = [
    { label: 'The whole album', seconds: p.albumSeconds },
    { label: '10 minutes', seconds: 600 },
    { label: '1 minute', seconds: 60 },
  ].filter((o) => o.seconds <= p.albumSeconds || o.label === 'The whole album');
  const [pick, setPick] = useState(0);
  const seconds = options[pick].seconds;
  // + one sweep fee so the leftover can always come back.
  const sats = estimateTotal(seconds, p.satsPerSecond) + SEGMENT_FEE;
  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-end md:items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
    >
      <div
        className="w-full max-w-[440px] p-5 flex flex-col gap-4"
        style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8 }}
      >
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: GOLD }}>
            {p.topUp ? 'Budget used up' : 'Listening budget'}
          </div>
          <h3 className="text-xl font-black text-white mt-1">
            Allow up to {sats.toLocaleString()} sats for this album
          </h3>
          <p className="text-xs mt-2" style={{ color: MUTED }}>
            ≈ {p.satsPerSecond + SEGMENT_FEE} sats per second: {p.satsPerSecond} to the artist + {SEGMENT_FEE} network
            fee (one payment every second). Pause stops paying. Whatever is left comes back to your wallet when you
            stop.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {options.map((o, i) => (
            <button
              key={o.label}
              onClick={() => setPick(i)}
              className="flex justify-between px-3 py-2 text-sm"
              style={{
                borderRadius: 4,
                border: `1px solid ${pick === i ? GOLD : LINE}`,
                color: pick === i ? GOLD : '#fff',
              }}
            >
              <span>{o.label}</span>
              <span>{(estimateTotal(o.seconds, p.satsPerSecond) + SEGMENT_FEE).toLocaleString()} sats</span>
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            disabled={p.busy}
            onClick={() => p.onAllow(sats)}
            className="flex-1 py-2.5 text-sm font-bold"
            style={{ background: GOLD, color: '#1a1300', borderRadius: 4, opacity: p.busy ? 0.6 : 1 }}
          >
            {p.busy ? 'Waiting for the wallet…' : 'Allow and play'}
          </button>
          <button onClick={p.onCancel} className="px-4 py-2.5 text-sm" style={{ color: MUTED }}>
            Not now
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
