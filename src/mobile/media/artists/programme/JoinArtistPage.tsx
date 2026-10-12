import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { useServiceContext } from '../../../../hooks/useServiceContext';
import { useReleases } from '../../releases/useReleases';
import {
  artistSlug,
  DEFAULT_POT_SHARE_PCT,
  MAX_POT_SHARE_PCT,
  potSharePct,
  SPONSOR_PLAYS_PER_ARTIST,
} from './programme';
import { artistPageUrl, claimArtist, getDashboard, saveTracks, type ArtistDashboard, type TrackChoice } from './api';

/**
 * /m/media/artists/join: "Join as an artist" (docs/ARTIST-PROGRAMME.md). Claim a page with your bWalletX key, add
 * music through Add Release, set a price per track and which tracks are free to listeners, share the page, see the
 * dashboard. Mounted only when ARTIST_PROGRAMME_ENABLED (off by default; never in a store build).
 */
const GOLD = '#FFD24D';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const SLUG_KEY = 'bwx.artist.slug';

const savedSlug = () => {
  try {
    return localStorage.getItem(SLUG_KEY) ?? '';
  } catch {
    return '';
  }
};

const Card = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
  <section className="rounded-xl p-4 mb-4" style={{ border: `1px solid ${LINE}` }}>
    <div className="text-[12px] font-bold tracking-[.18em] uppercase" style={{ color: GOLD }}>
      Step {n}
    </div>
    <h3 className="text-lg font-bold text-white mt-1 mb-2">{title}</h3>
    {children}
  </section>
);

