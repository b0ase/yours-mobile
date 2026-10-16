import { hueTurnFor, shownHueFor } from './cardHue';
import { setBavatarShimmer, useBavatarShimmer } from '../names/bavatarShimmer';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ImagePlus, X } from 'lucide-react';
import { CardNftGrid } from './CardNftGrid';
import type { CardDesign } from './cardDesign';
import type { AccentId } from '../theme/accents';
import { CARD_ART_ENABLED } from './cardArtLoader';
import { ArtPanel, CollectionsPanel, PatternsPanel, SubscribePanel } from './CardDesignPanels';

type DesignTab = 'pictures' | 'nfts' | 'patterns' | 'art' | 'collections' | 'subscribe';
/** Tabs: Art, Collections and the Subscribe mock are bWalletX only (never in store builds). */
const DESIGN_TABS: readonly { id: DesignTab; label: string }[] = [
  { id: 'pictures', label: 'My pictures' },
  { id: 'nfts', label: 'My NFTs' },
  { id: 'patterns', label: 'Patterns' },
  ...(CARD_ART_ENABLED
    ? ([
        { id: 'art', label: 'Art' },
        { id: 'collections', label: 'Collections' },
        // 'Subscribe (demo)' hidden for release (mock: nothing is paid).
      ] as const)
    : []),
];
import { CardFramePicker } from './CardFramePicker';
import type { MediaItem } from '../media/useWalletMedia';
import {
  CARD_LIBRARY_MAX,
  addPicture,
  loadCardLibrary,
  removePicture,
  saveCardLibrary,
  selectedPictureId,
  type CardPicture,
  type CardPictureSource,
} from './cardLibrary';
import {
  MIN_BRIGHTNESS,
  PLACE_MAX,
  PLACE_MIN,
  SAT_MAX,
  SAT_MIN,
  artStyle,
  clampLook,
  prepareCardImage,
  prepareCardImageFromUrl,
  type CardArtLook,
} from './cardFrontArt';

/**
 * Card designer (owner, 11 Oct 2026): opened from the sliders icon at the top right of the card BACK, so the front
 * stays uncluttered. Full screen: a large live preview of the card front (same art, shade, $handle and balance),
 * drag the preview to move the art, sliders for brightness and position. Saved per account on this device
 * (cardFrontArt.ts saveCardArtLook) as each change lands.
 * Colour and own picture (owner, 12 Oct 2026): hue, saturation and shade sliders, and "Use my picture" to put a
 * picture from this device on the front (resized here, kept on this device only); the same controls apply to it.
 */
