/**
 * A generic bApp feed: that bApp's bChatX brand-account posts (bchatxFeed.ts), in its own colour.
 * bMusic also leads with its shareable album releases (media/shareAlbums.ts).
 * Most brand accounts have no posts yet, so the empty state is the bApp's icon and colour with
 * "Open in bChatX" (in-frame on phones / the extension, a tab on web, via openBapp).
 */
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Music } from 'lucide-react';
import { openBapp } from '../bappFrame/bappFrame';
import { SHARE_ALBUMS, albumPublicPath } from '../media/shareAlbums';
import { IconTile } from './FeedPicker';
import { fetchBrandPage, profileUrl, type BrandPost } from './bchatxFeed';
import { feedIcon } from './feedIcons';
import { feedColor, feedDef, type FeedId } from './feeds';

const MUTED = '#8a8f98';
const LINE = '#1f2127';
const DESKTOP = 'https://desktop.bwalletx.com';

const when = (at: number) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');

const PostCard = ({ p, color }: { p: BrandPost; color: string }) => {
  const m = p.media[0];
  return (
    <button
      onClick={() => void openBapp('bChatX', p.link)}
      className="mx-4 mb-3 block rounded-2xl p-3 text-left active:opacity-80"
      style={{ background: '#0d0d0f', border: `1px solid ${LINE}` }}
    >
      {p.credit && (
        <p className="mb-1 text-[11px]" style={{ color }}>
          via {p.credit.via}
        </p>
      )}
      {p.text && <p className="whitespace-pre-wrap break-words text-sm text-white">{p.text}</p>}
      {m &&
        (m.kind === 'image' ? (
          <img src={m.src} alt="" loading="lazy" className="mt-2 w-full rounded-xl object-cover" />
        ) : m.kind === 'video' ? (
          <video src={m.src} poster={m.thumb ?? undefined} controls playsInline className="mt-2 w-full rounded-xl" />
        ) : (
          <audio src={m.src} controls className="mt-2 w-full" />
        ))}
      <p className="mt-2 text-[11px]" style={{ color: MUTED }}>
        {when(p.at)}
      </p>
    </button>
  );
};

const Albums = ({ color }: { color: string }) => (
  <div className="flex flex-col gap-2 px-4 pb-3 pt-3">
    {SHARE_ALBUMS.map((a) => (
      <button
        key={a.id}
        onClick={() => void openBapp('bMusic', `${DESKTOP}${albumPublicPath(a)}`)}
        className="flex items-center gap-3 rounded-2xl p-3 text-left active:opacity-80"
        style={{ background: '#0d0d0f', border: `1px solid ${color}` }}
      >
        <Music size={22} color={color} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-white">{a.title}</span>
          <span className="block text-xs" style={{ color: MUTED }}>
            {a.artist} · new release
          </span>
        </span>
        <ExternalLink size={14} color={MUTED} />
      </button>
    ))}
  </div>
);

export const BrandFeed = ({ slug }: { slug: FeedId }) => {
  const color = feedColor(slug);
  const label = feedDef(slug).label;
  const [posts, setPosts] = useState<BrandPost[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (cursor: string | null) => {
      setBusy(true);
      setError('');
      try {
        const page = await fetchBrandPage(slug, cursor);
        setPosts((prev) => (cursor && prev ? [...prev, ...page.posts] : page.posts));
        setNext(page.next);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load these posts.');
        setPosts((prev) => prev ?? []);
      } finally {
        setBusy(false);
      }
    },
    [slug],
  );

  useEffect(() => {
    setPosts(null);
    setNext(null);
    void load(null);
  }, [load]);

  const openBchatx = () => void openBapp('bChatX', profileUrl(slug));

  return (
    <div className="flex flex-col pb-24">
      {slug === 'bmusic' && <Albums color={color} />}
      {posts === null ? (
        <p className="pt-10 text-center text-xs" style={{ color: MUTED }}>
          Loading…
        </p>
      ) : posts.length === 0 ? (
        <div className="flex flex-col items-center px-8 pt-12 text-center">
          <IconTile icon={feedIcon(slug)} color={color} on size={64} />
          <p className="mt-4 text-sm font-semibold text-white">{error || `No ${label} posts yet`}</p>
          <p className="mt-1 text-xs" style={{ color: MUTED }}>
            Follow @{slug} on bChatX for what's next.
          </p>
          <button
            onClick={openBchatx}
            className="mt-4 rounded-full px-4 py-2 text-sm font-bold"
            style={{ background: color, color: '#0b0c0e' }}
          >
            Open in bChatX
          </button>
        </div>
      ) : (
        <>
          <div className="h-3" />
          {posts.map((p) => (
            <PostCard key={p.id} p={p} color={color} />
          ))}
          {next && (
            <button
              onClick={() => void load(next)}
              disabled={busy}
              className="mx-auto mt-1 rounded-full px-4 py-2 text-xs font-semibold"
              style={{ color, border: `1px solid ${color}` }}
            >
              {busy ? 'Loading…' : 'More'}
            </button>
          )}
          <button onClick={openBchatx} className="mx-auto mt-3 text-xs" style={{ color: MUTED }}>
            Open @{slug} in bChatX
          </button>
        </>
      )}
    </div>
  );
};
