import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useServiceContext } from '../../hooks/useServiceContext';
import { checkSize, estimateCost, formatBytes } from '../mint/mint';
import { maxBytesFor, type MintKind } from '../mint/mintKinds';
import { fmtSats, fmtUsd, hasRate, satsToUsd, useBsvUsd } from '../money/money';
import { useWalletMedia, type MediaItem } from '../media/useWalletMedia';
import { thumbUrl } from '../market/thumbs';
import { HubArt } from './HubArt';
import { DROP_ACCEPT, DROP_UNSUPPORTED, handOff, TILE_LABEL, tileForFile, type DropTile } from './lib/drop';

/**
 * The bMint studio (owner, 19 Oct 2026: "needs dramatically improving"): the bmintx.com look inside the wallet.
 *   DropHero   "You made it. Prove it's yours." + a big drop zone. A dropped file shows as a sealed preview with a
 *              live cost estimate (mint.ts estimateCost, the same maths the confirm sheet uses), then "Mint it" opens
 *              the existing Mint sheet for that type with the file already picked (BmintPage MintOpen → MintSheet file).
 *   Steps      the calm three-step explanation.
 *   Vault      the wallet's real NFTs (media/useWalletMedia, the same list as Wallet › NFTs); gold empty state.
 * Nothing here signs or spends: every mint still goes through MintSheet and the wallet's confirm sheet.
 */

