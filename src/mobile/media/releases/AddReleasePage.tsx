import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, X } from 'lucide-react';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { cachedExchangeRate, fetchExchangeRate } from '../../../utils/wallet';
import { useBackClose } from '../../backStack';
import { mintMedia } from '../../mint/mintMedia';
import {
  BLOCKED_MESSAGE,
  blockedText,
  checkSize,
  estimateCost,
  fileToBase64,
  formatBytes,
  notifyMinted,
  wocTxUrl,
} from '../../mint/mint';
import { moneyWithSats } from '../../money/money';
import { prepareCardImage } from '../../wallet/cardFrontArt';
import { base64Bytes, splitDataUri, withRepeatGuard } from '../../bpics/bpics';
import {
  buildReleaseMap,
  buildTrackMap,
  COVER_EDGE,
  isSafeTrackType,
  MAX_TRACKS,
  moveItem,
  RIGHTS_NOTE,
  validateRelease,
  type TrackRef,
} from './releases';

/**
 * Media › Add a release (bWalletX only; RELEASES_ENABLED). Audio / video files plus a square cover, published
 * through the normal mint path (mintMedia) inside RepeatGuard, so a slow broadcast is never paid twice.
 * Price: Free only — there is no sale path for releases yet.
 */
const GOLD = '#FFD24D';
const PANEL = '#111216';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

type PickedTrack = { file: File; title: string };

/** Centre-crop a data-URI picture to 1:1 JPEG (prepareCardImage has already resized it). */
const squareCrop = (uri: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = c.height = side;
      const ctx = c.getContext('2d');
      if (!ctx) return reject(new Error('This device can’t resize pictures.'));
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, side, side);
      resolve(c.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => reject(new Error('That picture couldn’t be opened.'));
    img.src = uri;
  });

