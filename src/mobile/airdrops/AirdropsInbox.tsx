/**
 * Wallet › Airdrops: tokens and NFTs that arrived unsolicited (inbox.ts). Keep / Hide per item. Nothing in
 * here renders inscription markup or opens issuer links (notes are React text, links never clickable): NFTs show a resized image or a placeholder that
 * previews in a fully sandboxed iframe (no scripts, opaque origin) only on tap.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Coins, EyeOff, FileCode, Flag, ShieldAlert } from 'lucide-react';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { avatarFor } from '../chat/avatars';
import { requestChatRoom } from '../chat/nav';
import { requestDm } from '../chat/segmentNav';
import { tokenKey } from '../chat/tokenRooms';
import { safeName } from '../feed/language';
import { IssuerBadge } from '../issuer/IssuerBadge';
import { useIssuer } from '../issuer/useIssuer';
import { STORE_BUILD, tokenRoomsEnabled } from '../storeBuild';
import { ReportSheet } from '../ugc/UgcSheets';
import { thumbUrl } from '../market/thumbs';
import { SwipeRow } from '../swipe/SwipeRow';
import { showUndo } from '../swipe/undo';
import { hide, keep, markSeen, type AirdropItem } from './inbox';
import { trustIssuer } from './quarantine';
import { keptIssuers, noteSegments, noteView, replyDraft } from './note';
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

/** The issuer: avatar + $handle (verified badge for tokens) or a short address. */
const useIssuerName = (item: AirdropItem) => {
  const info = useIssuer(item.asset.kind === 'token' ? item.asset.id : null);
  const handle = info?.status === 'verified' && info.handle ? info.handle.replace(/^\$/, '') : null;
  return {
    handle,
    verified: info?.status === 'verified',
    label: handle ? `$${safeName(handle)}` : short(item.from || item.issuer),
  };
};

const Avatar = ({ handle }: { handle: string | null }) => {
  const url = handle ? avatarFor(handle) : null;
  const [bad, setBad] = useState(false);
  if (url && !bad)
    return <img src={url} alt="" onError={() => setBad(true)} className="w-9 h-9 rounded-full object-cover shrink-0" />;
  return (
    <div className="w-9 h-9 rounded-full bg-[#2b2f36] flex items-center justify-center shrink-0 text-sm font-bold text-white">
      {handle ? handle[0].toUpperCase() : '?'}
    </div>
  );
};

/** The note as plain text: React text nodes only, links shown but never clickable. */
const NoteBody = ({ text, issuerKept, label }: { text: string; issuerKept: boolean; label: string }) => {
  const v = noteView(text, { issuerKept, store: STORE_BUILD });
  const [open, setOpen] = useState(!v.collapsed);
  const [reveal, setReveal] = useState(false);
  if (v.language === 'hide-final')
    return (
      <p className="text-[11px] italic m-0" style={{ color: MUTED }}>
        Note hidden by the language filter.
      </p>
    );
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-left text-[11px] underline"
        style={{ color: MUTED }}
      >
        Note from {label}: show
      </button>
    );
  const blurred = v.language === 'blur' && !reveal;
  return (
    <div
      className="rounded-lg px-3 py-2 text-[13px] leading-snug text-white whitespace-pre-wrap break-words"
      style={{ background: '#22252c' }}
    >
      <span style={blurred ? { filter: 'blur(5px)', userSelect: 'none' } : undefined}>
        {noteSegments(text).map((seg, n) =>
          seg.link ? (
            <span key={n} style={{ color: '#9fb3c8' }} title="Links in notes are never opened by the wallet">
              {seg.text}
            </span>
          ) : (
            <span key={n}>{seg.text}</span>
          ),
        )}
      </span>
      {blurred && (
        <button
          type="button"
          onClick={() => setReveal(true)}
          className="block text-[11px] underline mt-1"
          style={{ color: MUTED }}
        >
          Strong language: show anyway
        </button>
      )}
    </div>
  );
};

