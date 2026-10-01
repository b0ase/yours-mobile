import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowUp, Coins, Lock, MessageCircle, RefreshCw, Search, ShoppingCart, Trophy, UserPlus, WifiOff, X } from 'lucide-react';
import { sendBsv, sendBsv21 } from '@1sat/actions';
import { TopNav } from '../../components/TopNav';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isNative } from '../native';
import { BchatClient, ChatApiError, defaultHttp, loadSession, saveSession } from '../chat/api';
import { walletSigner } from '../chat/signer';
import { proveHoldings, walletHoldings } from '../chat/holdings';
import { onTokenNav, requestMarketToken, takeChatRoom } from '../chat/nav';
import {
  amountLabel,
  buildTokenRoomList,
  holdLine,
  parseGateRefusal,
  parseInvitee,
  parseLookup,
  parseTokenKey,
  type GateRefusal,
  type Holding,
  type TokenGate,
  type TokenRoomEntry,
  type TokenRoomLookup,
} from '../chat/tokenRooms';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useSnackbar } from '../../hooks/useSnackbar';
import { getErrorMessage } from '../../utils/tools';
import { asMenuItem } from './tabs';
import {
  avatarHue,
  latestCursor,
  listTimeLabel,
  mergeMessages,
  oldestCursor,
  previewText,
  roomInitial,
  roomTitle,
  threadItems,
  timeLabel,
  type ChatMessage,
  type ChatRoom,
} from '../chat/messages';
import {
  claimCheck,
  loadSeen,
  markSeen,
  parseBounties,
  parseSpec,
  rewardLabel,
  saveSeen,
  showPay,
  sortBounties,
  transferLabel,
  unseenForMe,
  type Bounty,
  type PayoutSpec,
} from '../chat/bounties';

/**
 * Chat tab: TOKEN ROOMS ONLY (owner decision; docs/TOKEN-ROOMS.md). The list is one room per
 * BSV-21 token / 1Sat collection this wallet holds at or above the room minimum — buy a token
 * and its room appears; sell it and the room goes. No DMs, no contacts, no new-chat-by-handle.
 * Rooms list → conversation → back, all inside this tab; the conversation covers the bottom bar.
 * Talks to bitcoinchat.online's API with a session the wallet gets by signing
 * bChat's wallet-login challenge (../chat/api.ts). Live updates by polling
 * (4s in an open conversation, 30s on the list) until realtime lands in v2.
 */
const GOLD = '#FFD24D';
const BG = '#010101';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';
const LIST_POLL_MS = 30_000;
const THREAD_POLL_MS = 4_000;
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

const useOnline = () => {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
};

/** Runs `fn` every `ms` while the page is visible. */
const usePoll = (fn: () => void, ms: number, enabled: boolean) => {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const tick = () => document.visibilityState === 'visible' && ref.current();
    const id = window.setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [ms, enabled]);
};

const Avatar = ({ title, size = 48 }: { title: string; size?: number }) => {
  const hue = avatarHue(title);
  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0 font-bold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        color: `hsl(${hue} 70% 82%)`,
        background: `linear-gradient(145deg, hsl(${hue} 35% 26%), hsl(${hue} 30% 14%))`,
        border: `1px solid hsl(${hue} 30% 30% / 0.6)`,
      }}
    >
      {roomInitial(title)}
    </div>
  );
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ───────────────────────────── Conversation ─────────────────────────────

