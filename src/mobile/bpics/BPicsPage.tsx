import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, EyeOff, Flag, ImagePlus, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { SendConfirmation } from '../../components/SendConfirmation';
import { cachedExchangeRate, fetchExchangeRate } from '../../utils/wallet';
import { useBackClose } from '../backStack';
import { mintMedia } from '../mint/mintMedia';
import { BLOCKED_MESSAGE, blockedText, estimateCost, formatBytes, notifyMinted, validateForm } from '../mint/mint';
import { money, moneyWithSats } from '../money/money';
import { contentUrls } from '../market/indexer';
import { cachedIssuer, verifyIssuer, type IssuerInfo } from '../issuer/issuerVerify';
import { bavatarDataUri } from '../names/avatar';
import { ReportSheet } from '../ugc/UgcSheets';
import { isBlocked, onUgcChange } from '../ugc/ugc';
import { useWalletMedia } from '../media/useWalletMedia';
import { prepareCardImage, saveCardImage } from '../wallet/cardFrontArt';
import {
  base64Bytes,
  buildPicMap,
  feedUrl,
  hideMinter,
  hidePic,
  isSafeImageType,
  loadHidden,
  PAGE_SIZE,
  parseFeed,
  PIC_MAX_EDGE,
  PIC_QUALITY,
  saveHidden,
  SHARE_DEFAULT,
  splitDataUri,
  visibleFeed,
  withRepeatGuard,
  type Pic,
} from './bpics';

/**
 * bPics (Apps › bPics, /m/bpics): Library (shared picture ordinals, newest first), Mine (pictures this wallet
 * holds, "Use on my card") and Mint a picture. Only pictures are shown, always through <img>. Both editions:
 * nothing here sells, funds or likes.
 */
const GOLD = '#FFD24D';
const PANEL = '#17191E';
const BORDER = '#3a2f0c';
const MUTED = '#98A2B3';

type Tab = 'library' | 'mine';

/** An <img> that steps through the content hosts; when all fail, gold art (never a grey box). */
const PicImg = ({ origin, alt }: { origin: string; alt: string }) => {
  const urls = useMemo(() => contentUrls(origin), [origin]);
  const [i, setI] = useState(0);
  if (i >= urls.length)
    return (
      <div
        className="w-full aspect-square flex items-center justify-center"
        style={{ background: 'linear-gradient(135deg, #2a2207, #0b0b0b)' }}
      >
        <ImagePlus size={28} color={GOLD} />
      </div>
    );
  return (
    <img
      src={urls[i]}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setI((n) => n + 1)}
      className="w-full aspect-square object-cover"
      style={{ background: 'linear-gradient(135deg, #2a2207, #0b0b0b)' }}
    />
  );
};

const minterKeys = (p: Pic, info: IssuerInfo | null | undefined) => ({
  keys: [info?.status === 'verified' ? info.identityKey : undefined, p.owner].filter((k): k is string => !!k),
  handle: info?.status === 'verified' ? (info.handle ?? null) : null,
});

const BPicsPage = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('library');
  const [minting, setMinting] = useState(false);
  return (
    <div className="min-h-full px-4 pt-3 pb-24 text-white" style={{ background: '#0b0b0b' }}>
      <div className="flex items-center gap-2 mb-3">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label="Back"
          className="bg-transparent border-0 cursor-pointer p-1"
        >
          <ArrowLeft size={20} color="#ddd" />
        </button>
        <span className="font-bold text-lg" style={{ color: GOLD }}>
          bPics
        </span>
        <button
          type="button"
          onClick={() => setMinting(true)}
          className="ml-auto flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-bold border-0 cursor-pointer"
          style={{ background: 'linear-gradient(135deg, #FFE27A, #E0A800)', color: '#1a1400' }}
        >
          <ImagePlus size={16} /> Mint a picture
        </button>
      </div>
      <div className="flex gap-2 mb-3">
        {(['library', 'mine'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className="px-3 py-1.5 rounded-full text-sm font-semibold cursor-pointer border"
            style={
              tab === t
                ? { background: GOLD, color: '#1a1400', borderColor: GOLD }
                : { background: 'transparent', color: '#ddd', borderColor: BORDER }
            }
          >
            {t === 'library' ? 'Library' : 'Mine'}
          </button>
        ))}
      </div>
      {tab === 'library' ? <Library /> : <Mine />}
      {minting && <MintPicSheet onClose={() => setMinting(false)} />}
    </div>
  );
};
export default BPicsPage;

// ── Library ──

