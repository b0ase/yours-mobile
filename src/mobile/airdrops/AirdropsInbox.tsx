/**
 * Wallet › Airdrops: tokens and NFTs that arrived unsolicited (inbox.ts). Keep / Hide per item. Nothing in
 * here renders inscription markup or opens issuer links: NFTs show a resized image or a placeholder that
 * previews in a fully sandboxed iframe (no scripts, opaque origin) only on tap.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Coins, FileCode, Gift, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { IssuerBadge } from '../issuer/IssuerBadge';
import { thumbUrl } from '../market/thumbs';
import { hide, keep, markSeen, type AirdropItem } from './inbox';
import { useAirdrops } from './useAirdrops';

const CARD = '#17191E';
const MUTED = '#98A2B3';
const GOLD = '#FFD24D';
const short = (s: string) => (s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);

const NftThumb = ({ id }: { id: string }) => {
  const [bad, setBad] = useState(false);
  const [preview, setPreview] = useState(false);
  const url = thumbUrl(id);
  if (url && !bad)
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        onError={() => setBad(true)}
        className="w-12 h-12 rounded-lg object-cover bg-[#2b2f36] shrink-0"
      />
    );
  return (
    <>
      <button
        type="button"
        onClick={() => setPreview(true)}
        className="w-12 h-12 rounded-lg bg-[#2b2f36] flex flex-col items-center justify-center shrink-0 text-[8px] leading-tight text-[#98A2B3]"
        title="HTML content: tap to preview in sandbox"
      >
        <FileCode size={14} />
        tap to preview
      </button>
      {preview &&
        createPortal(
          <div className="fixed inset-0 z-[260] bg-black/80 flex flex-col p-4 gap-2" onClick={() => setPreview(false)}>
            <p className="text-[11px] text-[#98A2B3] m-0">
              Sandboxed preview: scripts are off and it can&apos;t reach your wallet. Tap outside to close.
            </p>
            <iframe
              title="Sandboxed preview"
              src={`https://ordfs.network/${id.replace('.', '_')}`}
              sandbox=""
              referrerPolicy="no-referrer"
              className="flex-1 w-full rounded-xl bg-white"
            />
          </div>,
          document.body,
        )}
    </>
  );
};

const Row = ({ item, onKeep, onHide }: { item: AirdropItem; onKeep: () => void; onHide: () => void }) => (
  <div className="flex items-center gap-3 rounded-xl px-3 py-3" style={{ background: CARD }}>
    {item.asset.kind === 'nft' ? (
      <NftThumb id={item.asset.id} />
    ) : (
      <div className="w-12 h-12 rounded-lg bg-[#2b2f36] flex items-center justify-center shrink-0">
        <Coins size={18} color={MUTED} />
      </div>
    )}
    <div className="min-w-0 flex-1 flex flex-col gap-0.5">
      <div className="text-sm font-semibold text-white overflow-hidden text-ellipsis whitespace-nowrap">
        {item.asset.kind === 'nft'
          ? 'NFT'
          : `${item.asset.qty ? `${Number(item.asset.qty).toLocaleString()} ` : ''}$${item.asset.symbol ?? short(item.asset.id)}`}
      </div>
      {item.asset.kind === 'token' ? (
        <IssuerBadge tokenId={item.asset.id} compact />
      ) : (
        <span className="text-[11px]" style={{ color: MUTED }}>
          Unverified sender
        </span>
      )}
      <span className="text-[10px]" style={{ color: '#667085' }}>
        {item.from ? `From ${short(item.from)} · ` : ''}
        {new Date(item.time).toLocaleDateString()}
      </span>
    </div>
    <div className="flex flex-col gap-1 shrink-0">
      <button
        type="button"
        onClick={onKeep}
        className="rounded-lg px-3 py-1 text-xs font-bold"
        style={{ background: GOLD, color: '#010101' }}
      >
        Keep
      </button>
      <button
        type="button"
        onClick={onHide}
        className="rounded-lg px-3 py-1 text-xs font-semibold bg-[#2b2f36] text-white"
      >
        Hide
      </button>
    </div>
  </div>
);

export const AirdropsInbox = ({ onClose }: { onClose: () => void }) => {
  const { visible, state, loading, error, refresh, update } = useAirdrops();
  useBackClose(true, onClose);
  // Opening the inbox clears the badge (items stay listed until Keep or Hide).
  useEffect(() => update((s) => markSeen(s)), [update]);

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex flex-col overflow-y-auto"
      style={{ background: '#0d0e11', paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <Gift size={18} color={GOLD} />
        <h2 className="text-base font-bold text-white flex-1 m-0">Airdrops</h2>
        <button type="button" aria-label="Refresh" onClick={() => refresh(true)} className="p-1">
          <RefreshCw size={16} color={MUTED} className={loading ? 'animate-spin' : ''} />
        </button>
        <button type="button" aria-label="Close" onClick={onClose} className="p-1">
          <X size={18} color={MUTED} />
        </button>
      </div>
      <div className="flex flex-col gap-2 px-4 pb-24">
        <div
          className="flex gap-2 rounded-xl p-3 text-[11px] leading-relaxed"
          style={{ background: '#2a1408', color: '#FEC84B' }}
        >
          <ShieldAlert size={16} className="shrink-0 mt-0.5" />
          <span>
            Tokens and NFTs people sent you without asking. Never interact with a token that asks you to visit a site
            and enter your recovery words. Hiding one hides everything from that sender.
          </span>
        </div>
        <label className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
          <input
            type="checkbox"
            checked={state.onlyKnown}
            onChange={(e) => update((s) => ({ ...s, onlyKnown: e.target.checked }))}
          />
          Only show airdrops from issuers I&apos;ve kept before
        </label>
        {error && <p className="text-xs text-[#F97066] m-0">{error}</p>}
        {!visible.length && (
          <p className="text-xs text-center py-10 m-0" style={{ color: MUTED }}>
            {loading ? 'Checking your history…' : 'No new airdrops.'}
          </p>
        )}
        {visible.map((i) => (
          <Row
            key={i.key}
            item={i}
            onKeep={() => update((s) => keep(s, i.key))}
            onHide={() => update((s) => hide(s, i))}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
};
