/**
 * bPics › Photo market (owner direction 15 Oct 2026). bWalletX only: this chunk is not built into a store edition
 * (BPICS_MARKET_ENABLED). Tabs: Photos (approved, ranked by total paid to the photographer), Art (vetted 1Sat
 * collections only), Sell (mint a photo with a price; one approval sheet), Claim (prove an address, list its chain
 * photos), Mine (my listings in every state; pending ones are only visible here), Bought (photos I paid for).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Flag, ImagePlus } from 'lucide-react';
import { listOrdinals, sendBsv } from '@1sat/actions';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { useTheme } from '../../../hooks/useTheme';
import { SendConfirmation } from '../../../components/SendConfirmation';
import { cachedExchangeRate, fetchExchangeRate } from '../../../utils/wallet';
import { currentFx, fiatSymbol } from '../../../utils/displayCurrency';
import { contentUrls } from '../../market/indexer';
import { estimateCost } from '../../mint/mint';
import { mintMedia } from '../../mint/mintMedia';
import { money, moneyWithSats } from '../../money/money';
import { TipButton } from '../../tip/TipButton';
import { useMe } from '../../tip/useMe';
import { useLegacyKeys } from '../../names/useLegacyKeys';
import { withRepeatGuard } from '../bpics';
import { notOpenYet, publicClient, signedClient } from './api';
import { ART_COLLECTIONS, artMarketUrl, parseArt, type ArtItem } from './collections';
import { buyPhoto, claimChainPhotos, listPhoto, unlockPhoto } from './flows';
import {
  LICENCES,
  LICENCE_TEXT,
  REPORT_REASONS,
  STATUS_LABEL,
  forSale,
  priceToSats,
  rankedFeed,
  validatePhoto,
  type Licence,
  type MarketItem,
  type ReportReason,
} from './listing';
import { makePreview } from './preview';

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#98A2B3';
const BORDER = '#2a2a2a';
const TABS = [
  ['photos', 'Photos'],
  ['art', 'Art'],
  ['sell', 'Sell'],
  ['claim', 'Claim'],
  ['mine', 'Mine'],
  ['bought', 'Bought'],
] as const;
type Tab = (typeof TABS)[number][0];

const BOUGHT_KEY = 'bwallet.bpics.bought';
type Bought = { itemId: string; txid: string; title: string };
const loadBought = (): Bought[] => {
  try {
    const v = JSON.parse(localStorage.getItem(BOUGHT_KEY) || '[]') as Bought[];
    return Array.isArray(v) ? v.filter((b) => b && typeof b.itemId === 'string' && typeof b.txid === 'string') : [];
  } catch {
    return [];
  }
};
const saveBought = (b: Bought) => {
  try {
    localStorage.setItem(BOUGHT_KEY, JSON.stringify([b, ...loadBought().filter((x) => x.itemId !== b.itemId)]));
  } catch {
    /* storage unavailable */
  }
};

const useRate = () => {
  const [rate, setRate] = useState(cachedExchangeRate());
  useEffect(() => {
    if (!rate) void fetchExchangeRate('main').then(setRate, () => undefined);
  }, [rate]);
  return rate;
};

async function fetchBytes(outpoint: string): Promise<Uint8Array> {
  for (const u of contentUrls(outpoint)) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(30_000) });
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch {
      /* next host */
    }
  }
  throw new Error('Could not fetch the photo file. Try again.');
}

const saveFile = (bytes: Uint8Array, name: string) => {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^\w-]+/g, '_') || 'photo'}.jpg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

const Pill = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) => (
  <button
    type="button"
    role="tab"
    aria-selected={on}
    onClick={onClick}
    className="shrink-0 px-3.5 py-1.5 rounded-full text-sm font-semibold cursor-pointer border-0"
    style={on ? { background: GOLD, color: '#1a1400' } : { background: 'transparent', color: '#ccc' }}
  >
    {children}
  </button>
);

const Note = ({ children }: { children: ReactNode }) => (
  <p className="text-sm my-3" style={{ color: MUTED }}>
    {children}
  </p>
);