const AddReleasePage = () => {
  const navigate = useNavigate();
  const close = () => navigate(-1);
  useBackClose(true, close);
  const { apiContext, chromeStorageService } = useServiceContext();
  const coverRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const [cover, setCover] = useState<string | null>(null);
  const [tracks, setTracks] = useState<PickedTrack[]>([]);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [genre, setGenre] = useState('');
  const [description, setDescription] = useState('');
  const [ai, setAi] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState('');
  const [rate, setRate] = useState(cachedExchangeRate());
  useEffect(() => {
    if (!rate) void fetchExchangeRate('main').then(setRate, () => undefined);
  }, [rate]);

  const satsPerKb = chromeStorageService.getCustomFeeRate();
  const coverBytes = cover ? base64Bytes(splitDataUri(cover).base64) : 0;
  const costs = [...tracks.map((t) => t.file.size), ...(cover ? [coverBytes] : [])].map((b) =>
    estimateCost(b, satsPerKb, rate),
  );
  const total = costs.reduce((s, c) => s + c.totalSats, 0);
  const fees = costs.reduce((s, c) => s + c.feeSats, 0);

  const pickCover = async (file?: File) => {
    setError('');
    if (!file) return;
    try {
      setCover(await squareCrop(await prepareCardImage(file, COVER_EDGE, 0.9)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That picture couldn’t be opened.');
    }
  };
  const pickFiles = (list: FileList | null) => {
    setError('');
    const add: PickedTrack[] = [];
    for (const f of Array.from(list ?? [])) {
      if (!isSafeTrackType(f.type)) {
        setError(`${f.name}: choose audio (mp3, m4a, wav…) or video (mp4, webm).`);
        continue;
      }
      const size = checkSize(f.size);
      if (!size.ok) {
        setError(`${f.name}: ${size.message}`);
        continue;
      }
      add.push({ file: f, title: f.name.replace(/\.\w+$/, '').slice(0, 100) });
    }
    setTracks((t) => [...t, ...add].slice(0, MAX_TRACKS));
  };

  const fields = { title, artist, genre, description, ai };
  const review = () => {
    const err =
      validateRelease(fields, tracks.length, !!cover) ??
      (tracks.some((t) => !t.title.trim()) ? 'Give every track a title.' : null) ??
      (blockedText({
        title: [title, artist, genre, ...tracks.map((t) => t.title)].join(' '),
        description,
        collection: { kind: 'none' },
      })
        ? BLOCKED_MESSAGE
        : null);
    setError(err ?? '');
    if (!err) setConfirming(true);
  };

  const publish = async () => {
    if (!cover) return;
    setError('');
    const ctx = withRepeatGuard(apiContext);
    try {
      const refs: TrackRef[] = [];
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        setBusy(`Publishing track ${i + 1} of ${tracks.length}…`);
        const res = await mintMedia(ctx, {
          base64Content: fileToBase64(await t.file.arrayBuffer()),
          contentType: t.file.type,
          title: t.title,
          description: '',
          collection: { kind: 'none' },
          feeSats: costs[i].feeSats,
          map: buildTrackMap({ title: t.title, artist }),
        });
        refs.push({ origin: res.origin, title: t.title, contentType: t.file.type });
      }
      setBusy('Publishing the release…');
      const { base64, contentType } = splitDataUri(cover);
      const res = await mintMedia(ctx, {
        base64Content: base64,
        contentType,
        title,
        description,
        collection: { kind: 'none' },
        feeSats: costs[costs.length - 1].feeSats,
        map: buildReleaseMap(fields, refs),
      });
      setDone(res.txid);
      notifyMinted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Publishing failed');
    } finally {
      setBusy('');
      setConfirming(false);
    }
  };

  const input = 'w-full px-3 py-2 text-sm outline-none border bg-transparent text-white';
  const inputStyle = { borderColor: LINE, borderRadius: 6 };
  const label = 'text-[11px] font-bold uppercase tracking-widest';

  return (
    <div className="fixed inset-0 z-[150] overflow-y-auto" style={{ background: '#010101' }}>
      <div
        className="sticky top-0 z-10 flex items-center gap-2 px-2 py-2"
        style={{ background: '#010101', borderBottom: `1px solid ${LINE}` }}
      >
        <button aria-label="Back" onClick={close} className="p-2">
          <ArrowLeft size={20} color="#fff" />
        </button>
        <h1 className="text-lg font-bold text-white">Add a release</h1>
      </div>
      {done ? (
        <div className="max-w-xl mx-auto p-6 flex flex-col gap-3 text-sm text-white">
          <p className="text-lg font-bold" style={{ color: GOLD }}>
            Published
          </p>
          <p style={{ color: MUTED }}>It shows on Media once the indexer picks it up (usually a minute or two).</p>
          <a href={wocTxUrl(done)} target="_blank" rel="noreferrer" className="underline" style={{ color: GOLD }}>
            View on chain
          </a>
          <button
            onClick={close}
            className="mt-2 px-5 py-2 font-bold self-start"
            style={{ background: GOLD, color: '#1a1300', borderRadius: 4 }}
          >
            Back to Media
          </button>
        </div>
      ) : (
        <div className="max-w-4xl mx-auto p-4 md:p-6 flex flex-col md:flex-row gap-6">
          <div className="w-full md:w-[280px] shrink-0 flex flex-col gap-2">
            <span className={label} style={{ color: MUTED }}>
              Square cover
            </span>
            <button
              onClick={() => coverRef.current?.click()}
              className="w-full aspect-square overflow-hidden flex items-center justify-center"
              style={{
                borderRadius: 6,
                border: `1px dashed ${cover ? 'transparent' : GOLD}`,
                background: cover
                  ? '#000'
                  : 'radial-gradient(circle at 30% 30%, #FFE58A, #D9A520 30%, #3a2a05 70%, #000)',
              }}
            >
              {cover ? (
                <img src={cover} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-sm font-bold" style={{ color: '#0b0b0b' }}>
                  Choose cover
                </span>
              )}
            </button>
            <input
              ref={coverRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => void pickCover(e.target.files?.[0])}
            />
            <p className="text-[11px]" style={{ color: MUTED }}>
              Cropped to a square, up to {COVER_EDGE}px.
            </p>
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className={label} style={{ color: MUTED }}>
                Title
              </span>
              <input className={input} style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={label} style={{ color: MUTED }}>
                Artist
              </span>
              <input className={input} style={inputStyle} value={artist} onChange={(e) => setArtist(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={label} style={{ color: MUTED }}>
                Genre
              </span>
              <input className={input} style={inputStyle} value={genre} onChange={(e) => setGenre(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={label} style={{ color: MUTED }}>
                Description (optional)
              </span>
              <textarea
                className={input}
                style={inputStyle}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-white">
              <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />
              AI-made
            </label>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className={label} style={{ color: MUTED }}>
                  Tracks
                </span>
                <button
                  onClick={() => filesRef.current?.click()}
                  className="px-3 py-1 text-xs font-bold"
                  style={{ border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 4 }}
                >
                  Add files
                </button>
                <input
                  ref={filesRef}
                  type="file"
                  multiple
                  accept="audio/*,video/mp4,video/webm,video/quicktime"
                  className="hidden"
                  onChange={(e) => {
                    pickFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>
              {tracks.map((t, i) => (
                <div key={`${t.file.name}-${i}`} className="flex items-center gap-2">
                  <span className="w-5 text-xs text-right" style={{ color: MUTED }}>
                    {i + 1}
                  </span>
                  <input
                    className={input}
                    style={inputStyle}
                    value={t.title}
                    onChange={(e) => setTracks((l) => l.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                  />
                  <span className="text-[11px] w-16 text-right shrink-0" style={{ color: MUTED }}>
                    {formatBytes(t.file.size)}
                  </span>
                  <button aria-label="Move up" onClick={() => setTracks((l) => moveItem(l, i, i - 1))}>
                    <ArrowUp size={14} color={MUTED} />
                  </button>
                  <button aria-label="Move down" onClick={() => setTracks((l) => moveItem(l, i, i + 1))}>
                    <ArrowDown size={14} color={MUTED} />
                  </button>
                  <button aria-label="Remove" onClick={() => setTracks((l) => l.filter((_, j) => j !== i))}>
                    <X size={14} color={MUTED} />
                  </button>
                </div>
              ))}
              {!tracks.length && (
                <p className="text-xs" style={{ color: MUTED }}>
                  One file for a single, several for an album. Up to 10 MB each.
                </p>
              )}
            </div>
            <div className="text-xs" style={{ color: MUTED }}>
              Price per track: <span style={{ color: GOLD }}>Free</span>
            </div>
            <p className="text-xs" style={{ color: '#d0d5dd' }}>
              {RIGHTS_NOTE}
            </p>
            {error && <p className="text-xs text-[#F97066]">{error}</p>}
            {confirming ? (
              <div
                className="flex flex-col gap-2 p-3"
                style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 6 }}
              >
                <p className="text-sm text-white">
                  Publishing costs about <b>{moneyWithSats(total, rate)}</b> ({tracks.length + 1} inscriptions
                  {fees > 0 ? `, including the 1% mint fee of ${fees} sats` : ''}).
                </p>
                <div className="flex gap-2">
                  <button
                    disabled={!!busy}
                    onClick={() => void publish()}
                    className="px-5 py-2 text-sm font-bold"
                    style={{ background: GOLD, color: '#1a1300', borderRadius: 4 }}
                  >
                    {busy || 'Publish'}
                  </button>
                  {!busy && (
                    <button onClick={() => setConfirming(false)} className="px-4 py-2 text-sm" style={{ color: MUTED }}>
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <button
                onClick={review}
                className="px-5 py-2 text-sm font-bold self-start"
                style={{ background: GOLD, color: '#1a1300', borderRadius: 4 }}
              >
                Review
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default AddReleasePage;
