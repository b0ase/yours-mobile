import { useEffect, useMemo, useRef, useState } from 'react';
import { useBackClose } from '../backStack';
import { createPortal } from 'react-dom';
import { inscribe, listOrdinals, mintCollection, mintCollectionItem } from '@1sat/actions';
import { Coins, ExternalLink, Image as ImageIcon, Sparkles, Ticket, X } from 'lucide-react';
import { SendConfirmation } from '../../components/SendConfirmation';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { getOutputName } from '../../utils/format';
import { TicketMint } from '../tickets/TicketMint';
import { TokenMint } from '../tokens/TokenMint';
import { TOKEN_COPY } from '../tokens/token';
import {
  ACCEPT,
  BLOCKED_MESSAGE,
  blockedText,
  buildMap,
  checkSize,
  collectionIdFrom,
  DOWNSCALE_SUGGEST_BYTES,
  estimateCost,
  fileToBase64,
  formatBytes,
  isMintableType,
  MINT_APP,
  notifyMinted,
  validateForm,
  withFeeOutput,
  wocTxUrl,
  type Collection,
} from './mint';
import { money, moneyWithSats } from '../money/money';

/**
 * "Mint" — gold button beside Receive / Send on the Wallet tab (build-time insert into
 * BsvWallet.tsx, vite.config.mobile.ts). Opens a sheet: Mint a chatroom (a ticket:
 * src/mobile/tickets/TicketMint.tsx), Mint a token (src/mobile/tokens/TokenMint.tsx; every token
 * has a room) or Mint media (NFT).
 *
 * Inscribes through upstream's @1sat/actions with the wallet's own apiContext:
 *   inscribe (no collection) · mintCollection + mintCollectionItem (new collection) ·
 *   mintCollectionItem (existing collection). Nothing is broadcast until the user confirms
 *   the wallet's standard SendConfirmation sheet.
 *
 * List-for-sale is NOT offered: upstream has OrdLock listing creation disabled
 * (ORDLOCK_LISTING_DISABLED in src/utils/cancelOrdLockListings.ts). Re-add once it returns.
 */
const GOLD = '#FFD24D';
const PANEL = '#17191E';
const BORDER = '#3a2f0c';

type Step = 'choose' | 'ticket' | 'token' | 'media' | 'done';
type Picked = { file: File; url: string };

const downscale = async (file: File, maxEdge = 2048, quality = 0.85): Promise<File> => {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not shrink this image');
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
};