const Thumb = ({ outpoint, alt }: { outpoint: string; alt: string }) => {
  const urls = contentUrls(outpoint);
  const [i, setI] = useState(0);
  return urls[i] ? (
    <img
      src={urls[i]}
      alt={alt}
      loading="lazy"
      onError={() => setI((n) => n + 1)}
      className="w-full aspect-square object-cover rounded-lg"
      style={{ background: 'linear-gradient(135deg, #2a2207, #0b0b0b)' }}
    />
  ) : (
    <div
      className="w-full aspect-square rounded-lg"
      style={{ background: 'linear-gradient(135deg, #2a2207, #0b0b0b)' }}
    />
  );
};

// ── Photos: the bPics feed, ranked by total paid to the photographer ──

export const PhotosFeed = ({ compact = false }: { compact?: boolean }) => {
  const [items, setItems] = useState<MarketItem[] | null>(null);
  const [error, setError] = useState('');
  const [buying, setBuying] = useState<MarketItem | null>(null);
  const [reporting, setReporting] = useState<MarketItem | null>(null);
  const rate = useRate();
  useEffect(() => {
    publicClient()
      .feed()
      .then((l) => setItems(rankedFeed(l)))
      .catch((e) => {
        setItems([]);
        if (!notOpenYet(e)) setError("Couldn't load photos. Check your connection.");
      });
  }, []);
  if (!items) return <Note>Loading photos…</Note>;
  if (error) return <Note>{error}</Note>;
  if (!items.length)
    return (
      <Note>No photos yet. Photographers list their work from Sell; every photo is reviewed before it shows here.</Note>
    );
  const shown = compact ? items.slice(0, 12) : items;
  return (
    <>
      <div
        className={`grid gap-3 ${compact ? 'grid-cols-3 sm:grid-cols-6' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'}`}
      >
        {shown.map((it) => (
          <div key={it.id} className="flex flex-col gap-1.5">
            <Thumb outpoint={it.id} alt={it.title} />
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-sm font-semibold truncate flex-1">{it.title}</span>
              {!compact && (
                <TipButton
                  compact
                  to={{ name: it.paymail || it.title, identityKey: it.creatorKey, paymail: it.paymail ?? undefined }}
                  context={{ kind: 'nft', outpoint: it.id }}
                />
              )}
              {!compact && (
                <button
                  type="button"
                  aria-label="Report"
                  onClick={() => setReporting(it)}
                  className="bg-transparent border-0 cursor-pointer p-1"
                >
                  <Flag size={13} color={MUTED} />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
              <span>{it.paidSats > 0 ? `${money(it.paidSats, rate)} paid to the artist` : 'New'}</span>
            </div>
            {forSale(it) && !compact && (
              <button
                type="button"
                onClick={() => setBuying(it)}
                className="rounded-full py-1.5 text-sm font-bold cursor-pointer border-0"
                style={{ background: GOLD, color: '#1a1400' }}
              >
                Buy {money(it.priceSats!, rate)} · {it.licence === 'commercial' ? 'Commercial' : 'Personal'}
              </button>
            )}
          </div>
        ))}
      </div>
      {buying && <BuySheet item={buying} rate={rate} onClose={() => setBuying(null)} />}
      {reporting && <ReportPhoto item={reporting} onClose={() => setReporting(null)} />}
    </>
  );
};

const BuySheet = ({ item, rate, onClose }: { item: MarketItem; rate: number; onClose: () => void }) => {
  const { apiContext } = useServiceContext();
  const { theme } = useTheme();
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const buy = async () => {
    if (!apiContext?.wallet || !me?.identityKey) return setMsg('Unlock your wallet first.');
    setBusy(true);
    setMsg('');
    try {
      const client = await signedClient(apiContext);
      const { txid, photo } = await buyPhoto(
        {
          wallet: apiContext.wallet,
          identityKey: me.identityKey,
          pay: async (requests) => {
            const r = await sendBsv.execute(withRepeatGuard(apiContext), { requests });
            if (r.error || !r.txid) throw new Error(String(r.error ?? 'The payment did not send.'));
            saveBought({ itemId: item.id, txid: r.txid, title: item.title });
            return r.txid;
          },
          client,
          fetchSealed: fetchBytes,
        },
        item,
      );
      saveBought({ itemId: item.id, txid, title: item.title });
      saveFile(photo, item.title);
      onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <>
      <SendConfirmation
        show
        theme={theme}
        lineItems={[
          {
            address: `"${item.title}" (${item.licence ?? 'personal'} licence)`,
            amount: money(item.priceSats ?? 0, rate),
          },
          { address: 'Paid to the photographer', amount: item.paymail || `${item.payAddress?.slice(0, 8)}…` },
        ]}
        total={moneyWithSats(item.priceSats ?? 0, rate)}
        isProcessing={busy}
        onConfirm={() => void buy()}
        onCancel={() => !busy && onClose()}
      />
      {msg && (
        <div
          className="fixed bottom-24 left-4 right-4 z-[1000] rounded-lg p-3 text-sm"
          style={{ background: '#1a1400', color: '#fff' }}
        >
          {msg}
        </div>
      )}
    </>
  );
};

const ReportPhoto = ({ item, onClose }: { item: MarketItem; onClose: () => void }) => {
  const [sent, setSent] = useState('');
  const send = (reason: ReportReason) =>
    publicClient()
      .report(item.id, reason)
      .then(() => setSent('Thanks. We review reports within 24 hours.'))
      .catch(() => setSent("Couldn't send the report. Try again."));
  return (
    <div
      className="fixed inset-0 z-[1000] flex items-end sm:items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-t-2xl sm:rounded-2xl p-4"
        style={{ background: '#141414' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold m-0 mb-3">Report "{item.title}"</h2>
        {sent ? (
          <Note>{sent}</Note>
        ) : (
          REPORT_REASONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => void send(id)}
              className="block w-full text-left px-3 py-2.5 mb-1 rounded-lg text-sm cursor-pointer border-0"
              style={{ background: '#1d1d1d', color: '#eee' }}
            >
              {label}
            </button>
          ))
        )}
        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full py-2 rounded-full border-0 cursor-pointer"
          style={{ background: '#222', color: '#ccc' }}
        >
          Close
        </button>
      </div>
    </div>
  );
};

// ── Art: vetted collections only ──

const ArtRail = () => {
  const [rows, setRows] = useState<Record<string, ArtItem[] | null>>({});
  const rate = useRate();
  useEffect(() => {
    for (const c of ART_COLLECTIONS) {
      fetch(artMarketUrl(c.id), { signal: AbortSignal.timeout(15_000) })
        .then((r) => (r.ok ? r.json() : []))
        .then((j) => setRows((m) => ({ ...m, [c.id]: parseArt(j, c.id) })))
        .catch(() => setRows((m) => ({ ...m, [c.id]: [] })));
    }
  }, []);
  return (
    <>
      <Note>Hand-picked on-chain art collections. Only collections we have checked are shown here.</Note>
      {ART_COLLECTIONS.map((c) => (
        <section key={c.id} className="mb-6">
          <h2 className="text-lg font-bold m-0">{c.name}</h2>
          <p className="text-xs m-0 mb-2" style={{ color: MUTED }}>
            {c.note} ·{' '}
            <a href={c.site} target="_blank" rel="noreferrer" style={{ color: GOLD }}>
              {new URL(c.site).hostname}
            </a>
          </p>
          {!rows[c.id] ? (
            <Note>Loading…</Note>
          ) : !rows[c.id]!.length ? (
            <Note>Nothing listed right now.</Note>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-2">
              {rows[c.id]!.map((a) => (
                <div key={a.outpoint} className="w-32 shrink-0">
                  <Thumb outpoint={a.origin} alt={a.name} />
                  <div className="text-xs mt-1 truncate">{a.name}</div>
                  {a.priceSats && (
                    <div className="text-xs" style={{ color: MUTED }}>
                      {money(a.priceSats, rate)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </>
  );
};

// ── Sell: one approval sheet ──

const Sell = ({ onListed }: { onListed: () => void }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const me = useMe();
  const rate = useRate();
  const fx = currentFx();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ base64: string } | null>(null);
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [licence, setLicence] = useState<Licence>('personal');
  const [price, setPrice] = useState({ unit: 'fiat' as 'fiat' | 'sats', value: '' });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const priceSats = priceToSats(price, rate, fx);
  const form = { title, tags, licence, priceSats };
  const problem = file ? validatePhoto(form, file.size) : 'Choose a photo.';
  const pay = chromeStorageService.getCurrentAccountObject().account?.addresses?.bsvAddress ?? '';
  const bytes = (preview?.base64.length ?? 0) * 0.75 + (file?.size ?? 0);
  const cost = file ? estimateCost(bytes, chromeStorageService.getCustomFeeRate(), rate) : null;

  const pick = async (f: File | undefined) => {
    setMsg('');
    setPreview(null);
    setFile(f ?? null);
    if (!f) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return setMsg('Choose a JPEG, PNG or WebP photo.');
    try {
      setPreview(await makePreview(f));
      if (!title) setTitle(f.name.replace(/\.[^.]+$/, '').slice(0, 100));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not read that photo.');
    }
  };

  const list = async () => {
    if (!apiContext?.wallet || !file || !preview || !me?.identityKey || !pay) return;
    setBusy(true);
    try {
      const r = await listPhoto(
        {
          wallet: apiContext.wallet,
          mint: (m) => mintMedia(withRepeatGuard(apiContext), m),
          client: await signedClient(apiContext),
        },
        {
          form,
          previewBase64: preview.base64,
          full: new Uint8Array(await file.arrayBuffer()),
          who: { pay, paymail: me.names.find((n) => n?.includes('@')) ?? '', idKey: me.identityKey },
          feeSats: cost?.feeSats ?? 0,
        },
      );
      setConfirming(false);
      setMsg(
        r.registered
          ? 'Minted and sent for review. It shows in Photos once a reviewer approves it.'
          : `Minted. ${r.note ?? ''} It is in your wallet either way.`,
      );
      onListed();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-lg flex flex-col gap-3">
      <Note>
        Your full-resolution photo is sealed (encrypted) on chain; buyers see a smaller watermarked preview. Buyers pay
        you directly. Every photo is reviewed before it shows publicly.
      </Note>
      <label className="flex items-center gap-2 cursor-pointer rounded-lg border p-3" style={{ borderColor: BORDER }}>
        <ImagePlus size={18} color={GOLD} />
        <span className="text-sm">{file ? file.name : 'Choose a photo'}</span>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
      </label>
      {preview && (
        <img
          src={`data:image/jpeg;base64,${preview.base64}`}
          alt="Preview"
          className="rounded-lg max-h-64 object-contain"
        />
      )}
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        className="rounded-lg px-3 py-2 bg-[#111] border text-white"
        style={{ borderColor: BORDER }}
      />
      <input
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        placeholder="Tags (sea, london, film)"
        className="rounded-lg px-3 py-2 bg-[#111] border text-white"
        style={{ borderColor: BORDER }}
      />
      <div className="flex gap-2" role="radiogroup" aria-label="Licence">
        {LICENCES.map((l) => (
          <Pill key={l} on={licence === l} onClick={() => setLicence(l)}>
            {l === 'personal' ? 'Personal' : 'Commercial'}
          </Pill>
        ))}
      </div>
      <p className="text-xs m-0" style={{ color: MUTED }}>
        {LICENCE_TEXT[licence]}
      </p>
      <div className="flex gap-2 items-center">
        <input
          value={price.value}
          inputMode="decimal"
          onChange={(e) => setPrice({ ...price, value: e.target.value })}
          placeholder={price.unit === 'fiat' ? `Price (${fiatSymbol(fx)})` : 'Price (sats)'}
          className="rounded-lg px-3 py-2 bg-[#111] border text-white flex-1"
          style={{ borderColor: BORDER }}
        />
        <Pill on={price.unit === 'fiat'} onClick={() => setPrice({ unit: 'fiat', value: '' })}>
          {fiatSymbol(fx)}
        </Pill>
        <Pill on={price.unit === 'sats'} onClick={() => setPrice({ unit: 'sats', value: '' })}>
          sats
        </Pill>
      </div>
      {priceSats && (
        <p className="text-xs m-0" style={{ color: MUTED }}>
          {moneyWithSats(priceSats, rate)}
        </p>
      )}
      <button
        type="button"
        disabled={!!problem || !preview || busy}
        onClick={() => setConfirming(true)}
        className="rounded-full py-2.5 font-bold border-0 cursor-pointer disabled:opacity-50"
        style={{ background: GOLD, color: '#1a1400' }}
      >
        {problem && file ? problem : 'Mint and list'}
      </button>
      {msg && <Note>{msg}</Note>}
      <SendConfirmation
        show={confirming}
        theme={theme}
        lineItems={[
          { address: `List "${title.trim()}" (${licence})`, amount: priceSats ? money(priceSats, rate) : '' },
          ...(cost ? [{ address: 'Network fee (est.)', amount: money(cost.networkSats, rate) }] : []),
          ...(cost && cost.feeSats > 0
            ? [{ address: 'bWalletX mint fee (1%)', amount: money(cost.feeSats, rate) }]
            : []),
        ]}
        total={cost ? moneyWithSats(cost.totalSats, rate) : undefined}
        isProcessing={busy}
        onConfirm={() => void list()}
        onCancel={() => !busy && setConfirming(false)}
      />
    </div>
  );
};

// ── Claim existing chain photos ──

const Claim = ({ onListed }: { onListed: () => void }) => {
  const { apiContext } = useServiceContext();
  const legacy = useLegacyKeys();
  const me = useMe();
  const [address, setAddress] = useState('');
  const [mine, setMine] = useState<{ origin: string; name: string }[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!address && legacy.addresses[0]) setAddress(legacy.addresses[0]);
  }, [address, legacy.addresses]);
  useEffect(() => {
    if (!apiContext) return;
    listOrdinals
      .execute(apiContext, { limit: 200 })
      .then((r) =>
        setMine(
          (r.outputs ?? [])
            .map((o) => {
              const tags = o.tags ?? [];
              const type = tags.find((t) => t.startsWith('type:'))?.slice(5) ?? '';
              const origin = tags.find((t) => t.startsWith('origin:'))?.slice(7) ?? o.outpoint.replace('.', '_');
              const name = tags.find((t) => t.startsWith('name:'))?.slice(5) ?? 'Photo';
              return /^image\/(png|jpe?g|gif|webp|avif)$/i.test(type) ? { origin, name } : null;
            })
            .filter((x): x is { origin: string; name: string } => !!x),
        ),
      )
      .catch(() => setMine([]));
  }, [apiContext]);
  const claim = async () => {
    if (!apiContext || !me?.identityKey || !address || !picked.length) return;
    setBusy(true);
    setMsg('');
    try {
      const r = await claimChainPhotos(
        { identityKey: me.identityKey, sign: legacy.sign, client: await signedClient(apiContext) },
        address,
        picked,
      );
      setMsg(
        `${r.listed.length} sent for review.${r.refused.length ? ` ${r.refused.length} not listed: ${r.refused[0].error}.` : ''}`,
      );
      setPicked([]);
      onListed();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 max-w-2xl">
      <Note>
        Posted photos on chain before? Prove the address they were minted to (your wallet signs a short message with
        that address's key) and list them here. Only photos minted to that address can be listed, and each is reviewed.
      </Note>
      <div className="flex gap-2 flex-wrap">
        {legacy.addresses.map((a) => (
          <Pill key={a} on={address === a} onClick={() => setAddress(a)}>
            {a.slice(0, 6)}…{a.slice(-4)}
          </Pill>
        ))}
      </div>
      {!mine.length ? (
        <Note>No pictures in this wallet to claim.</Note>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {mine.map((m) => {
            const on = picked.includes(m.origin);
            return (
              <button
                key={m.origin}
                type="button"
                aria-pressed={on}
                onClick={() => setPicked((p) => (on ? p.filter((x) => x !== m.origin) : [...p, m.origin]))}
                className="p-0 border-2 rounded-lg cursor-pointer bg-transparent"
                style={{ borderColor: on ? GOLD : 'transparent' }}
              >
                <Thumb outpoint={m.origin} alt={m.name} />
              </button>
            );
          })}
        </div>
      )}
      <button
        type="button"
        disabled={!picked.length || busy}
        onClick={() => void claim()}
        className="rounded-full py-2.5 font-bold border-0 cursor-pointer disabled:opacity-50"
        style={{ background: GOLD, color: '#1a1400' }}
      >
        {busy ? 'Signing…' : `Claim ${picked.length || ''} photo${picked.length === 1 ? '' : 's'}`}
      </button>
      {msg && <Note>{msg}</Note>}
    </div>
  );
};

// ── Mine / Bought ──

const Mine = ({ refresh }: { refresh: number }) => {
  const { apiContext } = useServiceContext();
  const [items, setItems] = useState<MarketItem[] | null>(null);
  const rate = useRate();
  useEffect(() => {
    if (!apiContext) return;
    signedClient(apiContext)
      .then((c) => c.mine())
      .then(setItems)
      .catch(() => setItems([]));
  }, [apiContext, refresh]);
  if (!items) return <Note>Loading…</Note>;
  if (!items.length) return <Note>Nothing listed yet. Use Sell or Claim.</Note>;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {items.map((it) => (
        <div key={it.id}>
          <Thumb outpoint={it.id} alt={it.title} />
          <div className="text-sm font-semibold truncate mt-1">{it.title}</div>
          <div className="text-xs" style={{ color: it.status === 'approved' ? GOLD : MUTED }}>
            {STATUS_LABEL[it.status]}
            {it.status !== 'approved' && it.status !== 'rejected' ? ' · only you can see this' : ''}
            {it.paidSats > 0 ? ` · ${money(it.paidSats, rate)} earned` : ''}
          </div>
        </div>
      ))}
    </div>
  );
};

const BoughtList = () => {
  const { apiContext } = useServiceContext();
  const [msg, setMsg] = useState('');
  const bought = useMemo(loadBought, []);
  const open = async (b: Bought) => {
    if (!apiContext) return;
    setMsg('Opening…');
    try {
      const client = await signedClient(apiContext);
      const photo = await unlockPhoto(
        { wallet: apiContext.wallet, client, fetchSealed: fetchBytes },
        { id: b.itemId } as MarketItem,
        b.txid,
        { retries: 1 },
      );
      saveFile(photo, b.title);
      setMsg('');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  if (!bought.length) return <Note>Photos you buy appear here, ready to download again.</Note>;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {bought.map((b) => (
        <button
          key={b.itemId}
          type="button"
          onClick={() => void open(b)}
          className="text-left bg-transparent border-0 p-0 cursor-pointer text-white"
        >
          <Thumb outpoint={b.itemId} alt={b.title} />
          <div className="text-sm font-semibold truncate mt-1">{b.title}</div>
          <div className="text-xs" style={{ color: GOLD }}>
            Download full size
          </div>
        </button>
      ))}
      {msg && <Note>{msg}</Note>}
    </div>
  );
};

const MarketPage = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>(() => {
    const t = window.location.pathname.split('/').pop() as Tab;
    return TABS.some(([id]) => id === t) ? t : 'photos';
  });
  const [refresh, setRefresh] = useState(0);
  const listed = useCallback(() => setRefresh((n) => n + 1), []);
  return (
    <div className="min-h-full text-white" style={{ background: '#0b0b0b' }}>
      <div
        className="sticky top-0 z-10 px-4 pt-3 pb-3 border-b"
        style={{ background: 'rgba(11,11,11,0.92)', borderColor: '#1f1a0a' }}
      >
        <div className="max-w-[1200px] mx-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label="Back"
            className="bg-transparent border-0 cursor-pointer p-1 -ml-1"
          >
            <ArrowLeft size={20} color="#ddd" />
          </button>
          <span className="font-bold text-xl tracking-tight" style={{ color: GOLD }}>
            bPics market
          </span>
        </div>
        <div className="max-w-[1200px] mx-auto flex gap-1 mt-2 overflow-x-auto" role="tablist">
          {TABS.map(([id, label]) => (
            <Pill key={id} on={tab === id} onClick={() => setTab(id)}>
              {label}
            </Pill>
          ))}
        </div>
      </div>
      <div className="max-w-[1200px] mx-auto px-4 pt-4 pb-24">
        {tab === 'photos' && <PhotosFeed />}
        {tab === 'art' && <ArtRail />}
        {tab === 'sell' && <Sell onListed={listed} />}
        {tab === 'claim' && <Claim onListed={listed} />}
        {tab === 'mine' && <Mine refresh={refresh} />}
        {tab === 'bought' && <BoughtList />}
      </div>
    </div>
  );
};
export default MarketPage;
