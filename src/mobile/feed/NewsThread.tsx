/**
 * bNews in the Feed: story cards (swipe left to close) and the story thread (headline, link
 * out, and the on-chain discussion: bChat posts that link the story). See bnews.ts.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ExternalLink, MessageCircle, PenLine, Undo2 } from 'lucide-react';
import { useBackClose } from '../backStack';
import { openDappBrowser } from '../dappBrowser';
import { readListCache, writeListCache } from '../ui/listCache';
import { PullToRefresh } from '../ui/PullToRefresh';
import { fetchBchatRecent } from './feedApi';
import { feedTimeLabel, type FeedPost } from './post';
import {
  discussionFor,
  fetchNews,
  hideStory,
  loadHidden,
  swipeCloses,
  unhideStory,
  visibleNews,
  type NewsItem,
} from './bnews';

const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';

const CACHE_KEY = 'feed:bnews';

const NewsCard = ({
  item,
  replies,
  onOpen,
  onClose,
}: {
  item: NewsItem;
  replies: number;
  onOpen: () => void;
  onClose: () => void;
}) => {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  return (
    <div data-news-card className="relative overflow-hidden" style={{ borderBottom: `1px solid ${LINE}` }}>
      <div
        aria-hidden
        className="absolute inset-0 flex items-center justify-end pr-5 text-xs font-semibold"
        style={{ background: '#1a1408', color: GOLD, opacity: dx < 0 ? 1 : 0 }}
      >
        Close
      </div>
      <button
        className="relative w-full text-left flex gap-3 px-4 py-3"
        style={{
          background: 'var(--bw-bg)',
          transform: `translateX(${dx}px)`,
          transition: start.current ? 'none' : 'transform 160ms ease-out',
        }}
        onTouchStart={(e) => {
          start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          moved.current = false;
        }}
        onTouchMove={(e) => {
          if (!start.current) return;
          const x = e.touches[0].clientX - start.current.x;
          const y = e.touches[0].clientY - start.current.y;
          if (Math.abs(x) > 8 && Math.abs(x) > Math.abs(y)) moved.current = true;
          if (moved.current) setDx(Math.min(0, x));
        }}
        onTouchEnd={(e) => {
          const s = start.current;
          start.current = null;
          if (!s) return;
          const t = e.changedTouches[0];
          if (swipeCloses(t.clientX - s.x, t.clientY - s.y)) {
            setDx(-window.innerWidth);
            setTimeout(onClose, 160);
          } else setDx(0);
        }}
        onClick={() => {
          if (!moved.current) onOpen();
          moved.current = false;
        }}
      >
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>
            {item.sourceLabel}
            {item.at ? ` · ${feedTimeLabel(item.at)}` : ''}
          </p>
          <p className="text-[15px] font-semibold text-white leading-snug mt-0.5 line-clamp-3">{item.title}</p>
          <p className="flex items-center gap-1 text-[12px] mt-1.5" style={{ color: replies ? GOLD : MUTED }}>
            <MessageCircle size={13} />
            {replies ? `${replies} in thread` : 'Discuss'}
          </p>
        </div>
        {item.image && (
          <img
            src={item.image}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="h-[72px] w-[72px] shrink-0 rounded-xl object-cover"
            style={{ background: PANEL }}
          />
        )}
      </button>
    </div>
  );
};

/** The bNews list: headlines from the news sources, newest first, minus the ones closed here. */
export const NewsList = ({ posts, onOpen }: { posts: FeedPost[]; onOpen: (s: NewsItem) => void }) => {
  const [items, setItems] = useState<NewsItem[] | null>(() => readListCache<NewsItem>(CACHE_KEY));
  const [hidden, setHidden] = useState<string[]>(() => loadHidden());
  const [undo, setUndo] = useState<NewsItem | null>(null);
  const load = async () => {
    const fresh = await fetchNews().catch(() => [] as NewsItem[]);
    if (fresh.length) writeListCache(CACHE_KEY, fresh, 100);
    setItems((cur) => (fresh.length ? fresh : (cur ?? [])));
  };
  useEffect(() => {
    void load();
  }, []);
  const shown = useMemo(() => (items ? visibleNews(items, hidden) : null), [items, hidden]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of shown ?? []) m.set(it.id, discussionFor(it.id, posts).length);
    return m;
  }, [shown, posts]);

  return (
    <div>
      <PullToRefresh onRefresh={load} />
      {shown === null && (
        <div className="text-center text-xs pt-10" style={{ color: MUTED }}>
          Loading…
        </div>
      )}
      {shown && !shown.length && (
        <div className="px-8 pt-14 text-center">
          <p className="text-sm text-white font-semibold">No news right now</p>
          <p className="text-xs mt-1" style={{ color: MUTED }}>
            Pull to refresh in a moment.
          </p>
        </div>
      )}
      {shown?.map((it) => (
        <NewsCard
          key={it.id}
          item={it}
          replies={counts.get(it.id) ?? 0}
          onOpen={() => onOpen(it)}
          onClose={() => {
            setHidden((h) => hideStory(h, it.id));
            setUndo(it);
          }}
        />
      ))}
      {shown && shown.length > 0 && (
        <p className="text-center text-[11px] py-4 px-8" style={{ color: MUTED }}>
          Swipe a story left to close it. Headlines link to the publisher.
        </p>
      )}
      {undo && (
        <div
          className="fixed left-4 right-4 z-40 flex items-center gap-3 rounded-2xl px-4 py-3 text-sm text-white"
          style={{
            bottom: 'calc(env(safe-area-inset-bottom) + 164px)',
            background: PANEL,
            border: `1px solid ${LINE}`,
          }}
        >
          <span className="flex-1 truncate">Story closed</span>
          <button
            className="flex items-center gap-1 font-semibold"
            style={{ color: GOLD }}
            onClick={() => {
              setHidden((h) => unhideStory(h, undo.id));
              setUndo(null);
            }}
          >
            <Undo2 size={14} /> Undo
          </button>
          <button className="text-xs" style={{ color: MUTED }} onClick={() => setUndo(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
};

/** A story's thread: headline, read on the publisher's site, and the on-chain discussion. */
export const NewsThread = ({
  story,
  known,
  postedTick,
  onBack,
  onDiscuss,
  renderPosts,
}: {
  story: NewsItem;
  /** Posts the Feed has already loaded. */
  known: FeedPost[];
  /** Bumps after the person posts, to re-read the discussion. */
  postedTick: number;
  onBack: () => void;
  onDiscuss: () => void;
  renderPosts: (posts: FeedPost[] | null) => ReactNode;
}) => {
  useBackClose(true, onBack);
  const [recent, setRecent] = useState<FeedPost[] | null>(null);
  const load = async () => {
    // bChat's own indexer: the newest bChat posts, where discussion of today's news lands.
    const pages = await Promise.all([1, 2].map((p) => fetchBchatRecent(p, 100).catch(() => [] as FeedPost[])));
    setRecent(pages.flat());
  };
  useEffect(() => {
    void load();
    if (postedTick) {
      const t = setTimeout(() => void load(), 2500);
      return () => clearTimeout(t);
    }
  }, [story.id, postedTick]);
  const posts = useMemo(
    () => (recent === null && !known.length ? null : discussionFor(story.id, [...known, ...(recent ?? [])])),
    [story.id, known, recent],
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <div
        className="flex items-center gap-2 px-2 pb-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', borderBottom: `1px solid ${LINE}` }}
      >
        <button onClick={onBack} aria-label="Back" className="p-2">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white truncate">bNews thread</span>
      </div>
      <div className="flex-1 overflow-y-auto pb-24">
        <PullToRefresh onRefresh={load} />
        <div className="px-4 pt-4 pb-3" style={{ borderBottom: `1px solid ${LINE}` }}>
          {story.image && (
            <img
              src={story.image}
              alt=""
              referrerPolicy="no-referrer"
              className="w-full max-h-56 rounded-2xl object-cover mb-3"
              style={{ background: PANEL }}
            />
          )}
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>
            {story.sourceLabel}
            {story.at ? ` · ${feedTimeLabel(story.at)}` : ''}
          </p>
          <h2 className="text-[19px] font-bold text-white leading-snug mt-1">{story.title}</h2>
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => void openDappBrowser(story.link)}
              className="flex-1 flex items-center justify-center gap-2 rounded-full py-2.5 text-sm font-semibold text-white"
              style={{ background: PANEL, border: `1px solid ${LINE}` }}
            >
              <ExternalLink size={15} /> Read on {story.sourceLabel}
            </button>
            <button
              onClick={onDiscuss}
              className="flex-1 flex items-center justify-center gap-2 rounded-full py-2.5 text-sm font-semibold"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              <PenLine size={15} /> Discuss
            </button>
          </div>
        </div>
        <p className="px-4 pt-3 pb-1 text-[12px] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>
          Discussion
        </p>
        {renderPosts(posts)}
      </div>
    </div>,
    document.body,
  );
};