export function CardDesigner({
  art,
  look,
  isDefault,
  handle,
  balance,
  sub,
  onChange,
  onReset,
  onClose,
  customImage,
  onImage,
  libraryKey,
  currentImage,
  title = 'Design your card',
  tabs,
  design = null,
  onDesign,
  accentId = 'gold',
}: {
  art: string;
  look: CardArtLook;
  isDefault: boolean;
  handle: string;
  balance: string;
  sub: string;
  onChange: (look: CardArtLook) => void;
  onReset: () => void;
  onClose: () => void;
  /** True while the front shows the account's own picture rather than its bAvatar art. */
  customImage: boolean;
  /** A new picture (data URI), or null to go back to the bAvatar art. Returns false when it couldn't be saved. */
  onImage: (uri: string | null) => boolean;
  /** The account's identity key: My pictures are kept per account on this device. */
  libraryKey: string;
  /** The picture now on the card (data URI), for outlining it in My pictures. */
  currentImage: string | null;
  /** Heading: "Theme" when opened as the Theme page's Design your card tab (theme/ThemeSheet.tsx). */
  title?: string;
  /** The Theme page's tab bar, shown under the heading. */
  tabs?: ReactNode;
  /** Pattern / Art / Collections / Subscribe choice (cardDesign.ts), and how to change it. */
  design?: CardDesign | null;
  onDesign?: (d: CardDesign | null) => void;
  accentId?: AccentId;
}) {
  const [tab, setTab] = useState<DesignTab>('pictures');
  const [library, setLibrary] = useState<CardPicture[]>(() => loadCardLibrary(libraryKey));
  useEffect(() => setLibrary(loadCardLibrary(libraryKey)), [libraryKey]);
  const [nftSel, setNftSel] = useState<string | null>(null);
  const [nftBusy, setNftBusy] = useState<string | null>(null);
  const selectedPic = selectedPictureId(library, currentImage);
  const applyImage = (uri: string) => {
    if (!onImage(uri)) {
      setImgErr('This device has no room left to keep that picture.');
      return false;
    }
    return true;
  };
  const [framing, setFraming] = useState<MediaItem | null>(null);
  const framingRef = useRef(false);
  framingRef.current = !!framing;
  const addToLibrary = (uri: string, src?: CardPictureSource) => {
    const saved = saveCardLibrary(libraryKey, addPicture(library, uri, undefined, src));
    if (saved) setLibrary(saved);
    if (applyImage(uri)) setNftSel(null);
  };
  const dropFromLibrary = (id: string) => {
    const saved = saveCardLibrary(libraryKey, removePicture(library, id));
    setLibrary(saved ?? []);
  };
  const pickNft = async (m: MediaItem) => {
    if (nftBusy) return;
    if (m.kind === 'video') {
      setImgErr('');
      setFraming(m);
      return;
    }
    const outpoint = m.output.outpoint;
    const url = m.url;
    setImgErr('');
    setNftBusy(outpoint);
    try {
      if (applyImage(await prepareCardImageFromUrl(url))) setNftSel(outpoint);
    } catch (err) {
      setImgErr(err instanceof Error ? err.message : 'That NFT couldn’t be used.');
    } finally {
      setNftBusy(null);
    }
  };
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [imgErr, setImgErr] = useState('');
  const drag = useRef<{ x: number; y: number; lx: number; ly: number; w: number; h: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (framingRef.current) setFraming(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shownHue = Math.round(shownHueFor(look.hue ?? 0));
  const row = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    set: (v: number) => void,
    track?: string,
  ) => (
    <label
      className={`bw-cdes-row${track ? ' has-track' : ''}`}
      style={track ? { ['--bw-track' as string]: track } : {}}
    >
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
        aria-label={label}
      />
    </label>
  );

  return createPortal(
    <div className="bw-cdes" role="dialog" aria-modal="true" aria-label="Card designer">
      <div className="bw-cdes-top">
        <b>{title}</b>
        <button ref={closeRef} type="button" className="bw-cdes-x" aria-label="Close card designer" onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      {tabs}
      <div
        className="bw-cdes-card"
        role="img"
        aria-label="Card preview. Drag to move the art."
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          drag.current = { x: e.clientX, y: e.clientY, lx: look.x, ly: look.y, w: r.width, h: r.height };
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          onChange(
            clampLook({
              ...look,
              x: d.lx + ((e.clientX - d.x) / d.w) * 100,
              y: d.ly + ((e.clientY - d.y) / d.h) * 100,
            }),
          );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <img className="bw-wcard-art" src={art} alt="" draggable={false} style={artStyle(look)} />
        <span className="bw-wcard-art-shade" aria-hidden="true" />
        <span className="bw-cdes-handle">{handle}</span>
        <span className="bw-cdes-bal">
          <b>{balance}</b>
          <small>{sub}</small>
        </span>
      </div>
      <p className="bw-cdes-hint">Drag the card to move the art</p>
      <div className="bw-cdes-controls">
        {row(
          'Hue',
          shownHue,
          0,
          360,
          1,
          (h) => onChange(clampLook({ ...look, hue: hueTurnFor(h) })),
          'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)',
        )}
        {row(
          'Saturation',
          look.saturation ?? 1,
          SAT_MIN,
          SAT_MAX,
          0.01,
          (saturation) => onChange(clampLook({ ...look, saturation })),
          `linear-gradient(90deg,hsl(${shownHue},0%,50%),hsl(${shownHue},100%,50%))`,
        )}
        {row(
          'Shade',
          look.brightness,
          MIN_BRIGHTNESS,
          1,
          0.01,
          (brightness) => onChange({ ...look, brightness }),
          `linear-gradient(90deg,#000,hsl(${shownHue},100%,50%))`,
        )}
        {row('Left / right', look.x, PLACE_MIN, PLACE_MAX, 1, (x) => onChange({ ...look, x }))}
        {row('Up / down', look.y, PLACE_MIN, PLACE_MAX, 1, (y) => onChange({ ...look, y }))}
      </div>
      <div className="bw-cdes-picture">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setImgErr('');
            try {
              addToLibrary(await prepareCardImage(f));
            } catch (err) {
              setImgErr(err instanceof Error ? err.message : 'That picture couldn’t be used.');
            }
          }}
        />
        <button type="button" className="bw-cdes-pick" onClick={() => fileRef.current?.click()}>
          <ImagePlus size={16} aria-hidden="true" /> Use my picture
        </button>
        {customImage && (
          <button type="button" className="bw-cdes-artback" onClick={() => onImage(null)}>
            Back to bAvatar art
          </button>
        )}
        {imgErr && (
          <p className="bw-cdes-imgerr" role="alert">
            {imgErr}
          </p>
        )}
        <div className="bw-cdes-seg bw-cdes-seg-wrap" role="tablist" aria-label="Picture source">
          {DESIGN_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'on' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'patterns' && onDesign ? (
          <PatternsPanel design={design} accentId={accentId} onDesign={onDesign} />
        ) : tab === 'art' && onDesign ? (
          <ArtPanel design={design} onDesign={onDesign} />
        ) : tab === 'collections' && onDesign ? (
          <CollectionsPanel design={design} onDesign={onDesign} />
        ) : tab === 'subscribe' && onDesign ? (
          <SubscribePanel design={design} onDesign={onDesign} />
        ) : tab === 'pictures' ? (
          library.length ? (
            <div className="bw-cdes-lib" aria-label="My pictures">
              {library.map((p) => (
                <div key={p.id} className={`bw-cdes-libitem${selectedPic === p.id ? ' is-on' : ''}`}>
                  <button
                    type="button"
                    className="bw-cdes-libpic"
                    aria-label="Put this picture on the card"
                    aria-pressed={selectedPic === p.id}
                    onPointerDown={() => {
                      longPressed.current = false;
                      press.current = setTimeout(() => {
                        longPressed.current = true;
                        dropFromLibrary(p.id);
                      }, 600);
                    }}
                    onPointerUp={() => press.current && clearTimeout(press.current)}
                    onPointerLeave={() => press.current && clearTimeout(press.current)}
                    onContextMenu={(e) => e.preventDefault()}
                    onClick={() => {
                      if (longPressed.current) return;
                      setImgErr('');
                      if (applyImage(p.uri)) setNftSel(null);
                    }}
                  >
                    <img src={p.uri} alt="" draggable={false} />
                  </button>
                  <button
                    type="button"
                    className="bw-cdes-libx"
                    aria-label="Remove this picture"
                    onClick={() => dropFromLibrary(p.id)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="bw-cdes-empty">No pictures yet. Tap Use my picture to add one (up to {CARD_LIBRARY_MAX}).</p>
          )
        ) : (
          <CardNftGrid selected={customImage ? nftSel : null} busy={nftBusy} onPick={(m) => void pickNft(m)} />
        )}
        <p className="bw-cdes-note">Your pictures stay on this device. They aren’t uploaded anywhere.</p>
        <ShimmerToggle />
      </div>
      <div className="bw-cdes-actions">
        <button type="button" className="bw-cdes-reset" onClick={onReset} disabled={isDefault}>
          Reset
        </button>
        <button type="button" className="bw-cdes-done" onClick={onClose}>
          Done
        </button>
      </div>
      {framing && (
        <CardFramePicker
          m={framing}
          onClose={() => setFraming(null)}
          onUse={(uri, src) => {
            addToLibrary(uri, src);
            setFraming(null);
          }}
        />
      )}
    </div>,
    document.body,
  );
}

/** Optional shimmer on the gold bAvatar (names/bavatarShimmer.ts): off by default, still with reduced motion. */
function ShimmerToggle() {
  const on = useBavatarShimmer();
  return (
    <label className="bw-cdes-note" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
      <input type="checkbox" checked={on} onChange={(e) => setBavatarShimmer(e.target.checked)} />
      Shimmer my bAvatar (a soft gold sweep)
    </label>
  );
}