const JoinArtistPage = () => {
  const navigate = useNavigate();
  const { apiContext } = useServiceContext();
  const releases = useReleases();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState(savedSlug);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState(DEFAULT_POT_SHARE_PCT);
  const [choices, setChoices] = useState<Record<string, TrackChoice>>({});
  const [dash, setDash] = useState<ArtistDashboard | null>(null);

  useEffect(() => {
    if (!slug) return;
    void getDashboard(slug).then((r) => r.ok && setDash(r.data));
  }, [slug]);

  const mine = useMemo(
    () => releases.filter((r) => name && r.artist.trim().toLowerCase() === name.trim().toLowerCase()),
    [releases, name],
  );

  const claim = async () => {
    const s = artistSlug(name);
    if (!s || !apiContext) return setMsg('Pick a name with at least two letters or numbers.');
    setBusy(true);
    const r = await claimArtist(apiContext, s, name.trim());
    setBusy(false);
    if (!r.ok) return setMsg(r.error);
    try {
      localStorage.setItem(SLUG_KEY, r.data.slug);
    } catch {
      /* storage blocked: the page still works this session */
    }
    setSlug(r.data.slug);
    setMsg('');
  };

  const save = async () => {
    if (!apiContext || !slug) return;
    setBusy(true);
    const r = await saveTracks(apiContext, slug, Object.values(choices), potSharePct(share));
    setBusy(false);
    setMsg(r.ok ? 'Saved.' : r.error);
  };

  const setChoice = (trackId: string, patch: Partial<TrackChoice>) =>
    setChoices((c) => ({
      ...c,
      [trackId]: { ...(c[trackId] ?? { trackId, priceSats: 0, sponsored: true }), ...patch },
    }));

  const link = slug ? artistPageUrl(slug) : '';

  return (
    <div className="px-4 py-6 max-w-2xl mx-auto w-full text-white">
      <button
        onClick={() => navigate('/m/media/artists')}
        className="flex items-center gap-1 mb-3"
        style={{ color: MUTED }}
      >
        <ChevronLeft size={18} /> Artists
      </button>
      <div className="text-[12px] font-bold tracking-[.18em] uppercase" style={{ color: GOLD }}>
        bMusic
      </div>
      <h2 className="text-3xl font-bold mt-1 mb-2">Join as an artist</h2>
      <p className="mb-5" style={{ color: MUTED }}>
        No BSV needed to start. bWalletX pays for your first {SPONSOR_PLAYS_PER_ARTIST.toLocaleString()} listener plays,
        so your page says “Free to listen — sponsored by bWalletX”.
      </p>

      <Card n={1} title="Claim your artist page">
        {slug ? (
          <div>
            Your page: <span style={{ color: GOLD }}>/bmusic/artists/{slug}</span>
            {dash?.founding && (
              <span
                className="ml-2 px-2 py-0.5 rounded-full text-[11px] font-bold text-black"
                style={{ background: GOLD }}
              >
                Founding artist
              </span>
            )}
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Artist name"
              className="flex-1 px-3 py-2 rounded-lg bg-black text-white"
              style={{ border: `1px solid ${LINE}` }}
            />
            <button
              disabled={busy}
              onClick={() => void claim()}
              className="px-4 py-2 rounded-full font-bold text-black"
              style={{ background: GOLD }}
            >
              Claim
            </button>
          </div>
        )}
      </Card>

      <Card n={2} title="Add your music">
        <p className="mb-2" style={{ color: MUTED }}>
          Publish tracks with Add Release, using the same artist name.
        </p>
        <button onClick={() => navigate('/m/media/new')} className="font-bold" style={{ color: GOLD }}>
          Open Add Release
        </button>
      </Card>

      <Card n={3} title="Prices and free tracks">
        {!name && <p style={{ color: MUTED }}>Type your artist name above to list your releases.</p>}
        {mine.flatMap((r) =>
          r.tracks.map((t) => {
            const c = choices[t.origin] ?? { trackId: t.origin, priceSats: 0, sponsored: true };
            return (
              <div key={t.origin} className="flex items-center gap-2 py-1.5 border-b" style={{ borderColor: '#222' }}>
                <span className="flex-1 truncate">{t.title}</span>
                <label className="text-[12px] flex items-center gap-1" style={{ color: MUTED }}>
                  <input
                    type="checkbox"
                    checked={c.sponsored}
                    onChange={(e) => setChoice(t.origin, { sponsored: e.target.checked })}
                  />
                  Free to listeners
                </label>
                <input
                  type="number"
                  min={0}
                  value={c.priceSats}
                  onChange={(e) =>
                    setChoice(t.origin, { priceSats: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
                  }
                  className="w-24 px-2 py-1 rounded bg-black text-white text-right"
                  style={{ border: `1px solid ${LINE}` }}
                  aria-label="Price in sats"
                />
                <span className="text-[12px]" style={{ color: MUTED }}>
                  sats
                </span>
              </div>
            );
          }),
        )}
        <label className="block mt-3 text-sm" style={{ color: MUTED }}>
          Share of each sale that keeps your free plays going: {potSharePct(share)}%
          <input
            type="range"
            min={0}
            max={MAX_POT_SHARE_PCT}
            value={share}
            onChange={(e) => setShare(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <button
          disabled={busy || !slug}
          onClick={() => void save()}
          className="mt-2 px-4 py-2 rounded-full font-bold text-black"
          style={{ background: GOLD, opacity: slug ? 1 : 0.4 }}
        >
          Save
        </button>
      </Card>

      <Card n={4} title="Share your page">
        {link ? (
          <button onClick={() => void navigator.clipboard?.writeText(link)} style={{ color: GOLD }}>
            Copy {link.replace('https://', '')}
          </button>
        ) : (
          <p style={{ color: MUTED }}>Claim your page first.</p>
        )}
      </Card>

      <Card n={5} title="Dashboard">
        {dash ? (
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>Plays (30 days): {dash.plays30d}</div>
            <div>New listeners: {dash.newListeners30d}</div>
            <div>Sales: {dash.salesSats.toLocaleString()} sats</div>
            <div>Listener pot: {dash.potSats.toLocaleString()} sats</div>
            <div>Free plays left: {dash.sponsoredPlaysLeft}</div>
            <div>Rank: {dash.rank ?? '–'}</div>
          </div>
        ) : (
          <p style={{ color: MUTED }}>Your plays, listeners, sales and pot show here once your page is live.</p>
        )}
      </Card>
      {msg && <p style={{ color: GOLD }}>{msg}</p>}
    </div>
  );
};

export default JoinArtistPage;
