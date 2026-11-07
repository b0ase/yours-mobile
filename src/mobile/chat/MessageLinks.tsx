import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { ExternalLink, Lock } from 'lucide-react';
import { IS_TAURI, openExternal } from '../desktop/ipc';
import { VideoEmbed } from '../feed/VideoEmbed';
import type { BchatClient } from './api';
import { loadLinkCard, type LinkCardData, type PreviewPlan } from './linkify';
import type { GiphyGif } from './giphyLink';

/**
 * Links in chat bubbles (rules in chat/linkify.ts):
 *  - ChatLink: a URL as a real link, opened outside the wallet. On the web and in the extension a new tab; in the phone
 *    apps the system browser (the WebView hands target=_blank to Safari / the Android browser); on Desktop the default
 *    browser. Always rel="noopener noreferrer", so the page never gets a handle on the wallet or learns the room.
 *  - MessagePreview: under the first link, the GIF itself for a GIPHY link, a click-to-play player for a video, else
 *    the Open Graph card from bit-sign's unfurl. In an encrypted room nothing is fetched: a GIF or a video waits for a
 *    tap, and other links get no card.
 */
const GOLD = 'var(--bw-accent-hi)';
const LINE = '#1f2127';
const MUTED = '#8a8f98';

const onLink = (href: string) => (e: MouseEvent) => {
  // The bubble's own tap (reactions) must not fire, and Desktop's webview opens no windows of its own.
  e.stopPropagation();
  if (IS_TAURI) {
    e.preventDefault();
    void openExternal(href).catch(() => undefined);
  }
};

/** One link in a message. `mine`: on the gold bubble, so dark ink. */
export const ChatLink = ({ href, text, mine }: { href: string; text: string; mine: boolean }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer nofollow"
    onClick={onLink(href)}
    className="underline underline-offset-2"
    style={{ color: mine ? '#3d2a00' : GOLD }}
  >
    {text}
  </a>
);

/** The preview under a message's first link (or nothing), from `previewPlan(body, { encrypted })`. */
export const MessagePreview = ({
  plan,
  encrypted,
  client,
  onGifError,
}: {
  plan: PreviewPlan;
  encrypted: boolean;
  client: Pick<BchatClient, 'unfurl'>;
  /** The GIF would not load (a GIF-only message then shows its link). */
  onGifError?: () => void;
}) => {
  if (plan.kind === 'gif')
    return <GifView gif={plan.gif} sealed={plan.sealed} link={!plan.only} onError={onGifError} />;
  if (plan.kind === 'video')
    return plan.sealed ? (
      <TapToShow what="Video">
        <VideoEmbed video={plan.video} compact />
      </TapToShow>
    ) : (
      <VideoEmbed video={plan.video} compact />
    );
  if (plan.kind === 'card') return <LinkCard url={plan.url} encrypted={encrypted} client={client} />;
  return null;
};

/** Encrypted room: nothing loads (no GIPHY, no YouTube thumbnail) until the viewer asks. */
const TapToShow = ({ what, children }: { what: 'GIF' | 'Video'; children: ReactNode }) => {
  const [shown, setShown] = useState(false);
  if (shown) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setShown(true);
      }}
      className="mt-2 flex w-[min(14rem,100%)] items-center gap-2 rounded-xl px-3 py-3 text-left"
      style={{ background: 'rgba(0,0,0,0.3)', border: `1px solid ${LINE}` }}
      aria-label={`Show ${what}`}
    >
      <Lock size={14} color={MUTED} />
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold">{what} · tap to show</span>
        <span className="block text-[11px] opacity-70">Encrypted chat: nothing loads until you tap</span>
      </span>
    </button>
  );
};

/** A GIPHY GIF, drawn from i.giphy.com with no referrer. A GIF that fails draws nothing (the link stays in the text). */
export const GifView = ({
  gif,
  sealed = false,
  link = true,
  onError,
}: {
  gif: GiphyGif;
  sealed?: boolean;
  link?: boolean;
  onError?: () => void;
}) => {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const img = (
    <img
      src={gif.src}
      alt="GIF"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        setFailed(true);
        onError?.();
      }}
      className="block h-auto w-auto max-w-full rounded-[14px] object-contain"
      style={{ maxHeight: 260, minHeight: 80, minWidth: 120, background: 'rgba(255,255,255,0.04)' }}
    />
  );
  const view = link ? (
    <a
      href={gif.page}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={onLink(gif.page)}
      aria-label="GIF on GIPHY"
      className="block"
    >
      {img}
    </a>
  ) : (
    img
  );
  const box = <div className="mt-1 max-w-[min(280px,100%)]">{view}</div>;
  return sealed ? <TapToShow what="GIF">{box}</TapToShow> : box;
};

/** The Open Graph card (bit-sign unfurl). Renders nothing until it loads, and nothing when there is no card. */
export const LinkCard = ({
  url,
  encrypted,
  client,
}: {
  url: string;
  encrypted: boolean;
  client: Pick<BchatClient, 'unfurl'>;
}) => {
  const [card, setCard] = useState<LinkCardData | null>(null);
  useEffect(() => {
    let live = true;
    void loadLinkCard(url, { encrypted }, (u) => client.unfurl(u)).then((c) => live && setCard(c));
    return () => {
      live = false;
    };
  }, [url, encrypted, client]);
  return card ? <LinkCardView card={card} /> : null;
};

/** The card itself (kept apart so a preview can be drawn from fixed data). */
export const LinkCardView = ({ card }: { card: LinkCardData }) => {
  const [imgOk, setImgOk] = useState(true);
  const [iconOk, setIconOk] = useState(true);
  return (
    <a
      href={card.href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={onLink(card.href)}
      className="bw-link-card mt-2 block w-[min(18rem,100%)] overflow-hidden rounded-xl text-left no-underline"
      style={{ background: 'rgba(0,0,0,0.35)', border: `1px solid ${LINE}`, color: '#f2f2f2' }}
    >
      {card.image && imgOk && (
        <img
          src={card.image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImgOk(false)}
          className="block w-full object-cover"
          style={{ aspectRatio: '1200 / 630', background: '#000' }}
        />
      )}
      <span className="block px-3 py-2">
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider" style={{ color: MUTED }}>
          {card.favicon && iconOk ? (
            <img
              src={card.favicon}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setIconOk(false)}
              className="h-3.5 w-3.5 shrink-0 rounded-sm"
            />
          ) : (
            <ExternalLink size={11} />
          )}
          <span className="truncate">{card.site}</span>
        </span>
        {card.title && (
          <span className="mt-0.5 block text-[13px] font-semibold leading-snug line-clamp-2">{card.title}</span>
        )}
        {card.description && (
          <span className="mt-0.5 block text-[12px] leading-snug line-clamp-2" style={{ color: '#b9bcc4' }}>
            {card.description}
          </span>
        )}
      </span>
    </a>
  );
};