/** The bmintx.com seal: a gold rosette with the b mark. */
export const Seal = ({ className = '' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <linearGradient id="bm-seal-g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffe58a" />
        <stop offset=".55" stopColor="#ffd24d" />
        <stop offset="1" stopColor="#c98f00" />
      </linearGradient>
    </defs>
    <path
      fill="url(#bm-seal-g)"
      d="M50 2l7 8 10-3 3 10 10 2-1 10 9 6-5 9 5 9-9 6 1 10-10 2-3 10-10-3-7 8-7-8-10 3-3-10-10-2 1-10-9-6 5-9-5-9 9-6-1-10 10-2 3-10 10 3z"
    />
    <circle cx="50" cy="50" r="31" fill="none" stroke="#000" strokeOpacity=".35" strokeWidth="2" />
    <g fill="#1a1200">
      <polygon points="45,30 45,56 38,56 38,37" />
      <path fillRule="evenodd" d="M51 41a14 14 0 1 1 0 28a14 14 0 1 1 0-28zm0 8a6 6 0 1 0 0 12a6 6 0 1 0 0-12z" />
    </g>
  </svg>
);

const KIND_OF: Partial<Record<DropTile, MintKind>> = { art: 'picture', music: 'music', video: 'video', '3d': '3d' };

type Dropped = { file: File; tile: DropTile; url: string };

const usePreviewUrl = (file: File | null) => {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url;
};

const PreviewArt = ({ d }: { d: Dropped }) => {
  if (d.tile === 'art') return <img className="bm-prev-media" src={d.url} alt="" />;
  if (d.tile === 'video') return <video className="bm-prev-media" src={d.url} muted autoPlay loop playsInline />;
  return (
    <span className="bm-prev-art">
      <HubArt id={d.tile} />
    </span>
  );
};

/** Live estimate for one inscription of `bytes` at the wallet's fee rate (editions and covers are priced in the sheet). */
const useEstimate = (bytes: number) => {
  const { chromeStorageService } = useServiceContext();
  const rate = useBsvUsd();
  if (!bytes) return null;
  const cost = estimateCost(bytes, chromeStorageService.getCustomFeeRate(), rate);
  const usd = satsToUsd(cost.totalSats, rate);
  return { cost, main: usd !== null && hasRate(rate) ? `about ${fmtUsd(usd)}` : `about ${fmtSats(cost.totalSats)}` };
};

export const DropHero = ({ name }: { name: string }) => {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [tile, setTile] = useState<DropTile | null>(null);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const url = usePreviewUrl(file);
  const est = useEstimate(file?.size ?? 0);

  const take = (f: File | undefined) => {
    if (!f) return;
    const t = tileForFile(f.type, f.name);
    if (!t) {
      setFile(null);
      setTile(null);
      return setError(DROP_UNSUPPORTED);
    }
    setError('');
    setFile(f);
    setTile(t);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files?.[0]);
  };
  const reset = () => {
    setFile(null);
    setTile(null);
    setError('');
  };
  const mint = () => {
    if (!file || !tile) return;
    handOff(file);
    navigate(`/m/bmint/mint/${tile}`);
  };
  const d: Dropped | null = file && tile ? { file, tile, url } : null;
  const size = d ? checkSize(d.file.size, maxBytesFor(KIND_OF[d.tile])) : null;

  return (
    <section className="bm-hero2" aria-label="Mint something you made">
      <div className="bm-hero2-copy">
        <p className="bm-eyebrow">bMint · your work, on Bitcoin</p>
        <h1>
          You made it.
          <br />
          <span className="bm-shine">Prove it&rsquo;s yours.</span>
        </h1>
        <p className="bm-lede">
          Forever, for about a penny. Art, tracks, clips, models, books and pages get a timestamp on Bitcoin in your own
          name, and land in your vault.
        </p>
        <ol className="bm-steps">
          <li>
            <b>Drop it</b>
            <span>Anything you made, up to 10 MB (50 MB for video and 3D).</span>
          </li>
          <li>
            <b>Seal it</b>
            <span>Check the cost, then confirm in your wallet. Nothing is sent before you do.</span>
          </li>
          <li>
            <b>Keep it</b>
            <span>It sits in your vault as yours: keep it, send it or sell it.</span>
          </li>
        </ol>
      </div>

      {d ? (
        <div className="bm-preview" aria-live="polite">
          <div className="bm-prev-frame">
            <PreviewArt d={d} />
            <span className="bm-prev-shade" />
            <Seal className="bm-seal-stamp" />
            <span className="bm-prev-meta">
              <b>{d.file.name.replace(/\.\w+$/, '') || 'Untitled'}</b>
              <span>
                {TILE_LABEL[d.tile]} · by {name}
              </span>
            </span>
          </div>
          <dl className="bm-prev-facts">
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(d.file.size)}</dd>
            </div>
            <div>
              <dt>Cost to mint</dt>
              <dd className="gold">{est?.main ?? '…'}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>{name}</dd>
            </div>
          </dl>
          {size && !size.ok && <p className="bm-drop-err">{size.message}</p>}
          <p className="bm-prev-note">
            Network fee {est ? fmtSats(est.cost.networkSats) : '…'}
            {est && est.cost.feeSats > 0 ? ` + mint fee ${fmtSats(est.cost.feeSats)}` : ''}. Titles, editions and the
            exact total come next; you confirm before anything is sent.
          </p>
          <div className="bm-prev-actions">
            <button type="button" className="bm-btn gold bm-cta" onClick={mint}>
              Mint it
            </button>
            <button type="button" className="bm-btn" onClick={reset}>
              Choose another
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`bm-drop${over ? ' over' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <Seal className="bm-drop-seal" />
          <span className="bm-drop-title">Drop anything you made</span>
          <span className="bm-drop-sub">Pictures, music, video, 3D, PDFs and ebooks, one-page sites</span>
          <span className="bm-btn gold bm-cta">Choose a file</span>
          {error && <span className="bm-drop-err">{error}</span>}
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept={DROP_ACCEPT}
        hidden
        onChange={(e) => {
          take(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </section>
  );
};

const VaultTile = ({ item }: { item: MediaItem }) => {
  const [broken, setBroken] = useState(false);
  const thumb = item.kind === 'images' ? (thumbUrl(item.origin) ?? item.url) : '';
  return (
    <Link to="/m/nfts" className={`bm-vtile${item.flagged ? ' flagged' : ''}`}>
      <span className="bm-vart">
        {thumb && !broken ? (
          <img src={thumb} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : item.kind === 'video' ? (
          <video src={item.url} muted preload="metadata" playsInline />
        ) : (
          <HubArt id={item.kind === 'music' ? 'music' : 'books'} />
        )}
        {item.pending && <span className="bm-chip bm-vpending">Pending</span>}
        <Seal className="bm-vseal" />
      </span>
      <span className="bm-vcap">
        <b>{item.name}</b>
        <span>
          {item.kind === 'images'
            ? 'Picture'
            : item.kind === 'music'
              ? 'Music'
              : item.kind === 'video'
                ? 'Video'
                : 'Piece'}
        </span>
      </span>
    </Link>
  );
};

const VAULT_SHOWN = 10;

export const Vault = ({ name }: { name: string }) => {
  const { items, loading, error } = useWalletMedia();
  const shown = items.slice(0, VAULT_SHOWN);
  return (
    <section className="bm-vault" aria-label="Your vault">
      <div className="bm-vault-h">
        <div>
          <p className="bm-eyebrow">Your vault</p>
          <h2>Everything you&rsquo;ve sealed, in one place.</h2>
        </div>
        <span className="bm-vault-who">
          {name}
          {items.length > 0 && <small> · {items.length >= 50 ? '50+' : items.length} pieces</small>}
          {items.length > 0 && (
            <Link to="/m/nfts" className="bm-vault-all">
              See all
            </Link>
          )}
        </span>
      </div>
      {shown.length > 0 ? (
        <div className="bm-vgrid">
          {shown.map((i) => (
            <VaultTile key={i.origin} item={i} />
          ))}
        </div>
      ) : loading ? (
        <div className="bm-vgrid">
          {Array.from({ length: 5 }, (_, k) => (
            <span key={k} className="bm-vtile bm-vskel" />
          ))}
        </div>
      ) : (
        <div className="bm-vempty">
          <Seal className="bm-vempty-seal" />
          <b>{error ? "Couldn't open your vault" : 'Your vault is waiting'}</b>
          <span>{error || 'Your first mint lands here, sealed with your name and the time it was made.'}</span>
        </div>
      )}
    </section>
  );
};
