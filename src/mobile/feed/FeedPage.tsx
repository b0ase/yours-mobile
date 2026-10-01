import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  Coins,
  Flag,
  Heart,
  ImagePlus,
  MessageCircle,
  MoreHorizontal,
  PenLine,
  RefreshCw,
  UserCheck,
  UserPlus,
  VolumeX,
  WifiOff,
  X,
} from 'lucide-react';
import { sendBsv } from '@1sat/actions';
import { TopNav } from '../../components/TopNav';
import { useServiceContext } from '../../hooks/useServiceContext';
import { resolveImageUrl, useIdentity } from '../../hooks/useIdentity';
import { useSnackbar } from '../../hooks/useSnackbar';
import { getErrorMessage } from '../../utils/tools';
import { onSafetyChange, refreshSafety, reportItem, safety } from '../market/safety';
import {
  buildFollowScript,
  buildLikeScript,
  buildPostScript,
  estimatePostFee,
  feedTimeLabel,
  MAX_INLINE_IMAGE_BYTES,
  MAX_POST_CHARS,
  shortAddress,
  validatePost,
  type Author,
  type FeedPost,
  type PostImage,
} from './post';
import { fetchByAddress, fetchByBap, fetchFollowing, fetchRecent, fetchReplies, publish } from './feedApi';
import {
  addLiked,
  addMute,
  isFollowing,
  loadFollows,
  loadLiked,
  loadMutes,
  toggleFollow,
  visiblePosts,
  type Follow,
} from './store';

/**
 * Chat → Feed: a Twitter-style timeline over Bitcoin Schema posts (B + MAP + AIP), read from
 * the bmap API (feedApi.ts) and written by this wallet's BAP identity key. Following / For you,
 * compose (text + optional inline image), like, reply, follow, tip, profile, report, mute.
 * Every post and image passes the market safety filter; images stay blurred until tapped.
 */
const GOLD = '#FFD24D';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';
const RED = '#F97066';
const TIP_PRESETS = [1_000, 10_000, 100_000];
// AIP adds prefix + algorithm + address + 65-byte signature.
const AIP_BYTES = 140;

type Tab = 'following' | 'foryou';

const useOnline = () => {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
};

const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

const Avatar = ({ author, size = 40 }: { author: Pick<Author, 'name' | 'avatar' | 'address'>; size?: number }) => {
  const [broken, setBroken] = useState(false);
  const h = hue(author.address || author.name);
  if (author.avatar && !broken)
    return (
      <img
        src={author.avatar}
        alt=""
        onError={() => setBroken(true)}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size, border: `1px solid ${LINE}` }}
      />
    );
  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0 font-bold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        color: `hsl(${h} 70% 82%)`,
        background: `linear-gradient(145deg, hsl(${h} 35% 26%), hsl(${h} 30% 14%))`,
      }}
    >
      {(author.name || '?').replace(/^\$/, '').charAt(0).toUpperCase()}
    </div>
  );
};

const Sheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) =>
  createPortal(
    <div className="fixed inset-0 z-[60] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-3xl p-4 pb-10 max-h-[85vh] overflow-y-auto"
        style={{ background: '#0b0c0e', borderTop: `1px solid ${LINE}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-white">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={18} color={MUTED} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );

/** Full-screen layer inside the tab (profile, thread). */
const Layer = ({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) =>
  createPortal(
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: '#010101' }}>
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', borderBottom: `1px solid ${LINE}` }}>
        <button onClick={onBack} aria-label="Back" className="p-2">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white truncate">{title}</span>
      </div>
      <div className="flex-1 overflow-y-auto pb-24">{children}</div>
    </div>,
    document.body,
  );

const PostImageView = ({ src }: { src: string }) => {
  const [shown, setShown] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        setShown(true);
      }}
      className="relative mt-2 block w-full overflow-hidden rounded-2xl"
      style={{ border: `1px solid ${LINE}` }}
    >
      <img src={src} alt="" loading="lazy" className="w-full max-h-[420px] object-cover" style={shown ? undefined : { filter: 'blur(24px)' }} />
      {!shown && (
        <span className="absolute inset-0 flex items-center justify-center text-xs font-bold" style={{ color: 'white' }}>
          Tap to show image
        </span>
      )}
    </button>
  );
};

type PostActions = {
  liked: Set<string>;
  onLike: (p: FeedPost) => void;
  onReply: (p: FeedPost) => void;
  onTip: (p: FeedPost) => void;
  onOpen: (p: FeedPost) => void;
  onAuthor: (a: Author) => void;
  onMore: (p: FeedPost) => void;
};

const PostCard = ({ post, a }: { post: FeedPost; a: PostActions }) => {
  const liked = a.liked.has(post.txid);
  return (
    <article className="flex gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${LINE}` }} onClick={() => a.onOpen(post)}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          a.onAuthor(post.author);
        }}
        aria-label={`${post.author.name} profile`}
      >
        <Avatar author={post.author} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1 min-w-0">
          <span className="text-[14px] font-bold text-white truncate">{post.author.name}</span>
          <span className="text-[12px] truncate" style={{ color: MUTED }}>
            {post.app ? `· ${post.app}` : ''} · {feedTimeLabel(post.at)}
          </span>
          <button
            className="ml-auto p-1 -mr-1"
            aria-label="More"
            onClick={(e) => {
              e.stopPropagation();
              a.onMore(post);
            }}
          >
            <MoreHorizontal size={16} color={MUTED} />
          </button>
        </div>
        {post.replyTo && (
          <div className="text-[11px]" style={{ color: MUTED }}>
            Replying to a post
          </div>
        )}
        {post.text && <p className="text-[14px] text-white whitespace-pre-wrap break-words mt-[2px]">{post.text}</p>}
        {post.images.slice(0, 1).map((img) => (
          <PostImageView key={img.src.slice(0, 80)} src={img.src} />
        ))}
        <div className="flex items-center gap-6 mt-2" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => a.onReply(post)} className="flex items-center gap-1 text-[12px]" style={{ color: MUTED }} aria-label="Reply">
            <MessageCircle size={16} /> {post.replies || ''}
          </button>
          <button
            onClick={() => !liked && a.onLike(post)}
            className="flex items-center gap-1 text-[12px]"
            style={{ color: liked ? GOLD : MUTED }}
            aria-label="Like"
          >
            <Heart size={16} fill={liked ? GOLD : 'none'} /> {post.likes + (liked ? 1 : 0) || ''}
          </button>
          <button onClick={() => a.onTip(post)} className="flex items-center gap-1 text-[12px]" style={{ color: MUTED }} aria-label="Tip">
            <Coins size={16} /> Tip
          </button>
        </div>
      </div>
    </article>
  );
};

const PostList = ({ posts, a, empty }: { posts: FeedPost[] | null; a: PostActions; empty: ReactNode }) => {
  if (posts === null)
    return (
      <div className="text-center text-xs pt-10" style={{ color: MUTED }}>
        Loading…
      </div>
    );
  if (!posts.length) return <>{empty}</>;
  return (
    <div>
      {posts.map((p) => (
        <PostCard key={p.txid} post={p} a={a} />
      ))}
    </div>
  );
};

// ── composer ──────────────────────────────────────────────────────────────────

const shrinkImage = async (file: File): Promise<PostImage> => {
  const bmp = await createImageBitmap(file);
  for (const [edge, q] of [
    [1280, 0.82],
    [1024, 0.75],
    [800, 0.7],
    [640, 0.6],
  ] as const) {
    const scale = Math.min(1, edge / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= MAX_INLINE_IMAGE_BYTES) {
      return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), mime: 'image/jpeg', filename: 'image.jpg' };
    }
  }
  throw new Error('That image is too large to post, even after shrinking.');
};

