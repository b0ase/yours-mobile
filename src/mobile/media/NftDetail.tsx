import { useState } from 'react';
import { createPortal } from 'react-dom';
import validate from 'bitcoin-address-validation';
import { sendOrdinals } from '@1sat/actions';
import { readAssetIdTag } from '@1sat/types';
import { Copy, ExternalLink, Send, UserCircle, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import type { ChromeStorageObject } from '../../services/types/chromeStorage.types';
import { getTagValue } from '../../utils/format';
import { getErrorMessage } from '../../utils/tools';
import { NameInput } from '../names/NameInput';
import { setLocalAvatar } from '../names/avatar';
import { nftAvatarUri, normalizeOutpoint, ordinalsUrl } from './nftActions';
import type { MediaItem } from './useWalletMedia';

const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';
const short = (s: string) => (s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s);

/**
 * Wallet › NFTs detail: big viewer, name / collection / origin, and actions:
 * Set as my avatar (account icon = 1sat://<origin>, as AccountIconField does for a pasted NFT id),
 * Send (sendOrdinals, like upstream's Ordinals manager, to an address / $handle / paymail).
 * Listing an NFT for sale is not offered: OrdLock listing creation is disabled for ordinals
 * (ORDLOCK_LISTING_DISABLED); bWallet's Sell covers BSV-21 only. Portalled like MediaViewer.
 */
export const NftDetail = ({ item, onClose, onSent }: { item: MediaItem; onClose: () => void; onSent: () => void }) => {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const origin = normalizeOutpoint(item.origin) || normalizeOutpoint(item.output.outpoint);
  const collection = getTagValue(item.output.tags, 'collection') || getTagValue(item.output.tags, 'collectionId');
  const link = ordinalsUrl(origin);
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [to, setTo] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(origin);
      setMsg('Copied');
    } catch {
      setMsg(origin);
    }
  };

  const setAvatar = async () => {
    const uri = nftAvatarUri(origin);
    const account = chromeStorageService.getCurrentAccountObject().account;
    const id = account?.addresses?.identityAddress;
    if (!uri || !account || !id) return setMsg("Couldn't set the avatar.");
    try {
      const key: keyof ChromeStorageObject = 'accounts';
      await chromeStorageService.updateNested(key, { [id]: { ...account, icon: uri } } as Partial<
        ChromeStorageObject['accounts']
      >);
      // A photo picked on this phone wins over the account icon: clear it (this also fires notifyAvatarChange).
      setLocalAvatar(id, '');
      setMsg('This NFT is now your avatar.');
    } catch {
      setMsg("Couldn't set the avatar.");
    }
  };

  const send = async () => {
    const assetId = readAssetIdTag(item.output.tags);
    if (!assetId) return setMsg('This NFT is missing a tracking id and cannot be sent yet. Try Refresh.');
    setBusy(true);
    try {
      const res = await sendOrdinals.execute(apiContext, { transfers: [{ id: assetId, address: to }] });
      if (!res.txid || res.error) throw new Error(getErrorMessage(res.error));
      setMsg(`Sent. ${short(res.txid)}`);
      setSending(false);
      setConfirm(false);
      onSent();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setBusy(false);
    }
  };

  const validTo = !!to && validate(to);
  const btn = 'flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold';

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-black overflow-y-auto"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <span className={`text-sm font-semibold text-white ${ELLIPSIS}`}>{item.name}</span>
        <button aria-label="Close" onClick={onClose} className="p-2">
          <X size={20} color="#fff" />
        </button>
      </div>
      <div className="flex items-center justify-center bg-[#0b0c0f]" style={{ minHeight: '45vh', maxHeight: '60vh' }}>
        {item.kind === 'video' && <video src={item.url} controls playsInline className="max-w-full max-h-[60vh]" />}
        {item.kind === 'images' && (
          <img
            src={item.url}
            alt={item.name}
            className="max-w-full max-h-[60vh] object-contain"
            style={{ imageRendering: 'pixelated' }}
          />
        )}
        {item.kind === 'music' && <audio src={item.url} controls className="w-[90%]" />}
        {item.kind === 'other' && (
          <iframe src={item.url} title={item.name} sandbox="" className="w-full h-[50vh] bg-white" />
        )}
      </div>

      <div className="px-4 py-4 flex flex-col gap-3">
        <div>
          <div className="text-lg font-semibold text-white">{item.name}</div>
          {collection && <div className="text-xs text-[#98A2B3]">Collection {short(collection)}</div>}
          <div className="text-[11px] text-[#667085]">{item.type ?? 'unknown type'}</div>
        </div>
        <div className="flex items-center gap-2 rounded-xl bg-[#17191E] px-3 py-2">
          <span className="text-[11px] text-[#98A2B3] shrink-0">Origin</span>
          <span className={`text-[11px] text-white flex-1 ${ELLIPSIS}`}>{origin}</span>
          <button aria-label="Copy origin" onClick={() => void copy()} className="p-1">
            <Copy size={14} color="#98A2B3" />
          </button>
          {link && (
            <a href={link} target="_blank" rel="noreferrer" aria-label="View on 1satordinals.com" className="p-1">
              <ExternalLink size={14} color="#98A2B3" />
            </a>
          )}
        </div>

        {item.kind === 'images' && (
          <button onClick={() => void setAvatar()} className={`${btn} bg-[#A1FF8B] text-[#010101]`}>
            <UserCircle size={16} /> Set as my avatar
          </button>
        )}
        {!sending ? (
          <button onClick={() => setSending(true)} className={`${btn} bg-[#17191E] text-white`}>
            <Send size={16} /> Send
          </button>
        ) : (
          <div className="flex flex-col gap-2 rounded-xl bg-[#17191E] p-3">
            <NameInput
              theme={theme}
              value={to}
              asset="token"
              onChange={(v) => {
                setTo(v);
                setConfirm(false);
              }}
              style={{ width: '100%', margin: 0 }}
            />
            {to && !validTo && <p className="text-xs text-[#F97066]">Not a valid address.</p>}
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setSending(false);
                  setConfirm(false);
                  setTo('');
                }}
                className={`${btn} flex-1 bg-[#2b2f36] text-white`}
              >
                Cancel
              </button>
              <button
                disabled={!validTo || busy}
                onClick={() => (confirm ? void send() : setConfirm(true))}
                className={`${btn} flex-1 text-[#010101] disabled:opacity-40`}
                style={{ background: confirm ? '#FFD24D' : '#A1FF8B' }}
              >
                {busy ? 'Sending…' : confirm ? `Confirm send to ${short(to)}` : 'Send'}
              </button>
            </div>
          </div>
        )}
        {msg && <p className="text-xs text-[#98A2B3] break-all">{msg}</p>}
      </div>
    </div>,
    document.body,
  );
};