const Row = ({
  item,
  issuerKept,
  onKeep,
  onHide,
  onTrust,
  onLeave,
}: {
  item: AirdropItem;
  issuerKept: boolean;
  onKeep: () => void;
  onHide: () => void;
  onTrust: () => void;
  onLeave: () => void;
}) => {
  const { handleSelect } = useBottomMenu();
  const who = useIssuerName(item);
  const [reporting, setReporting] = useState(false);
  const symbol = item.asset.kind === 'token' ? item.asset.symbol : undefined;
  const reply = () => {
    if (!who.handle) return;
    requestDm(who.handle, replyDraft(symbol));
    handleSelect(asMenuItem('chat'));
    onLeave();
  };
  const roomKey = item.asset.kind === 'token' && tokenRoomsEnabled() ? tokenKey('bsv21', item.asset.id) : null;
  const room = roomKey
    ? () => {
        requestChatRoom(roomKey);
        handleSelect(asMenuItem('chat'));
        onLeave();
      }
    : null;
  const small = 'min-h-[44px] rounded-lg px-3.5 py-2 text-sm font-semibold bg-[#2b2f36] text-white';
  return (
    <div className="flex flex-col gap-2 rounded-xl px-3 py-3" style={{ background: CARD }}>
      <div className="flex items-center gap-2">
        <Avatar handle={who.handle} />
        <div className="min-w-0 flex-1 flex flex-col">
          <span className="text-sm font-semibold text-white overflow-hidden text-ellipsis whitespace-nowrap">
            {who.label}
          </span>
          {item.asset.kind === 'token' ? (
            <IssuerBadge tokenId={item.asset.id} compact />
          ) : (
            <span className="text-[11px]" style={{ color: MUTED }}>
              Unverified sender
            </span>
          )}
        </div>
        <span className="text-[10px] shrink-0" style={{ color: '#667085' }}>
          {new Date(item.time).toLocaleDateString()}
        </span>
      </div>
      {item.note && <NoteBody text={item.note} issuerKept={issuerKept} label={who.label} />}
      <div className="flex items-center gap-3">
        {item.asset.kind === 'nft' ? (
          <NftThumb id={item.asset.id} />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-[#2b2f36] flex items-center justify-center shrink-0">
            <Coins size={18} color={MUTED} />
          </div>
        )}
        <div className="min-w-0 flex-1 text-sm font-semibold text-white overflow-hidden text-ellipsis whitespace-nowrap">
          {item.asset.kind === 'nft'
            ? 'NFT'
            : `${item.asset.qty ? `${Number(item.asset.qty).toLocaleString()} ` : ''}$${item.asset.symbol ?? short(item.asset.id)}`}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onKeep}
          className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-bold"
          style={{ background: GOLD, color: '#010101' }}
        >
          Keep
        </button>
        <button type="button" onClick={onHide} className={small}>
          Hide
        </button>
        <button type="button" onClick={onTrust} className={small}>
          Trust this sender
        </button>
        {who.handle && (
          <button type="button" onClick={reply} className={small}>
            Reply
          </button>
        )}
        {room && (
          <button type="button" onClick={room} className={small}>
            Open room
          </button>
        )}
        <button type="button" onClick={() => setReporting(true)} className={small} aria-label="Report issuer">
          <Flag size={12} />
        </button>
      </div>
      {reporting && (
        <ReportSheet
          title={`Report ${who.label}`}
          report={{
            kind: 'user',
            target: who.handle ? `$${who.handle}` : item.issuer,
            content: item.note,
            details: `airdrop tx ${item.txid}; issuer ${item.issuer}`,
          }}
          onClose={() => setReporting(false)}
          onSent={() => {
            setReporting(false);
            onHide();
          }}
        />
      )}
    </div>
  );
};

/** The unstamped items (airdrops) list, shown inside bMail › Requests. */
export const AirdropsList = ({ onLeave }: { onLeave: () => void }) => {
  const { items, visible, state, loading, error, update } = useAirdrops();
  const known = keptIssuers(items, state.kept);
  // Opening the mailbox clears the badge (items stay listed until Keep or Hide).
  useEffect(() => update((s) => markSeen(s)), [update]);
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex gap-2 rounded-xl p-3 text-[11px] leading-relaxed"
        style={{ background: '#2a1408', color: '#FEC84B' }}
      >
        <ShieldAlert size={16} className="shrink-0 mt-0.5" />
        <span>
          Quarantined tokens and NFTs: sent to you without asking. They are not in your balance and are never spent with
          your own coins. Keep moves one into your holdings (it stays at the same address); Hide keeps it here, out of
          sight, with everything else from that sender. Never enter your recovery words on a site a token sends you to.
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
        <p className="text-xs text-center py-4 m-0" style={{ color: MUTED }}>
          {loading ? 'Checking your history…' : 'No unstamped items.'}
        </p>
      )}
      {visible.map((i) => {
        // Swipe (bMail rows): left = Hide (undoable), right = Keep (undoable). Buttons stay on the card too.
        const doKeep = () => {
          update((s) => keep(s, i.key));
          showUndo('Kept', () => update((s) => ({ ...s, kept: s.kept.filter((k) => k !== i.key) })));
        };
        const doHide = () => {
          const issuerWasHidden = state.hiddenIssuers.includes(i.issuer);
          update((s) => hide(s, i));
          showUndo('Hidden', () =>
            update((s) => ({
              ...s,
              hidden: s.hidden.filter((k) => k !== i.key),
              hiddenIssuers: issuerWasHidden ? s.hiddenIssuers : s.hiddenIssuers.filter((x) => x !== i.issuer),
            })),
          );
        };
        const label = i.asset.kind === 'token' ? `$${i.asset.symbol ?? short(i.asset.id)} airdrop` : 'NFT airdrop';
        return (
          <SwipeRow
            key={i.key}
            rowId={i.key}
            label={label}
            leftActions={[
              {
                id: 'hide',
                label: 'Hide',
                icon: <EyeOff size={18} />,
                color: '#D92D20',
                removes: true,
                onPress: doHide,
              },
            ]}
            rightActions={[
              {
                id: 'keep',
                label: 'Keep',
                icon: <Check size={18} />,
                color: '#12B76A',
                removes: true,
                onPress: doKeep,
              },
            ]}
            fullSwipeLeft="hide"
            fullSwipeRight="keep"
          >
            <Row
              item={i}
              issuerKept={known.has(i.issuer)}
              onLeave={onLeave}
              onKeep={() => update((s) => keep(s, i.key))}
              onTrust={() => {
                update((s) => trustIssuer(keep(s, i.key), i.issuer));
                showUndo('Trusted: their tokens skip Quarantine', () =>
                  update((s) => ({
                    ...s,
                    kept: s.kept.filter((k) => k !== i.key),
                    trustedIssuers: (s.trustedIssuers ?? []).filter((x) => x !== i.issuer),
                  })),
                );
              }}
              onHide={() => update((s) => hide(s, i))}
            />
          </SwipeRow>
        );
      })}
    </div>
  );
};