const Library = () => {
  const [pics, setPics] = useState<Pic[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState(loadHidden);
  const [issuers, setIssuers] = useState<Record<string, IssuerInfo>>({});
  const [, setTick] = useState(0);
  const [reporting, setReporting] = useState<Pic | null>(null);
  useEffect(() => onUgcChange(() => setTick((n) => n + 1)), []);

  const load = useCallback(async (from: number) => {
    setLoading(true);
    setError('');
    try {
      const r = await fetch(feedUrl(from), { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(String(r.status));
      const raw = (await r.json()) as unknown[];
      const page = parseFeed(raw);
      setPics((prev) => (from === 0 ? page : [...prev, ...page]));
      setOffset(from + (Array.isArray(raw) ? raw.length : 0));
      setMore(Array.isArray(raw) && raw.length === PAGE_SIZE);
    } catch {
      setError("Couldn't load bPics. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(0), [load]);

  // Who minted each picture: the issuer signature in its mint tx, checked on this device (issuer/issuerVerify).
  useEffect(() => {
    let live = true;
    for (const p of pics) {
      if (issuers[p.origin]) continue;
      const hit = cachedIssuer(p.origin);
      if (hit) {
        setIssuers((m) => ({ ...m, [p.origin]: hit }));
        continue;
      }
      void verifyIssuer(p.origin).then((i) => live && setIssuers((m) => ({ ...m, [p.origin]: i })));
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pics]);

  const shown = visibleFeed(pics, hidden, (p) => minterKeys(p, issuers[p.origin]), isBlocked);
  const update = (h: typeof hidden) => {
    saveHidden(h);
    setHidden(h);
  };

  return (
    <>
      <p className="text-xs mb-3" style={{ color: MUTED }}>
        Pictures people chose to share in bPics, newest first.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {shown.map((p) => {
          const info = issuers[p.origin];
          const m = minterKeys(p, info);
          const avatar = (info?.status === 'verified' && bavatarDataUri(info.identityKey)) || '';
          const who = m.handle ? `$${m.handle.replace(/^\$/, '')}` : `${p.owner.slice(0, 6)}…`;
          return (
            <div key={p.origin} className="rounded-xl overflow-hidden border" style={{ borderColor: BORDER }}>
              <PicImg origin={p.origin} alt={p.name} />
              <div className="px-2 py-1.5 flex flex-col gap-1">
                <span className="text-xs font-semibold truncate">{p.name}</span>
                <div className="flex items-center gap-1.5">
                  {avatar ? (
                    <img src={avatar} alt="" width={16} height={16} className="rounded-full" />
                  ) : (
                    <span className="w-4 h-4 rounded-full" style={{ background: GOLD }} />
                  )}
                  <span className="text-[11px] truncate" style={{ color: MUTED }}>
                    {who}
                  </span>
                  <button
                    type="button"
                    aria-label="Report or hide"
                    onClick={() => setReporting(p)}
                    className="ml-auto bg-transparent border-0 cursor-pointer p-0.5"
                  >
                    <Flag size={13} color={MUTED} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {!loading && !error && shown.length === 0 && (
        <p className="text-sm text-center mt-8" style={{ color: MUTED }}>
          No shared pictures yet. Mint one and tick Share in bPics.
        </p>
      )}
      {error && (
        <p className="text-sm mt-4" style={{ color: '#ff6b6b' }}>
          {error}
        </p>
      )}
      {more && !loading && pics.length > 0 && (
        <button
          type="button"
          onClick={() => void load(offset)}
          className="w-full mt-3 py-2.5 rounded-xl text-sm font-semibold border bg-transparent cursor-pointer"
          style={{ borderColor: BORDER, color: GOLD }}
        >
          More
        </button>
      )}
      {loading && (
        <p className="text-xs text-center mt-3" style={{ color: MUTED }}>
          Loading…
        </p>
      )}
      {reporting && (
        <ReportSheet
          title={`Report "${reporting.name}"`}
          report={{ kind: 'feed_post', target: reporting.origin, content: `bPics picture ${reporting.origin}` }}
          onClose={() => setReporting(null)}
          onSent={() => update(hidePic(hidden, reporting.origin))}
          extra={
            <div className="flex flex-col gap-2">
              <SheetButton
                icon={<EyeOff size={14} />}
                label="Hide this picture"
                onClick={() => {
                  update(hidePic(hidden, reporting.origin));
                  setReporting(null);
                }}
              />
              <SheetButton
                icon={<EyeOff size={14} />}
                label="Hide everything from this minter"
                onClick={() => {
                  const m = minterKeys(reporting, issuers[reporting.origin]);
                  update(hideMinter(hidePic(hidden, reporting.origin), [...m.keys, m.handle]));
                  setReporting(null);
                }}
              />
            </div>
          }
        />
      )}
    </>
  );
};

const SheetButton = ({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-white border-0 cursor-pointer"
    style={{ background: '#2b2f36' }}
  >
    {icon}
    {label}
  </button>
);

// ── Mine ──

const Mine = () => {
  const { chromeStorageService } = useServiceContext();
  const { items, loading, error, hasMore, loadMore } = useWalletMedia();
  const [note, setNote] = useState('');
  const pics = items.filter((i) => isSafeImageType(i.type));
  const identityPubKey = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey;

  const applyToCard = async (url: string) => {
    setNote('');
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error();
      const blob = await r.blob();
      const uri = await prepareCardImage(new File([blob], 'pic', { type: blob.type || 'image/jpeg' }));
      setNote(saveCardImage(identityPubKey, uri) ? 'Done. Your card shows this picture.' : 'No room on this device.');
    } catch {
      setNote('That picture couldn’t be used on your card.');
    }
  };

  return (
    <>
      <p className="text-xs mb-3" style={{ color: MUTED }}>
        Pictures in this wallet.
      </p>
      {note && (
        <p className="text-sm mb-2" style={{ color: GOLD }}>
          {note}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {pics.map((p) => (
          <div key={p.output.outpoint} className="rounded-xl overflow-hidden border" style={{ borderColor: BORDER }}>
            <img
              src={p.url}
              alt={p.name}
              loading="lazy"
              className="w-full aspect-square object-cover"
              style={{ background: 'linear-gradient(135deg, #2a2207, #0b0b0b)' }}
            />
            <div className="px-2 py-1.5 flex flex-col gap-1">
              <span className="text-xs font-semibold truncate">{p.name}</span>
              <button
                type="button"
                onClick={() => void applyToCard(p.url)}
                className="text-[11px] font-semibold py-1 rounded-lg border bg-transparent cursor-pointer"
                style={{ borderColor: BORDER, color: GOLD }}
              >
                Use on my card
              </button>
            </div>
          </div>
        ))}
      </div>
      {!loading && pics.length === 0 && !error && (
        <p className="text-sm text-center mt-8" style={{ color: MUTED }}>
          No pictures yet. Tap Mint a picture.
        </p>
      )}
      {error && (
        <p className="text-sm mt-4" style={{ color: '#ff6b6b' }}>
          {error}
        </p>
      )}
      {hasMore && !loading && (
        <button
          type="button"
          onClick={() => void loadMore()}
          className="w-full mt-3 py-2.5 rounded-xl text-sm font-semibold border bg-transparent cursor-pointer"
          style={{ borderColor: BORDER, color: GOLD }}
        >
          More
        </button>
      )}
    </>
  );
};

// ── Mint a picture ──

const MintPicSheet = ({ onClose }: { onClose: () => void }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  useBackClose(true, onClose);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pic, setPic] = useState<{ uri: string; base64: string; contentType: string; bytes: number } | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [share, setShare] = useState(SHARE_DEFAULT);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [rate, setRate] = useState(cachedExchangeRate());
  useEffect(() => {
    if (!rate) void fetchExchangeRate('main').then(setRate, () => undefined);
  }, [rate]);

  const cost = pic ? estimateCost(pic.bytes, chromeStorageService.getCustomFeeRate(), rate, { feeAddress: '' }) : null;

  const pick = async (file: File | undefined) => {
    setError('');
    if (!file) return;
    try {
      const uri = await prepareCardImage(file, PIC_MAX_EDGE, PIC_QUALITY);
      const { base64, contentType } = splitDataUri(uri);
      setPic({ uri, base64, contentType, bytes: base64Bytes(base64) });
      if (!title) setTitle(file.name.replace(/\.\w+$/, '').slice(0, 100));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That picture couldn’t be opened.');
    }
  };

  const review = () => {
    if (!pic) return setError('Choose a picture.');
    const err = validateForm({ title, description, collection: { kind: 'none' } });
    setError(err ?? '');
    if (!err) setConfirming(true);
  };

  const mint = async () => {
    if (!pic || !cost) return;
    if (blockedText({ title, description, collection: { kind: 'none' } })) {
      setConfirming(false);
      return setError(BLOCKED_MESSAGE);
    }
    setBusy(true);
    try {
      const res = await mintMedia(withRepeatGuard(apiContext), {
        base64Content: pic.base64,
        contentType: pic.contentType,
        title,
        description,
        collection: { kind: 'none' },
        feeSats: cost.feeSats,
        map: buildPicMap({ title, description, share }),
      });
      setDone(res.txid);
      notifyMinted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mint failed');
    } finally {
      setConfirming(false);
      setBusy(false);
    }
  };

  const input = 'w-full rounded-xl px-3 py-2 text-sm outline-none border bg-transparent';
  return (
    <div className="fixed inset-0 z-[150] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div
        className="w-full max-w-md rounded-t-2xl p-4 overflow-y-auto flex flex-col gap-3 text-sm"
        style={{
          background: PANEL,
          color: '#fff',
          maxHeight: 'calc(100dvh - env(safe-area-inset-top) - 24px)',
          paddingBottom: 'calc(16px + env(safe-area-inset-bottom))',
        }}
      >
        <div className="flex items-center justify-between">
          <span className="font-bold text-lg" style={{ color: GOLD }}>
            {done ? 'Minted' : 'Mint a picture'}
          </span>
          <button type="button" onClick={onClose} className="bg-transparent border-0 cursor-pointer" aria-label="Close">
            <X size={20} color="#aaa" />
          </button>
        </div>
        {done ? (
          <>
            <p>
              "{title.trim()}" is minted.{' '}
              {share ? 'It will show in the bPics library shortly.' : 'It is in your wallet, not shared.'}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="h-11 rounded-xl font-bold border cursor-pointer bg-transparent"
              style={{ borderColor: BORDER, color: GOLD }}
            >
              Done
            </button>
          </>
        ) : (
          <>
            {/* Photos only: no capture attribute, so the picker opens the library, not the camera. */}
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="rounded-xl border border-dashed py-4 cursor-pointer bg-transparent"
              style={{ borderColor: GOLD, color: GOLD }}
            >
              {pic ? 'Choose a different picture' : 'Choose from Photos'}
            </button>
            {pic && (
              <div className="rounded-xl overflow-hidden border" style={{ borderColor: BORDER }}>
                <img src={pic.uri} alt="" className="w-full max-h-64 object-contain bg-black" />
                <div className="px-3 py-2 text-xs" style={{ color: '#bbb' }}>
                  JPEG · {formatBytes(pic.bytes)}
                </div>
              </div>
            )}
            <input
              className={input}
              style={{ borderColor: BORDER, color: '#fff' }}
              placeholder="Title (required)"
              value={title}
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              className={input}
              style={{ borderColor: BORDER, color: '#fff' }}
              placeholder="Description"
              rows={2}
              value={description}
              maxLength={1000}
              onChange={(e) => setDescription(e.target.value)}
            />
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={share}
                onChange={(e) => setShare(e.target.checked)}
                className="mt-0.5"
                style={{ accentColor: GOLD }}
              />
              <span>
                Share in bPics
                <span className="block text-xs" style={{ color: MUTED }}>
                  Anyone can see shared pictures in the bPics library.
                </span>
              </span>
            </label>
            <p className="text-xs" style={{ color: MUTED }}>
              Don't mint anything you don't own or that's illegal. Inscriptions are permanent.
            </p>
            {cost && (
              <p className="text-xs" style={{ color: '#bbb' }}>
                Price: network fee {money(cost.networkSats, rate)}
                {cost.feeSats > 0 && <> · bWallet mint fee (1%) {money(cost.feeSats, rate)}</>} · Total ≈{' '}
                {moneyWithSats(cost.totalSats, rate)}
              </p>
            )}
            {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}
            <button
              type="button"
              onClick={review}
              className="h-11 rounded-xl font-bold border-0 cursor-pointer"
              style={{ background: 'linear-gradient(135deg, #FFE27A, #E0A800)', color: '#1a1400' }}
            >
              Review mint
            </button>
          </>
        )}
      </div>
      <SendConfirmation
        show={confirming}
        theme={theme}
        lineItems={[
          { address: `Mint "${title.trim()}"`, amount: pic ? formatBytes(pic.bytes) : '' },
          ...(cost ? [{ address: 'Network fee (est.)', amount: money(cost.networkSats, rate) }] : []),
          ...(cost && cost.feeSats > 0
            ? [{ address: 'bWallet mint fee (1%)', amount: money(cost.feeSats, rate) }]
            : []),
        ]}
        total={cost ? moneyWithSats(cost.totalSats, rate) : undefined}
        isProcessing={busy}
        onConfirm={() => void mint()}
        onCancel={() => !busy && setConfirming(false)}
      />
    </div>
  );
};