const Conversation = ({
  client,
  room,
  me,
  online,
  onBack,
  onAuthLost,
  entry,
  onLocked,
  onInvite,
  onBounties,
}: {
  client: BchatClient;
  room: ChatRoom;
  me: string;
  online: boolean;
  onBack: () => void;
  onAuthLost: () => void;
  entry: TokenRoomEntry | null;
  /** The server refused: you no longer hold enough (or never did). */
  onLocked: (refusal: GateRefusal) => void;
  onInvite: (() => void) | null;
  onBounties: () => void;
}) => {
  const bountyBadge = useBountyBadge(client, room.ticker, me);
  const title = room.name || (entry ? `$${entry.gate.symbol}` : roomTitle(room, me));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prependAnchor = useRef<number | null>(null);
  const localSeq = useRef(0);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ChatApiError && e.status === 401) return onAuthLost();
      const refusal = e instanceof ChatApiError && e.status === 403 ? parseGateRefusal(e.data) : null;
      if (refusal) return onLocked(refusal);
      setError(errText(e));
    },
    [onAuthLost, onLocked],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    client
      .latestPage(room.ticker)
      .then((p) => {
        if (!live) return;
        setMessages(mergeMessages([], p.messages));
        setHasMore(p.hasMore);
        setError('');
        void client.markRead(room.ticker).catch(() => {});
      })
      .catch((e) => live && fail(e))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [client, room.ticker, fail]);

  const poll = useCallback(() => {
    const cursor = latestCursor(messages);
    if (!cursor || !online) return;
    client
      .since(room.ticker, cursor)
      .then((fresh) => {
        if (!fresh.length) return;
        setMessages((cur) => mergeMessages(cur, fresh));
        void client.markRead(room.ticker).catch(() => {});
      })
      .catch(() => {});
  }, [client, room.ticker, messages, online]);
  usePoll(poll, THREAD_POLL_MS, !loading);

  const loadOlder = useCallback(() => {
    const before = oldestCursor(messages);
    if (!before || !hasMore || loadingOlder) return;
    setLoadingOlder(true);
    prependAnchor.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null;
    client
      .page(room.ticker, { before })
      .then((p) => {
        setMessages((cur) => mergeMessages(cur, p.messages));
        setHasMore(p.hasMore);
      })
      .catch(fail)
      .finally(() => setLoadingOlder(false));
  }, [client, room.ticker, messages, hasMore, loadingOlder, fail]);

  // Keep position when older messages are prepended; otherwise follow the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prependAnchor.current !== null) {
      el.scrollTop = el.scrollHeight - prependAnchor.current;
      prependAnchor.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 120) loadOlder();
  };

  const send = (text: string, existing?: ChatMessage) => {
    const body = text.trim();
    if (!body) return;
    const localId = existing?.localId ?? `l${Date.now()}-${++localSeq.current}`;
    const optimistic: ChatMessage = {
      id: `local:${localId}`,
      localId,
      author_handle: me,
      kind: 'text',
      body,
      created_at: new Date().toISOString(),
      pending: true,
    };
    stickToBottom.current = true;
    setMessages((cur) => cur.filter((m) => m.localId !== localId).concat(optimistic));
    if (!existing) setDraft('');
    client
      .send(room.ticker, body)
      .then((saved) => setMessages((cur) => (saved ? mergeMessages(cur, [saved]) : cur)))
      .catch((e) => {
        setMessages((cur) => cur.map((m) => (m.localId === localId ? { ...m, failed: true } : m)));
        if (e instanceof ChatApiError && e.status === 401) onAuthLost();
        const refusal = e instanceof ChatApiError && e.status === 403 ? parseGateRefusal(e.data) : null;
        if (refusal) onLocked(refusal);
      });
  };

  const items = useMemo(() => threadItems(messages, me), [messages, me]);
  const direct = false;
  const members = room.party_count ?? entry?.members ?? 0;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col" style={{ background: BG }}>
      <div
        className="flex items-center gap-3 px-2 pb-2 shrink-0"
        style={{
          paddingTop: 'calc(env(safe-area-inset-top) + 8px)',
          background: 'linear-gradient(180deg, #16140c 0%, #0b0b0b 100%)',
          borderBottom: `1px solid ${LINE}`,
        }}
      >
        <button onClick={onBack} className="p-2 rounded-full active:opacity-60" aria-label="Back">
          <ArrowLeft size={22} color={GOLD} />
        </button>
        <Avatar title={title} size={38} />
        <div className="flex-1 min-w-0">
          <div className={`text-[15px] font-semibold text-white ${ELLIPSIS}`}>{title}</div>
          <div className="text-[11px]" style={{ color: MUTED }}>
            {!online
              ? 'waiting for network…'
              : entry
                ? `${entry.gate.key.startsWith('coll:') ? entry.gate.symbol : `$${entry.gate.symbol}`} · ${members} holder${members === 1 ? '' : 's'} · you hold ${amountLabel(entry.holding.amountRaw, entry.gate)}`
                : `${members} member${members === 1 ? '' : 's'} · $${room.ticker}`}
          </div>
        </div>
        <button onClick={onBounties} className="relative p-2 rounded-full active:opacity-60" aria-label="Bounties">
          <Trophy size={20} color={GOLD} />
          {bountyBadge > 0 && (
            <span
              className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold flex items-center justify-center"
              style={{ background: '#F97066', color: '#fff' }}
            >
              {bountyBadge}
            </span>
          )}
        </button>
        {onInvite && (
          <button onClick={onInvite} className="p-2 rounded-full active:opacity-60" aria-label="Invite">
            <UserPlus size={20} color={GOLD} />
          </button>
        )}
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-2"
        style={{ background: 'radial-gradient(120% 60% at 50% 0%, #15130b 0%, #050505 60%)' }}
      >
        {loadingOlder && (
          <div className="text-center text-[11px] py-2" style={{ color: MUTED }}>
            Loading earlier messages…
          </div>
        )}
        {hasMore === false && messages.length > 0 && (
          <div className="text-center text-[11px] py-2" style={{ color: MUTED }}>
            Beginning of conversation
          </div>
        )}
        {loading && (
          <div className="text-center text-xs pt-10" style={{ color: MUTED }}>
            Loading…
          </div>
        )}
        {!loading && error && (
          <div className="text-center text-xs pt-10 text-[#F97066]">
            {error}
            <div>
              <button onClick={onBack} className="mt-3 underline" style={{ color: GOLD }}>
                Back to chats
              </button>
            </div>
          </div>
        )}
        {!loading && !error && messages.length === 0 && (
          <div className="text-center text-xs pt-16" style={{ color: MUTED }}>
            No messages yet. Start the first scene.
          </div>
        )}
        {items.map((it) =>
          it.type === 'day' ? (
            <div key={it.key} className="flex justify-center my-3">
              <span className="text-[11px] px-3 py-1 rounded-full" style={{ background: '#1a1a1a', color: '#c9c3ad' }}>
                {it.label}
              </span>
            </div>
          ) : it.message.kind === 'event' ? (
            <div key={it.key} className="flex justify-center my-2">
              <span
                className="text-[11px] px-3 py-1 rounded-xl text-center max-w-[85%]"
                style={{ background: '#141414', color: MUTED }}
              >
                {it.message.body || 'Room update'}
              </span>
            </div>
          ) : (
            <div
              key={it.key}
              className={`flex ${it.mine ? 'justify-end' : 'justify-start'} ${it.firstOfGroup ? 'mt-2' : 'mt-[3px]'}`}
            >
              <div
                className="max-w-[80%] px-3 py-[7px] text-[15px] leading-snug"
                style={{
                  borderRadius: 18,
                  borderBottomRightRadius: it.mine ? 6 : 18,
                  borderBottomLeftRadius: it.mine ? 18 : 6,
                  background: it.mine ? 'linear-gradient(160deg, #FFD24D 0%, #E9B21A 100%)' : PANEL,
                  color: it.mine ? '#1a1300' : '#f2f2f2',
                  border: it.mine ? 'none' : `1px solid ${LINE}`,
                  opacity: it.message.pending && !it.message.failed ? 0.75 : 1,
                }}
              >
                {!it.mine && !direct && it.firstOfGroup && it.message.author_handle && (
                  <div
                    className="text-[12px] font-semibold mb-[2px]"
                    style={{ color: `hsl(${avatarHue(it.message.author_handle)} 70% 72%)` }}
                  >
                    ${it.message.author_handle}
                  </div>
                )}
                <span className="whitespace-pre-wrap break-words">{it.message.body}</span>
                <span className="text-[10px] ml-2 float-right mt-[6px]" style={{ color: it.mine ? '#5c4800' : MUTED }}>
                  {it.message.edited ? 'edited · ' : ''}
                  {it.message.failed ? (
                    <button className="underline text-[#b42318]" onClick={() => send(it.message.body || '', it.message)}>
                      failed · retry
                    </button>
                  ) : it.message.pending ? (
                    'sending…'
                  ) : (
                    timeLabel(it.message.created_at)
                  )}
                </span>
              </div>
            </div>
          ),
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
        className="flex items-end gap-2 px-3 pt-2 shrink-0"
        style={{
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 8px)',
          background: '#0b0b0b',
          borderTop: `1px solid ${LINE}`,
        }}
      >
        {/* v2 hook: attachment / voice note / video note buttons go here (rooms/[ticker]/media). */}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !isNative) {
              e.preventDefault();
              send(draft);
            }
          }}
          rows={1}
          maxLength={4000}
          placeholder={online ? 'Message' : 'Offline'}
          className="flex-1 resize-none rounded-2xl px-4 py-[9px] text-[15px] text-white outline-none max-h-32"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          aria-label="Send"
          className="h-10 w-10 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40"
          style={{ background: GOLD }}
        >
          <ArrowUp size={20} color="#1a1300" strokeWidth={2.6} />
        </button>
      </form>
    </div>
  );
};