const Composer = ({
  replyTo,
  onClose,
  onPosted,
}: {
  replyTo: FeedPost | null;
  onClose: () => void;
  onPosted: (txid: string) => void;
}) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const [text, setText] = useState('');
  const [image, setImage] = useState<PostImage | null>(null);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const input = { text, image, replyTo: replyTo?.txid ?? null };
  const invalid = validatePost(input);
  const fee = useMemo(() => {
    if (invalid) return null;
    try {
      return estimatePostFee(buildPostScript(input).toBinary().length + AIP_BYTES, chromeStorageService.getCustomFeeRate());
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, image, invalid]);

  const pick = async (file?: File) => {
    setError('');
    if (!file) return;
    if (!/^image\//.test(file.type)) return setError('Pick an image.');
    try {
      const img = await shrinkImage(file);
      setImage(img);
      setPreview(URL.createObjectURL(new Blob([new Uint8Array(img.bytes)], { type: img.mime })));
    } catch (e) {
      setError(getErrorMessage(e instanceof Error ? e.message : String(e)));
    }
  };

  const send = async () => {
    setError('');
    if (invalid) return setError(invalid);
    if (safety().check({ texts: [text] }).blocked) return setError("This can't be posted from bWallet.");
    setBusy(true);
    try {
      const tags = ['app:bWallet', 'type:post', ...(replyTo ? [`context:tx`, `contextValue:${replyTo.txid}`] : [])];
      const txid = await publish(apiContext, buildPostScript(input), replyTo ? 'Feed reply' : 'Feed post', tags);
      onPosted(txid);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={replyTo ? `Reply to ${replyTo.author.name}` : 'New post'} onClose={onClose}>
      {replyTo && (
        <p className="text-xs mb-2 line-clamp-2" style={{ color: MUTED }}>
          {replyTo.text}
        </p>
      )}
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={replyTo ? 'Post your reply' : "What's happening on-chain?"}
        rows={5}
        className="w-full rounded-2xl p-3 text-[15px] text-white outline-none resize-none"
        style={{ background: PANEL, border: `1px solid ${LINE}` }}
      />
      {preview && (
        <div className="relative mt-2">
          <img src={preview} alt="" className="w-full max-h-60 object-cover rounded-2xl" />
          <button
            onClick={() => {
              setImage(null);
              setPreview('');
            }}
            className="absolute top-2 right-2 rounded-full p-1"
            style={{ background: 'rgba(0,0,0,0.7)' }}
            aria-label="Remove image"
          >
            <X size={16} color="white" />
          </button>
        </div>
      )}
      <div className="flex items-center justify-between mt-3">
        <button onClick={() => fileRef.current?.click()} className="p-2 rounded-full" aria-label="Add image">
          <ImagePlus size={20} color={GOLD} />
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
        <span className="text-[11px]" style={{ color: text.length > MAX_POST_CHARS ? RED : MUTED }}>
          {text.length}/{MAX_POST_CHARS}
          {fee != null ? ` · fee ≈ ${fee.toLocaleString()} sats` : ''}
        </span>
      </div>
      <p className="text-[11px] mt-1" style={{ color: MUTED }}>
        Posts are permanent and public on the BSV chain, signed by your identity key.
      </p>
      {error && <p className="text-xs mt-2" style={{ color: RED }}>{error}</p>}
      <button
        onClick={() => void send()}
        disabled={busy || !!invalid}
        className="mt-3 w-full rounded-2xl py-3 text-sm font-bold disabled:opacity-40"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        {busy ? 'Posting…' : replyTo ? 'Reply' : 'Post'}
      </button>
    </Sheet>
  );
};

const TipSheet = ({ post, onClose }: { post: FeedPost; onClose: () => void }) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [sats, setSats] = useState(TIP_PRESETS[1]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tip = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await sendBsv.execute(apiContext, { requests: [{ address: post.author.address, satoshis: sats }] });
      if (!res.txid || res.error) throw new Error(getErrorMessage(res.error));
      addSnackbar(`Tipped ${post.author.name} ${sats.toLocaleString()} sats`, 'success');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={`Tip ${post.author.name}`} onClose={onClose}>
      <p className="text-xs mb-3" style={{ color: MUTED }}>
        Sent in BSV to the address that signed this post ({shortAddress(post.author.address)}).
      </p>
      <div className="flex gap-2">
        {TIP_PRESETS.map((v) => (
          <button
            key={v}
            onClick={() => setSats(v)}
            className="flex-1 rounded-xl py-2 text-sm font-bold"
            style={v === sats ? { background: GOLD, color: '#1a1300' } : { background: PANEL, color: 'white', border: `1px solid ${LINE}` }}
          >
            {v.toLocaleString()}
          </button>
        ))}
      </div>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        value={sats}
        onChange={(e) => setSats(Math.max(1, Math.floor(Number(e.target.value) || 0)))}
        className="mt-2 w-full rounded-xl px-3 py-2 text-sm text-white outline-none"
        style={{ background: PANEL, border: `1px solid ${LINE}` }}
        aria-label="Satoshis"
      />
      {error && <p className="text-xs mt-2" style={{ color: RED }}>{error}</p>}
      <button
        onClick={() => void tip()}
        disabled={busy || !post.author.address || sats < 1}
        className="mt-3 w-full rounded-2xl py-3 text-sm font-bold disabled:opacity-40"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        {busy ? 'Sending…' : `Send ${sats.toLocaleString()} sats`}
      </button>
    </Sheet>
  );
};

// ── page ────────────────────────────────────────────────────────────────────

export const FeedPage = ({ header }: { header: ReactNode }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const identity = useIdentity(apiContext, chromeStorageService);
  const online = useOnline();
  const [tab, setTab] = useState<Tab>(() => (loadFollows().length ? 'following' : 'foryou'));
  const [follows, setFollows] = useState<Follow[]>(loadFollows);
  const [mutes, setMutes] = useState<string[]>(loadMutes);
  const [liked, setLiked] = useState<string[]>(loadLiked);
  const [raw, setRaw] = useState<Record<Tab, FeedPost[] | null>>({ following: null, foryou: null });
  const [error, setError] = useState('');
  const [safetyTick, setSafetyTick] = useState(0);
  const [composing, setComposing] = useState<{ replyTo: FeedPost | null } | null>(null);
  const [tipping, setTipping] = useState<FeedPost | null>(null);
  const [more, setMore] = useState<FeedPost | null>(null);
  const [profile, setProfile] = useState<Author | 'me' | null>(null);
  const [thread, setThread] = useState<FeedPost | null>(null);

  useEffect(() => {
    void refreshSafety();
    return onSafetyChange(() => setSafetyTick((t) => t + 1));
  }, []);

  const load = useCallback(
    async (which: Tab) => {
      setError('');
      try {
        const posts = which === 'foryou' ? await fetchRecent() : await fetchFollowing(follows);
        setRaw((r) => ({ ...r, [which]: posts }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setRaw((r) => ({ ...r, [which]: r[which] ?? [] }));
      }
    },
    [follows],
  );
  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shown = useMemo(() => (raw[tab] ? visiblePosts(raw[tab]!, mutes) : null), [raw, tab, mutes, safetyTick]);
  const likedSet = useMemo(() => new Set(liked), [liked]);

  const like = async (p: FeedPost) => {
    try {
      await publish(apiContext, buildLikeScript(p.txid), 'Feed like', ['app:bWallet', 'type:like', `tx:${p.txid}`]);
      setLiked((l) => addLiked(l, p.txid));
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const follow = async (a: Author) => {
    const on = isFollowing(follows, a);
    if (a.bapId) {
      try {
        await publish(apiContext, buildFollowScript(a.bapId, undefined, on), on ? 'Feed unfollow' : 'Feed follow', [
          'app:bWallet',
          `type:${on ? 'unfollow' : 'follow'}`,
          `bapId:${a.bapId}`,
        ]);
      } catch (e) {
        return addSnackbar(e instanceof Error ? e.message : String(e), 'error');
      }
    }
    // Authors without a BAP identity can only be followed on this device.
    setFollows((f) => toggleFollow(f, { bapId: a.bapId, address: a.address, name: a.name }));
    addSnackbar(on ? `Unfollowed ${a.name}` : `Following ${a.name}`, 'success');
  };

  const mute = (p: FeedPost) => {
    setMutes((m) => addMute(m, p.author.address, p.author.bapId));
    setMore(null);
    addSnackbar(`Muted ${p.author.name}`, 'info');
  };
  const report = (p: FeedPost) => {
    void reportItem({ outpoint: p.txid, name: p.author.name, reason: 'feed-post' });
    setMore(null);
    addSnackbar('Reported. It is hidden on this device.', 'info');
  };

  const actions: PostActions = {
    liked: likedSet,
    onLike: (p) => void like(p),
    onReply: (p) => setComposing({ replyTo: p }),
    onTip: setTipping,
    onOpen: setThread,
    onAuthor: setProfile,
    onMore: setMore,
  };

  const me: Author = {
    address: '',
    bapId: identity.bapId,
    name: identity.profile.name || 'You',
    avatar: identity.profile.image ? resolveImageUrl(identity.profile.image, apiContext) : null,
  };

  return (
    <div className="flex w-full flex-col items-center overflow-x-hidden overflow-y-auto pb-36" style={{ height: '100%', background: '#010101' }}>
      <TopNav />
      <div className="w-full pt-16 flex flex-col">
        <div className="flex items-center justify-between px-4 pb-2">
          {header}
          <div className="flex items-center gap-1">
            <button onClick={() => setProfile('me')} aria-label="My profile" className="p-1">
              <Avatar author={me} size={28} />
            </button>
            <button onClick={() => void load(tab)} aria-label="Refresh" className="p-2 rounded-full active:opacity-60">
              <RefreshCw size={18} color={MUTED} />
            </button>
          </div>
        </div>

        <div className="flex px-4" style={{ borderBottom: `1px solid ${LINE}` }}>
          {(['following', 'foryou'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="flex-1 py-2 text-[14px] font-bold"
              style={{ color: tab === t ? 'white' : MUTED, borderBottom: `2px solid ${tab === t ? GOLD : 'transparent'}` }}
            >
              {t === 'following' ? 'Following' : 'For you'}
            </button>
          ))}
        </div>

        {!online && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs" style={{ background: '#1a1408', color: '#e6c76a' }}>
            <WifiOff size={14} /> You're offline.
          </div>
        )}
        {error && (
          <div className="text-center text-xs pt-4" style={{ color: RED }}>
            {error}
          </div>
        )}

        <PostList
          posts={shown}
          a={actions}
          empty={
            <div className="px-8 pt-14 text-center">
              <p className="text-sm text-white font-semibold">{tab === 'following' ? 'Nobody followed yet' : 'Nothing here yet'}</p>
              <p className="text-xs mt-1" style={{ color: MUTED }}>
                {tab === 'following' ? 'Tap a name in For you and follow them.' : 'Pull refresh in a moment.'}
              </p>
            </div>
          }
        />
      </div>

      <button
        onClick={() => setComposing({ replyTo: null })}
        aria-label="New post"
        className="fixed right-5 z-40 h-14 w-14 rounded-full flex items-center justify-center shadow-lg"
        style={{ bottom: 'calc(env(safe-area-inset-bottom) + 96px)', background: GOLD }}
      >
        <PenLine size={22} color="#1a1300" />
      </button>

      {composing && (
        <Composer
          replyTo={composing.replyTo}
          onClose={() => setComposing(null)}
          onPosted={(txid) => {
            setComposing(null);
            addSnackbar(`Posted · ${txid.slice(0, 8)}…`, 'success');
            setTimeout(() => void load(tab), 2500);
          }}
        />
      )}
      {tipping && <TipSheet post={tipping} onClose={() => setTipping(null)} />}
      {more && (
        <Sheet title={more.author.name} onClose={() => setMore(null)}>
          <button onClick={() => mute(more)} className="w-full flex items-center gap-3 py-3 text-sm text-white">
            <VolumeX size={18} color={MUTED} /> Mute {more.author.name}
          </button>
          <button onClick={() => report(more)} className="w-full flex items-center gap-3 py-3 text-sm" style={{ color: RED }}>
            <Flag size={18} /> Report post
          </button>
        </Sheet>
      )}
      {profile && (
        <ProfileView
          author={profile === 'me' ? me : profile}
          isMe={profile === 'me'}
          following={profile !== 'me' && isFollowing(follows, profile)}
          onFollow={() => profile !== 'me' && void follow(profile)}
          onBack={() => setProfile(null)}
          actions={actions}
          mutes={mutes}
          safetyTick={safetyTick}
        />
      )}
      {thread && (
        <ThreadView post={thread} onBack={() => setThread(null)} actions={actions} mutes={mutes} safetyTick={safetyTick} />
      )}
    </div>
  );
};

const ProfileView = ({
  author,
  isMe,
  following,
  onFollow,
  onBack,
  actions,
  mutes,
  safetyTick,
}: {
  author: Author;
  isMe: boolean;
  following: boolean;
  onFollow: () => void;
  onBack: () => void;
  actions: PostActions;
  mutes: string[];
  safetyTick: number;
}) => {
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setPosts(null);
    const q = author.bapId ? fetchByBap(author.bapId) : author.address ? fetchByAddress(author.address) : Promise.resolve([]);
    q.then(setPosts).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
      setPosts([]);
    });
  }, [author.bapId, author.address]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shown = useMemo(() => (posts ? visiblePosts(posts, isMe ? [] : mutes) : null), [posts, mutes, isMe, safetyTick]);
  return (
    <Layer title={author.name} onBack={onBack}>
      <div className="flex flex-col items-center px-6 pt-6 pb-4 text-center" style={{ borderBottom: `1px solid ${LINE}` }}>
        <Avatar author={author} size={80} />
        <h2 className="mt-3 text-lg font-bold text-white">{author.name}</h2>
        <p className="text-[11px] mt-1 break-all" style={{ color: MUTED }}>
          {author.bapId ? `BAP ${author.bapId}` : author.address ? shortAddress(author.address) : ''}
        </p>
        {isMe && !author.bapId && (
          <p className="text-xs mt-2" style={{ color: MUTED }}>
            Publish your identity in Settings to post.
          </p>
        )}
        {!isMe && (
          <button
            onClick={onFollow}
            className="mt-3 rounded-2xl px-5 py-2 text-sm font-bold inline-flex items-center gap-2"
            style={following ? { background: PANEL, color: 'white', border: `1px solid ${LINE}` } : { background: GOLD, color: '#1a1300' }}
          >
            {following ? <UserCheck size={15} /> : <UserPlus size={15} />} {following ? 'Following' : 'Follow'}
          </button>
        )}
      </div>
      {error && <p className="text-center text-xs pt-4" style={{ color: RED }}>{error}</p>}
      <PostList
        posts={shown}
        a={{ ...actions, onAuthor: () => undefined }}
        empty={
          <p className="text-center text-xs pt-10" style={{ color: MUTED }}>
            No posts yet.
          </p>
        }
      />
    </Layer>
  );
};

const ThreadView = ({
  post,
  onBack,
  actions,
  mutes,
  safetyTick,
}: {
  post: FeedPost;
  onBack: () => void;
  actions: PostActions;
  mutes: string[];
  safetyTick: number;
}) => {
  const [replies, setReplies] = useState<FeedPost[] | null>(null);
  useEffect(() => {
    setReplies(null);
    fetchReplies(post.txid)
      .then((r) => setReplies(r.sort((a, b) => a.at - b.at)))
      .catch(() => setReplies([]));
  }, [post.txid]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shown = useMemo(() => (replies ? visiblePosts(replies, mutes) : null), [replies, mutes, safetyTick]);
  return (
    <Layer title="Post" onBack={onBack}>
      <PostCard
        post={post}
        a={{
          ...actions,
          onOpen: () => undefined,
          onAuthor: (a) => {
            onBack();
            actions.onAuthor(a);
          },
        }}
      />
      <PostList
        posts={shown}
        a={{ ...actions, onOpen: () => undefined }}
        empty={
          <p className="text-center text-xs pt-8" style={{ color: MUTED }}>
            No replies yet.
          </p>
        }
      />
    </Layer>
  );
};