export const MintButton = ({ exchangeRate = 0 }: { exchangeRate?: number }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* Secondary dark outline pill beside the gold Receive / Send (mobile.css .bw-pill). */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="order-3 flex flex-1 items-center justify-center gap-2 py-3 font-semibold text-sm outline-none cursor-pointer bw-pill bw-pill-outline"
      >
        <Sparkles size={16} strokeWidth={2.5} />
        Mint
      </button>
      {open && createPortal(<MintSheet exchangeRate={exchangeRate} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
};

const MintSheet = ({ exchangeRate, onClose }: { exchangeRate: number; onClose: () => void }) => {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const [step, setStep] = useState<Step>('choose');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [fileError, setFileError] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [collKind, setCollKind] = useState<Collection['kind']>('none');
  const [newColl, setNewColl] = useState('');
  const [existingId, setExistingId] = useState('');
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([]);
  const [formError, setFormError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [txid, setTxid] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => void (picked && URL.revokeObjectURL(picked.url)), [picked]);

  // The wallet's own collections (parents it holds), for "Add to existing collection".
  useEffect(() => {
    if (step !== 'media') return;
    listOrdinals
      .execute(apiContext, { tags: ['subType:collection'], limit: 100, offset: 0 })
      .then(({ outputs }) =>
        setCollections(
          outputs.map((o) => ({ id: o.outpoint.replace('.', '_'), name: getOutputName(o, 'Collection') })),
        ),
      )
      .catch(() => setCollections([]));
  }, [step, apiContext]);

  const collection: Collection = useMemo(() => {
    if (collKind === 'new') return { kind: 'new', name: newColl };
    if (collKind === 'existing') {
      const c = collections.find((x) => x.id === existingId);
      return c ? { kind: 'existing', id: c.id, name: c.name } : { kind: 'none' };
    }
    return { kind: 'none' };
  }, [collKind, newColl, existingId, collections]);

  const satsPerKb = chromeStorageService.getCustomFeeRate();
  const cost = picked
    ? estimateCost(picked.file.size, satsPerKb, exchangeRate, { newCollection: collection.kind === 'new' })
    : null;

  const pick = (file: File | undefined) => {
    setFileError('');
    if (!file) return;
    if (!isMintableType(file.type)) return setFileError('Pick a photo, image, video or audio file.');
    const size = checkSize(file.size);
    if (!size.ok && !file.type.startsWith('image/')) return setFileError(size.message);
    if (!size.ok) setFileError(size.message);
    setPicked({ file, url: URL.createObjectURL(file) });
    if (!title) setTitle(file.name.replace(/\.\w+$/, '').slice(0, 100));
  };

  const shrink = async () => {
    if (!picked) return;
    try {
      const small = await downscale(picked.file);
      const size = checkSize(small.size);
      setFileError(size.ok ? '' : size.message);
      setPicked({ file: small, url: URL.createObjectURL(small) });
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'Could not shrink this image');
    }
  };

  const review = () => {
    if (!picked) return setFormError('Pick a file to mint.');
    const size = checkSize(picked.file.size);
    if (!size.ok) return setFormError(size.message);
    if (collKind === 'existing' && collection.kind !== 'existing') return setFormError('Choose a collection.');
    const err = validateForm({ title, description, collection });
    setFormError(err ?? '');
    if (!err) setConfirming(true);
  };

  const mint = async () => {
    if (!picked || !cost) return;
    // Re-check at the moment of broadcast (texts may have been edited).
    if (blockedText({ title, description, collection })) {
      setConfirming(false);
      return setFormError(BLOCKED_MESSAGE);
    }
    setBusy(true);
    try {
      const base64Content = fileToBase64(await picked.file.arrayBuffer());
      const contentType = picked.file.type;
      const name = title.trim();
      let res: { txid?: string; error?: string };
      if (collection.kind === 'none') {
        res = await inscribe.execute(withFeeOutput(apiContext, cost.feeSats), {
          base64Content,
          contentType,
          map: buildMap({ title, description, collection }),
        });
      } else {
        let collectionId = collection.kind === 'existing' ? collection.id : '';
        if (collection.kind === 'new') {
          const c = await mintCollection.execute(apiContext, {
            base64Content,
            contentType,
            name: collection.name.trim(),
            description: description.trim(),
            quantity: 1000,
            app: MINT_APP,
          });
          if (!c.txid || c.error) throw new Error(c.error || 'Collection mint failed');
          collectionId = collectionIdFrom(c.txid, c.collectionId);
        }
        res = await mintCollectionItem.execute(withFeeOutput(apiContext, cost.feeSats), {
          base64Content,
          contentType,
          name,
          collectionId,
          app: MINT_APP,
        });
      }
      if (!res.txid || res.error) throw new Error(res.error || 'Mint failed');
      setTxid(res.txid);
      setConfirming(false);
      setStep('done');
      notifyMinted();
    } catch (e) {
      setConfirming(false);
      setFormError(e instanceof Error ? e.message : 'Mint failed');
    } finally {
      setBusy(false);
    }
  };

  const kind = picked?.file.type.split('/')[0];
  const input = 'w-full rounded-xl px-3 py-2 text-sm outline-none border bg-transparent';
  const inputStyle = { borderColor: BORDER, color: '#fff' };

  return (
    // z above the bottom tab bar (BottomMenu z-[100]) so the sheet's lower options aren't hidden.
    <div className="fixed inset-0 z-[150] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div
        className="w-full max-w-md rounded-t-2xl p-4 overflow-y-auto"
        style={{
          background: PANEL,
          color: '#fff',
          maxHeight: 'calc(100dvh - env(safe-area-inset-top) - 24px)',
          paddingBottom: 'calc(16px + env(safe-area-inset-bottom))',
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="font-bold text-lg" style={{ color: GOLD }}>
            {step === 'ticket'
              ? 'Mint a chatroom'
              : step === 'token'
                ? 'Mint a token'
                : step === 'choose'
                  ? 'Mint'
                  : step === 'done'
                    ? 'Minted'
                    : 'Mint media'}
          </span>
          <button type="button" onClick={onClose} className="bg-transparent border-0 cursor-pointer" aria-label="Close">
            <X size={20} color="#aaa" />
          </button>
        </div>

        {step === 'choose' && (
          <div className="flex flex-col gap-3">
            <Choice
              icon={<Ticket size={18} />}
              title="Mint a chatroom"
              sub="Mint tickets that grant entry to your new chatrooms."
              onClick={() => setStep('ticket')}
            />
            <Choice icon={<Coins size={18} />} title="Mint a token" sub={TOKEN_COPY} onClick={() => setStep('token')} />
            <Choice
              icon={<ImageIcon size={18} />}
              title="Mint media (NFT)"
              sub="Photo, image, drawing, video or audio"
              onClick={() => setStep('media')}
            />
          </div>
        )}

        {step === 'ticket' && (
          <TicketMint exchangeRate={exchangeRate} onBack={() => setStep('choose')} onClose={onClose} />
        )}

        {step === 'token' && (
          <TokenMint exchangeRate={exchangeRate} onBack={() => setStep('choose')} onClose={onClose} />
        )}

        {step === 'media' && (
          <div className="flex flex-col gap-3 text-sm">
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => pick(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="rounded-xl border border-dashed py-4 cursor-pointer bg-transparent"
              style={{ borderColor: GOLD, color: GOLD }}
            >
              {picked ? 'Choose a different file' : 'Choose photo, video or audio'}
            </button>
            <p className="text-xs" style={{ color: '#999' }}>
              Don't mint anything you don't own or that's illegal — inscriptions are permanent.
            </p>
            {picked && (
              <div className="rounded-xl overflow-hidden border" style={{ borderColor: BORDER }}>
                {kind === 'image' && (
                  <img src={picked.url} alt="" className="w-full max-h-64 object-contain bg-black" />
                )}
                {kind === 'video' && (
                  <video src={picked.url} controls playsInline className="w-full max-h-64 bg-black" />
                )}
                {kind === 'audio' && <audio src={picked.url} controls className="w-full" />}
                <div className="px-3 py-2 text-xs" style={{ color: '#bbb' }}>
                  {picked.file.type} · {formatBytes(picked.file.size)}
                  {kind === 'image' && picked.file.size > DOWNSCALE_SUGGEST_BYTES && (
                    <button
                      type="button"
                      onClick={shrink}
                      className="ml-2 bg-transparent border-0 cursor-pointer underline"
                      style={{ color: GOLD }}
                    >
                      Shrink photo (cheaper)
                    </button>
                  )}
                </div>
              </div>
            )}
            {fileError && <p style={{ color: '#ff6b6b' }}>{fileError}</p>}

            <input
              className={input}
              style={inputStyle}
              placeholder="Title (required)"
              value={title}
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              className={input}
              style={inputStyle}
              placeholder="Description"
              rows={3}
              value={description}
              maxLength={1000}
              onChange={(e) => setDescription(e.target.value)}
            />
            <select
              className={input}
              style={{ ...inputStyle, background: PANEL }}
              value={collKind}
              onChange={(e) => setCollKind(e.target.value as Collection['kind'])}
            >
              <option value="none">No collection</option>
              <option value="new">New collection…</option>
              {collections.length > 0 && <option value="existing">Add to my collection…</option>}
            </select>
            {collKind === 'new' && (
              <input
                className={input}
                style={inputStyle}
                placeholder="Collection name"
                value={newColl}
                maxLength={100}
                onChange={(e) => setNewColl(e.target.value)}
              />
            )}
            {collKind === 'existing' && (
              <select
                className={input}
                style={{ ...inputStyle, background: PANEL }}
                value={existingId}
                onChange={(e) => setExistingId(e.target.value)}
              >
                <option value="">Choose a collection</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            {cost && (
              <p className="text-xs" style={{ color: '#bbb' }}>
                Estimated network fee: {money(cost.networkSats, exchangeRate)}
                {cost.txCount > 1 ? ' (2 transactions: collection + item)' : ''}
                {cost.feeSats > 0 && <> · bWallet mint fee (1%): {money(cost.feeSats, exchangeRate)}</>} · Total ≈{' '}
                {moneyWithSats(cost.totalSats, exchangeRate)}
              </p>
            )}
            {formError && <p style={{ color: '#ff6b6b' }}>{formError}</p>}
            <button
              type="button"
              onClick={review}
              className="h-11 rounded-xl font-bold border-0 cursor-pointer"
              style={{ background: `linear-gradient(135deg, #FFE27A, #E0A800)`, color: '#1a1400' }}
            >
              Review mint
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col gap-3 text-sm">
            <p>"{title.trim()}" was inscribed. It will appear in Media shortly.</p>
            <a
              href={wocTxUrl(txid)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 break-all"
              style={{ color: GOLD }}
            >
              {txid} <ExternalLink size={12} />
            </a>
            <button
              type="button"
              onClick={onClose}
              className="h-11 rounded-xl font-bold border cursor-pointer bg-transparent"
              style={{ borderColor: BORDER, color: GOLD }}
            >
              Done
            </button>
          </div>
        )}
      </div>

      <SendConfirmation
        show={confirming}
        theme={theme}
        lineItems={[
          { address: `Inscribe "${title.trim()}"`, amount: picked ? formatBytes(picked.file.size) : '' },
          ...(cost ? [{ address: 'Network fee (est.)', amount: `${money(cost.networkSats, exchangeRate)}` }] : []),
          ...(cost && cost.feeSats > 0
            ? [{ address: 'bWallet mint fee (1%)', amount: `${money(cost.feeSats, exchangeRate)}` }]
            : []),
        ]}
        total={cost ? moneyWithSats(cost.totalSats, exchangeRate) : undefined}
        isProcessing={busy}
        onConfirm={() => void mint()}
        onCancel={() => !busy && setConfirming(false)}
      />
    </div>
  );
};

const Choice = ({
  icon,
  title,
  sub,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="flex items-center gap-3 p-4 rounded-xl border text-left cursor-pointer bg-transparent"
    style={{ borderColor: BORDER, color: '#fff' }}
  >
    <span style={{ color: GOLD }}>{icon}</span>
    <span className="flex flex-col">
      <span className="font-bold">{title}</span>
      <span className="text-xs" style={{ color: '#999' }}>
        {sub}
      </span>
    </span>
  </button>
);