// ───────────────────────────── Sheets ─────────────────────────────

const Sheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => 
  // Portal to body + z above BottomMenu (z-[100]): the room view's z-[60] layer would trap it under the tab bar.
  createPortal(
  <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
    <div
      className="w-full rounded-t-3xl px-5 pt-4"
      style={{ background: '#0e0e0e', borderTop: `1px solid ${LINE}`, paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-white font-semibold">{title}</span>
        <button onClick={onClose} aria-label="Close" className="p-1">
          <X size={20} color={MUTED} />
        </button>
      </div>
      {children}
    </div>
  </div>,
    document.body,
  )

/** A room you can't enter: "Hold 1 $FILM to join" + Buy in Market. */
const LockedRoom = ({
  gate,
  heldRaw,
  members,
  onBuy,
  onClose,
}: {
  gate: TokenGate;
  heldRaw: string | null;
  members: number | null;
  onBuy: () => void;
  onClose: () => void;
}) => (
  <Sheet title={gate.key.startsWith('coll:') ? gate.symbol : `$${gate.symbol} room`} onClose={onClose}>
    <div className="flex flex-col items-center text-center gap-2 pb-2">
      <div className="h-14 w-14 rounded-2xl flex items-center justify-center" style={{ background: '#1a1408', border: '1px solid #3a2f0c' }}>
        <Lock size={24} color={GOLD} />
      </div>
      <p className="text-base font-bold text-white">{holdLine(gate)}</p>
      <p className="text-xs" style={{ color: MUTED }}>
        {members !== null ? `${members} holder${members === 1 ? '' : 's'} in this room. ` : ''}
        {heldRaw && heldRaw !== '0' ? `You hold ${amountLabel(heldRaw, gate)}.` : 'Holding the token is your membership.'}
      </p>
      <button
        onClick={onBuy}
        className="mt-2 w-full rounded-2xl py-3 font-bold flex items-center justify-center gap-2"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        <ShoppingCart size={16} /> Buy in Market
      </button>
    </div>
  </Sheet>
);

/**
 * Invite = send the room token. Resolves $handle → their proven receive address (bit-sign), then
 * asks the wallet to send exactly the room minimum. Nothing is sent until the user confirms here,
 * and the wallet's own approval for the transaction still applies.
 */
const InviteSheet = ({
  client,
  ticker,
  entry,
  onClose,
}: {
  client: BchatClient;
  ticker: string;
  entry: TokenRoomEntry;
  onClose: () => void;
}) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [input, setInput] = useState('');
  const [target, setTarget] = useState<{ label: string; address: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const amount = amountLabel(entry.gate.minRaw, entry.gate);

  const resolve = async () => {
    const who = parseInvitee(input);
    if (!who) return setError('Enter a $handle or a BSV address');
    setError('');
    if ('address' in who) return setTarget({ label: `${who.address.slice(0, 8)}…`, address: who.address });
    setBusy('Looking up…');
    try {
      const address = await client.inviteAddress(ticker, who.handle);
      setTarget({ label: `$${who.handle}`, address });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const send = async () => {
    if (!target) return;
    setBusy('Sending…');
    setError('');
    try {
      const res = await sendBsv21.execute(apiContext, {
        tokenId: entry.holding.id,
        recipients: [{ amount: BigInt(entry.gate.minRaw), destination: { address: target.address } }],
      });
      if (!res.txid || res.error) throw new Error(getErrorMessage(res.error));
      addSnackbar(`Invited ${target.label} — sent ${amount}`, 'success');
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <Sheet title="Invite to this room" onClose={onClose}>
      {!target ? (
        <>
          <p className="text-xs mb-3" style={{ color: MUTED }}>
            An invite is the room token: you send {amount} and they're in.
          </p>
          <div className="flex items-center gap-2 rounded-2xl px-3" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && resolve()}
              placeholder="$handle or address"
              autoCapitalize="none"
              autoCorrect="off"
              className="flex-1 bg-transparent py-3 text-white outline-none"
            />
          </div>
          <button
            onClick={resolve}
            disabled={!!busy || !input.trim()}
            className="w-full mt-4 rounded-2xl py-3 font-bold disabled:opacity-50"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            {busy || 'Next'}
          </button>
        </>
      ) : (
        <>
          <div className="rounded-2xl p-4 text-sm" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
            <div className="flex justify-between">
              <span style={{ color: MUTED }}>Send</span>
              <span className="text-white font-semibold">{amount}</span>
            </div>
            <div className="flex justify-between mt-2">
              <span style={{ color: MUTED }}>To</span>
              <span className="text-white font-semibold">{target.label}</span>
            </div>
            <div className="text-[11px] mt-2 break-all" style={{ color: MUTED }}>
              {target.address}
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={() => setTarget(null)} disabled={!!busy} className="flex-1 rounded-2xl py-3 font-bold text-white" style={{ background: PANEL }}>
              Back
            </button>
            <button
              onClick={send}
              disabled={!!busy}
              className="flex-1 rounded-2xl py-3 font-bold disabled:opacity-50"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              {busy || `Send ${amount}`}
            </button>
          </div>
        </>
      )}
      {error && <p className="text-xs text-[#F97066] mt-2">{error}</p>}
    </Sheet>
  );
};

// ───────────────────────────── Bounties ─────────────────────────────

/** Count of my bounties that turned merged / paid since I last opened the Bounties sheet. */
const useBountyBadge = (client: BchatClient, ticker: string, me: string) => {
  const [count, setCount] = useState(0);
  const check = useCallback(() => {
    client
      .bounties(ticker)
      .then((d) => setCount(unseenForMe(ticker, parseBounties(d), me, loadSeen()).length))
      .catch(() => undefined);
  }, [client, ticker, me]);
  useEffect(() => {
    check();
    window.addEventListener('bwallet:bounties-seen', check);
    return () => window.removeEventListener('bwallet:bounties-seen', check);
  }, [check]);
  usePoll(check, LIST_POLL_MS, true);
  return count;
};

const STATUS_COLOR: Record<string, string> = { open: '#32D583', claimed: '#FFD24D', merged: '#53B1FD', paid: '#8a8f98' };

/**
 * Bounties sheet: open / claimed / merged / paid, with reward. Claim = paste the PR URL. Pay
 * (room admin / treasury holder) = fetch the server's transfer spec, confirm here, and the wallet
 * sends it with its normal approval; the txid is posted back and the bounty becomes paid.
 */
const BountiesSheet = ({
  client,
  room,
  entry,
  me,
  onClose,
}: {
  client: BchatClient;
  room: ChatRoom;
  entry: TokenRoomEntry | null;
  me: string;
  onClose: () => void;
}) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [bounties, setBounties] = useState<Bounty[] | null>(null);
  const [error, setError] = useState('');
  const [claiming, setClaiming] = useState<Bounty | null>(null);
  const [prUrl, setPrUrl] = useState('');
  const [agent, setAgent] = useState('');
  const [paying, setPaying] = useState<PayoutSpec | null>(null);
  const [busy, setBusy] = useState('');
  const token = entry && entry.key.startsWith('bsv21:') ? { symbol: entry.gate.symbol, dec: entry.gate.dec } : null;
  const isAdmin = String((room as { created_by_handle?: unknown }).created_by_handle ?? '') === me;

  const load = useCallback(async () => {
    try {
      const list = sortBounties(parseBounties(await client.bounties(room.ticker)));
      setBounties(list);
      saveSeen(markSeen(room.ticker, list, loadSeen()));
      window.dispatchEvent(new Event('bwallet:bounties-seen'));
    } catch (e) {
      setError(errText(e));
      setBounties([]);
    }
  }, [client, room.ticker]);
  useEffect(() => {
    load();
  }, [load]);

  const claim = async () => {
    if (!claiming) return;
    const why = claimCheck(claiming, me, prUrl);
    if (why) return setError(why);
    setBusy('Claiming…');
    setError('');
    try {
      await client.claimBounty(room.ticker, claiming.bounty_no, prUrl, agent);
      addSnackbar(`Claimed #${claiming.bounty_no}`, 'success');
      setClaiming(null);
      setPrUrl('');
      setAgent('');
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const startPay = async (b: Bounty) => {
    setBusy('Preparing…');
    setError('');
    try {
      const spec = parseSpec(await client.bountyPayoutSpec(room.ticker, b.bounty_no));
      if (!spec) throw new Error('The server returned no payable transfer');
      setPaying(spec);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const pay = async () => {
    if (!paying) return;
    setBusy('Sending…');
    setError('');
    let confirmed = false;
    try {
      for (const t of paying.transfers) {
        const res =
          t.type === 'bsv21'
            ? await sendBsv21.execute(apiContext, {
                tokenId: t.tokenId,
                recipients: [{ amount: BigInt(t.amountRaw), destination: { address: t.address } }],
              })
            : await sendBsv.execute(apiContext, { requests: [{ address: t.address, satoshis: t.sats }] });
        if (!res.txid || res.error) throw new Error(getErrorMessage(res.error));
        // Record the FIRST broadcast at once, so a failure on a later leg can never lead to paying twice.
        if (!confirmed) {
          await client.confirmBountyPayout(room.ticker, paying.bountyNo, res.txid);
          confirmed = true;
        }
      }
      addSnackbar(`Paid #${paying.bountyNo} to $${paying.claimant}`, 'success');
      setPaying(null);
      await load();
    } catch (e) {
      setError(confirmed ? `Recorded as paid, but a later transfer failed: ${errText(e)}` : errText(e));
      if (confirmed) await load();
    } finally {
      setBusy('');
    }
  };

  if (paying) {
    return (
      <Sheet title={`Pay bounty #${paying.bountyNo}`} onClose={onClose}>
        <div className="rounded-2xl p-4 text-sm" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
          {paying.transfers.map((t, i) => (
            <div key={i} className="flex justify-between mt-1">
              <span style={{ color: MUTED }}>Send</span>
              <span className="text-white font-semibold">{transferLabel(t)}</span>
            </div>
          ))}
          <div className="flex justify-between mt-2">
            <span style={{ color: MUTED }}>To</span>
            <span className="text-white font-semibold">${paying.claimant}</span>
          </div>
          <div className="text-[11px] mt-2 break-all" style={{ color: MUTED }}>
            {paying.transfers[0].address}
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={() => setPaying(null)} disabled={!!busy} className="flex-1 rounded-2xl py-3 font-bold text-white" style={{ background: PANEL }}>
            Back
          </button>
          <button onClick={pay} disabled={!!busy} className="flex-1 rounded-2xl py-3 font-bold disabled:opacity-50" style={{ background: GOLD, color: '#1a1300' }}>
            {busy || 'Pay'}
          </button>
        </div>
        {error && <p className="text-xs text-[#F97066] mt-2">{error}</p>}
      </Sheet>
    );
  }

  if (claiming) {
    return (
      <Sheet title={`Claim #${claiming.bounty_no}`} onClose={onClose}>
        <p className="text-xs mb-3" style={{ color: MUTED }}>
          {claiming.title} — {rewardLabel(claiming, token)}. Paid to your proven receive address when the PR merges.
        </p>
        <input
          autoFocus
          value={prUrl}
          onChange={(e) => setPrUrl(e.target.value)}
          placeholder="https://github.com/owner/repo/pull/123"
          autoCapitalize="none"
          autoCorrect="off"
          className="w-full rounded-2xl px-3 py-3 bg-transparent text-white outline-none"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        />
        <input
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          placeholder="Agent (optional, e.g. claude)"
          autoCapitalize="none"
          className="w-full mt-2 rounded-2xl px-3 py-3 bg-transparent text-white outline-none"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        />
        <div className="flex gap-2 mt-4">
          <button onClick={() => setClaiming(null)} disabled={!!busy} className="flex-1 rounded-2xl py-3 font-bold text-white" style={{ background: PANEL }}>
            Back
          </button>
          <button onClick={claim} disabled={!!busy || !prUrl.trim()} className="flex-1 rounded-2xl py-3 font-bold disabled:opacity-50" style={{ background: GOLD, color: '#1a1300' }}>
            {busy || 'Claim'}
          </button>
        </div>
        {error && <p className="text-xs text-[#F97066] mt-2">{error}</p>}
      </Sheet>
    );
  }

  return (
    <Sheet title="Bounties" onClose={onClose}>
      <div className="max-h-[60vh] overflow-y-auto flex flex-col gap-2">
        {bounties === null && <p className="text-xs" style={{ color: MUTED }}>Loading…</p>}
        {bounties?.length === 0 && !error && <p className="text-xs" style={{ color: MUTED }}>No bounties in this room yet.</p>}
        {bounties?.map((b) => (
          <div key={b.bounty_no} className="rounded-2xl p-3" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold uppercase" style={{ color: STATUS_COLOR[b.status] ?? MUTED }}>
                {b.status}
              </span>
              <span className={`flex-1 text-sm text-white ${ELLIPSIS}`}>
                #{b.bounty_no} {b.title}
              </span>
            </div>
            <div className="text-xs mt-1" style={{ color: GOLD }}>
              {rewardLabel(b, token)}
            </div>
            {b.claimed_by && (
              <div className="text-[11px] mt-1" style={{ color: MUTED }}>
                ${b.claimed_by}
                {b.agent_label ? ` via ${b.agent_label}` : ''}
                {b.github_pr_url ? ` · ${b.github_pr_url.replace('https://github.com/', '')}` : ''}
              </div>
            )}
            {b.status === 'open' && b.created_by !== me && (
              <button onClick={() => { setError(''); setClaiming(b); }} className="mt-2 w-full rounded-xl py-2 text-sm font-bold" style={{ background: GOLD, color: '#1a1300' }}>
                Claim with PR
              </button>
            )}
            {showPay(b, me, isAdmin) && (
              <button onClick={() => startPay(b)} disabled={!!busy} className="mt-2 w-full rounded-xl py-2 text-sm font-bold disabled:opacity-50" style={{ background: GOLD, color: '#1a1300' }}>
                {busy || 'Pay'}
              </button>
            )}
          </div>
        ))}
      </div>
      {error && <p className="text-xs text-[#F97066] mt-2">{error}</p>}
    </Sheet>
  );
};

// ───────────────────────────── Token rooms list ─────────────────────────────

const LOOKUP_TTL_MS = 5 * 60_000;

const ChatPage = () => {
  const { apiContext } = useServiceContext();
  const { handleSelect } = useBottomMenu();
  const online = useOnline();
  const client = useMemo(() => new BchatClient(defaultHttp(isNative), loadSession()), []);
  const [handle, setHandle] = useState<string | null>(client.handle);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState('');
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null);
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [lookups, setLookups] = useState<Record<string, TokenRoomLookup>>({});
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<{ room: ChatRoom; entry: TokenRoomEntry | null } | null>(null);
  const [locked, setLocked] = useState<{ gate: TokenGate; heldRaw: string | null; members: number | null } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [showBounties, setShowBounties] = useState(false);
  const [opening, setOpening] = useState('');
  const autoTried = useRef(false);
  const proved = useRef<Set<string>>(new Set());
  const lookedAt = useRef<Map<string, number>>(new Map());

  const signIn = useCallback(async () => {
    setSigningIn(true);
    setAuthError('');
    try {
      const s = await client.signIn(walletSigner(apiContext));
      saveSession(s);
      setHandle(s.handle);
    } catch (e) {
      setAuthError(errText(e));
    } finally {
      setSigningIn(false);
    }
  }, [client, apiContext]);

  const authLost = useCallback(() => {
    client.signOut();
    saveSession(null);
    setHandle(null);
    setOpen(null);
    setRooms(null);
  }, [client]);

  useEffect(() => {
    const saved = client.current;
    if (!saved) return;
    walletSigner(apiContext)
      .address()
      .then((a) => a !== saved.address && authLost())
      .catch(() => {});
  }, [client, apiContext, authLost]);

  useEffect(() => {
    if (handle || autoTried.current || !online) return;
    autoTried.current = true;
    void signIn();
  }, [handle, online, signIn]);

  /** Prove this wallet's token keys to bChat (once per key per visit; signatures only). */
  const prove = useCallback(
    async (key?: string) => {
      const tag = key ?? '*';
      if (proved.current.has(tag)) return;
      proved.current.add(tag);
      await proveHoldings(apiContext, client, key).catch(() => proved.current.delete(tag));
    },
    [apiContext, client],
  );

  // Once signed in: link the wallet's keys so bChat can see what it holds.
  useEffect(() => {
    if (handle) void prove();
  }, [handle, prove]);

  const refresh = useCallback(() => {
    if (!handle || !online) return;
    void walletHoldings(apiContext)
      .then(setHoldings)
      .catch(() => setHoldings([]));
    client
      .rooms()
      .then((r) => {
        setRooms(r);
        setListError('');
      })
      .catch((e) => {
        if (e instanceof ChatApiError && e.status === 401) return authLost();
        setListError(errText(e));
      });
  }, [client, apiContext, handle, online, authLost]);

  useEffect(refresh, [refresh]);
  usePoll(refresh, LIST_POLL_MS, !!handle && !open);

  // Rooms you hold the token for but are not in yet: ask bChat whether they exist.
  useEffect(() => {
    if (!handle || !holdings || !rooms) return;
    const mine = new Set(buildTokenRoomList(holdings, rooms).filter((e) => e.status === 'member').map((e) => e.key));
    const now = Date.now();
    const todo = holdings
      .map((h) => `${h.kind}:${h.id}`)
      .filter((k) => !mine.has(k) && now - (lookedAt.current.get(k) ?? 0) > LOOKUP_TTL_MS)
      .slice(0, 20);
    todo.forEach((k) => lookedAt.current.set(k, now));
    void Promise.all(
      todo.map((k) =>
        client
          .tokenRoom(k)
          .then((d) => parseLookup(d))
          .catch(() => null),
      ),
    ).then((found) => {
      const add = Object.fromEntries(found.filter((l): l is TokenRoomLookup => !!l).map((l) => [l.key, l]));
      if (Object.keys(add).length) setLookups((cur) => ({ ...cur, ...add }));
    });
  }, [client, handle, holdings, rooms]);

  const entries = useMemo(
    () => (holdings && rooms ? buildTokenRoomList(holdings, rooms, lookups) : null),
    [holdings, rooms, lookups],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^\$/, '');
    return (entries ?? []).filter(
      (e) => !q || e.gate.symbol.toLowerCase().includes(q) || (e.room?.name ?? '').toLowerCase().includes(q),
    );
  }, [entries, query]);

  const buy = (key: string) => {
    const ref = parseTokenKey(key);
    setLocked(null);
    if (!ref) return;
    requestMarketToken(ref);
    handleSelect(asMenuItem('market'));
  };

  const openEntry = useCallback(
    async (entry: TokenRoomEntry) => {
      setOpening(entry.key);
      try {
        await prove(entry.key);
        let room = entry.room;
        if (!room) {
          const ticker = await client.startTokenRoom(entry.key);
          room = { id: ticker, ticker, name: null, party_count: 1 };
        }
        setRooms((cur) => cur?.map((r) => (r.ticker === room!.ticker ? { ...r, unread: 0 } : r)) ?? cur);
        setOpen({ room, entry });
      } catch (e) {
        if (e instanceof ChatApiError && e.status === 401) return authLost();
        const refusal = e instanceof ChatApiError ? parseGateRefusal(e.data) : null;
        if (refusal) setLocked({ gate: refusal.gate, heldRaw: refusal.heldRaw, members: refusal.room?.members ?? null });
        else setListError(errText(e));
      } finally {
        setOpening('');
      }
    },
    [client, prove, authLost],
  );

  // "Open room" from a Wallet / Market token page.
  useEffect(() => {
    if (!handle) return;
    const take = async () => {
      const key = takeChatRoom();
      if (!key) return;
      const held = (holdings ?? (await walletHoldings(apiContext).catch(() => []))).filter((h) => `${h.kind}:${h.id}` === key);
      await prove(key);
      const look = parseLookup(await client.tokenRoom(key).catch(() => null));
      const list = buildTokenRoomList(held, rooms ?? [], look ? { [key]: look } : {});
      if (list[0]) return void openEntry(list[0]);
      // Not held (or below the minimum): show the lock with the room's real terms.
      const gate = look?.gate ?? { key, symbol: held[0]?.symbol ?? 'TOKEN', dec: held[0]?.dec ?? 0, minRaw: '1' };
      setLocked({ gate, heldRaw: look?.heldRaw ?? held[0]?.amountRaw ?? null, members: look?.room?.members ?? null });
    };
    void take();
    return onTokenNav(() => void take());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  return (
    <div
      className="flex w-full flex-col items-center overflow-x-hidden overflow-y-auto pb-36"
      style={{ height: '100%', background: BG }}
    >
      <TopNav />
      <div className="w-full pt-16 flex flex-col">
        <div className="flex items-center justify-between px-4 pb-2">
          <h1 className="text-[22px] font-bold text-white">Rooms</h1>
          <div className="flex items-center gap-1">
            {handle && (
              <span className="text-[11px] mr-1" style={{ color: MUTED }}>
                ${handle}
              </span>
            )}
            <button
              onClick={refresh}
              disabled={!handle}
              aria-label="Refresh"
              className="p-2 rounded-full active:opacity-60 disabled:opacity-30"
            >
              <RefreshCw size={18} color={MUTED} />
            </button>
          </div>
        </div>

        {!online && (
          <div
            className="mx-4 mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs"
            style={{ background: '#1a1408', color: '#e6c76a' }}
          >
            <WifiOff size={14} /> You're offline. Rooms will refresh when you reconnect.
          </div>
        )}

        {handle && entries && entries.length > 4 && (
          <div
            className="mx-4 mb-2 flex items-center gap-2 rounded-xl px-3"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          >
            <Search size={15} color={MUTED} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search rooms"
              className="flex-1 bg-transparent py-2 text-sm text-white outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} aria-label="Clear">
                <X size={14} color={MUTED} />
              </button>
            )}
          </div>
        )}

        {!handle && (
          <div className="px-6 pt-16 flex flex-col items-center text-center gap-3">
            <div
              className="h-16 w-16 rounded-2xl flex items-center justify-center"
              style={{ background: 'linear-gradient(145deg,#2a2208,#0d0b04)', border: '1px solid #3a2f0c' }}
            >
              <MessageCircle size={28} color={GOLD} />
            </div>
            <h2 className="text-lg font-bold text-white">Token rooms</h2>
            <p className="text-xs" style={{ color: MUTED }}>
              Every token you hold has a room for its holders. Signs in to bChat with this wallet's identity key — no
              password.
            </p>
            <button
              onClick={signIn}
              disabled={signingIn || !online}
              className="mt-2 rounded-2xl px-6 py-3 text-sm font-bold disabled:opacity-50"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              {signingIn ? 'Signing in…' : 'Sign in with wallet'}
            </button>
            {authError && <p className="text-xs text-[#F97066]">{authError}</p>}
          </div>
        )}

        {handle && entries === null && !listError && (
          <div className="text-center text-xs pt-10" style={{ color: MUTED }}>
            Loading rooms…
          </div>
        )}
        {handle && listError && entries === null && (
          <div className="text-center text-xs pt-10 text-[#F97066]">
            {listError}
            <div>
              <button onClick={refresh} className="mt-3 underline" style={{ color: GOLD }}>
                Try again
              </button>
            </div>
          </div>
        )}
        {handle && entries && entries.length === 0 && (
          <div className="px-8 pt-14 text-center">
            <p className="text-sm text-white font-semibold">No rooms yet</p>
            <p className="text-xs mt-1" style={{ color: MUTED }}>
              Buy a token in Market to join its room.
            </p>
            <button
              onClick={() => handleSelect(asMenuItem('market'))}
              className="mt-4 rounded-2xl px-5 py-2 text-sm font-bold inline-flex items-center gap-2"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              <ShoppingCart size={15} /> Market
            </button>
          </div>
        )}

        <ul className="w-full">
          {shown.map((e) => {
            const title = e.room?.name || (e.key.startsWith('coll:') ? e.gate.symbol : `$${e.gate.symbol}`);
            const unread = e.status === 'member' ? (e.room?.unread ?? 0) : 0;
            const sub =
              e.status === 'start'
                ? 'No room yet — tap to start it'
                : e.status === 'join'
                  ? `${e.members ?? 0} holder${e.members === 1 ? '' : 's'} · tap to join`
                  : e.room
                    ? previewText(e.room, handle || '')
                    : '';
            return (
              <li key={e.key}>
                <button
                  onClick={() => void openEntry(e)}
                  disabled={!!opening}
                  className="w-full flex items-center gap-3 px-4 py-[10px] text-left active:bg-[#111]"
                >
                  <Avatar title={e.gate.symbol} />
                  <div className="flex-1 min-w-0 pb-[10px] -mb-[10px]" style={{ borderBottom: `1px solid ${LINE}` }}>
                    <div className="flex items-baseline gap-2">
                      <span className={`flex-1 text-[15px] font-semibold text-white ${ELLIPSIS}`}>{title}</span>
                      <span className="text-[11px] shrink-0" style={{ color: unread ? GOLD : MUTED }}>
                        {opening === e.key ? 'opening…' : e.room ? listTimeLabel(e.room.last_message?.created_at ?? e.room.updated_at) : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-[2px]">
                      <span
                        className="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[10px] font-bold"
                        style={{ background: '#2a2208', color: GOLD, border: '1px solid #3a2f0c' }}
                      >
                        <Coins size={10} /> {amountLabel(e.holding.amountRaw, e.gate)}
                      </span>
                      <span className={`flex-1 text-[13px] ${ELLIPSIS}`} style={{ color: MUTED }}>
                        {sub}
                      </span>
                      {unread > 0 && (
                        <span
                          className="min-w-[20px] h-5 px-[6px] rounded-full text-[11px] font-bold flex items-center justify-center shrink-0"
                          style={{ background: GOLD, color: '#1a1300' }}
                        >
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {locked && (
        <LockedRoom
          gate={locked.gate}
          heldRaw={locked.heldRaw}
          members={locked.members}
          onBuy={() => buy(locked.gate.key)}
          onClose={() => setLocked(null)}
        />
      )}
      {open && handle && (
        <Conversation
          client={client}
          room={open.room}
          entry={open.entry}
          me={handle}
          online={online}
          onAuthLost={authLost}
          onInvite={open.entry && open.entry.key.startsWith('bsv21:') ? () => setInviting(true) : null}
          onBounties={() => setShowBounties(true)}
          onLocked={(r) => {
            setOpen(null);
            setLocked({ gate: r.gate, heldRaw: r.heldRaw, members: r.room?.members ?? null });
            refresh();
          }}
          onBack={() => {
            setOpen(null);
            refresh();
          }}
        />
      )}
      {showBounties && open && handle && (
        <BountiesSheet client={client} room={open.room} entry={open.entry} me={handle} onClose={() => setShowBounties(false)} />
      )}
      {inviting && open?.entry && (
        <InviteSheet client={client} ticker={open.room.ticker} entry={open.entry} onClose={() => setInviting(false)} />
      )}
    </div>
  );
};

export default ChatPage;
