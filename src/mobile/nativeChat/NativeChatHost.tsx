/**
 * The JS half of the native iPhone chat: feeds display rows to ios/App/App/NativeChat and answers its actions.
 * Keys, signing, money, membership and the network all stay here, through the same client the WebView room uses.
 *
 * The WebView Chat page stays mounted underneath: it owns sign-in, the rooms fetch and every sheet, and it is what a
 * room falls back to for anything the native screen doesn't draw yet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useInPeek } from '../phone/pageEl';
import { TAB_TAP } from '../tabs/tabs';
import { fetchRooms, onRooms, roomsCacheKey, sharedChatClient } from '../chat/sharedRooms';
import { noteChatAuthLost, useChatSession } from '../chat/chatSession';
import { useLive, THREAD_TYPES } from '../chat/live';
import { useRoomFeed } from '../chat/roomFeed';
import { isMarked, roomKeyOf, setArchived, setMarked, setMuted, setPinned, useListPrefs } from '../chat/listPrefs';
import { requestRoomLink } from '../chat/roomLink';
import { roomTokenGate } from '../chat/roomGate';
import { parseLookup } from '../chat/tokenRooms';
import { peekThread, readThread, warmThreadCache, writeThread } from '../chat/threadCache';
import { roomActivity, type ChatRoom } from '../chat/messages';
import { readListCache } from '../ui/listCache';
import { blockedHandles } from '../ugc/ugc';
import { NativeChat, type NativeChatAction } from './plugin';
import { NativeRoomSession, type RoomUpdate } from './roomSession';
import { diffRows, roomRows, type NativeRow } from './rows';

const THREAD_POLL_MS = 4_000;
const THREAD_LIVE_MS = 60_000;

/** A DOM overlay (TopNav menu, sheet, $b) sits where the native list is: the native view steps aside for it. */
const fixedChain = (el: Element | null): Element[] => {
  const out: Element[] = [];
  for (let n = el; n && n !== document.documentElement; n = n.parentElement)
    if (getComputedStyle(n).position === 'fixed') out.push(n);
  return out;
};

const samplePoints = (r: DOMRect) => [0.2, 0.5, 0.85].map((f) => [r.left + r.width / 2, r.top + r.height * f] as const);

const accentHex = () => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--bw-accent-hi').trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : undefined;
};

/** Live updates for the open room: the same stream and fallback poll the WebView room uses. */
const RoomLive = ({ ticker, roomId, poll }: { ticker: string; roomId: string; poll: () => void }) => {
  const ms = useLive(poll, THREAD_POLL_MS, { liveMs: THREAD_LIVE_MS, types: THREAD_TYPES, room: ticker });
  useRoomFeed(roomId, poll, true);
  useEffect(() => {
    const t = window.setInterval(poll, ms);
    return () => window.clearInterval(t);
  }, [poll, ms]);
  return null;
};

const NativeChatHost = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const session = useChatSession();
  const handle = session.kind === 'ready' ? session.handle : null;
  const identity = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const client = sharedChatClient();
  const inPeek = useInPeek();
  const probe = useRef<HTMLDivElement>(null);
  const [classic, setClassic] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [rooms, setRooms] = useState<ChatRoom[] | null>(() => readListCache<ChatRoom>(roomsCacheKey(identity)));
  const [prefs, updatePrefs] = useListPrefs(handle);
  const [openTicker, setOpenTicker] = useState<string | null>(null);
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const sessionRef = useRef<NativeRoomSession | null>(null);
  const sentRows = useRef(new Map<string, NativeRow[]>());
  const [roomsError, setRoomsError] = useState('');
  const listRows = useMemo(() => {
    if (!handle || !rooms) return null;
    const unread = openTicker ? rooms.map((r) => (r.ticker === openTicker ? { ...r, unread: 0 } : r)) : rooms;
    return roomRows(unread, handle, prefs);
  }, [rooms, prefs, handle, openTicker]);
  // With nothing to draw the WebView list stays up (it also has public and token rooms), never an empty native screen.
  const nothingToDraw = !!listRows && listRows.length === 0 && !openTicker;
  const visible = !!handle && !inPeek && !classic && !overlay && !nothingToDraw && (!!listRows || !!openTicker);

  useEffect(warmThreadCache, []);
  useEffect(() => onRooms(setRooms), []);
  useEffect(() => {
    if (handle)
      void fetchRooms(client, identity).then(
        () => setRoomsError(''),
        (e: unknown) => setRoomsError(e instanceof Error ? e.message : String(e)),
      );
  }, [client, handle, identity]);

  // Show / hide, and the rect between the web bars.
  useEffect(() => {
    if (!visible || !probe.current || !handle) {
      void NativeChat.hide();
      return;
    }
    const send = () => {
      const r = probe.current?.getBoundingClientRect();
      if (r)
        void NativeChat.show({
          top: r.top,
          left: r.left,
          width: r.width,
          height: r.height,
          me: handle,
          accent: accentHex(),
        });
    };
    send();
    window.addEventListener('resize', send);
    return () => window.removeEventListener('resize', send);
  }, [visible, handle]);
  useEffect(() => () => void NativeChat.hide(), []);

  // Signed out: nothing stays behind on the device.
  const hadHandle = useRef(!!handle);
  useEffect(() => {
    if (hadHandle.current && !handle) void NativeChat.clearCache();
    hadHandle.current = !!handle;
  }, [handle]);

  // Rooms list → native.
  useEffect(() => {
    if (listRows) void NativeChat.setRooms({ roomsJson: JSON.stringify(listRows) });
  }, [listRows]);

  // Chat tab tapped: back to the native list (and out of the full-room fallback).
  useEffect(() => {
    const onTap = (e: Event) => {
      if ((e as CustomEvent).detail !== 'chat') return;
      setClassic(false);
      void NativeChat.popToList();
    };
    window.addEventListener(TAB_TAP, onTap);
    return () => window.removeEventListener(TAB_TAP, onTap);
  }, []);

  // Back out of the full WebView room: the native list returns on its own.
  const classicRoom = useRef(false);
  useEffect(() => {
    if (!classic || !classicRoom.current) return;
    let seen = false;
    const t = window.setInterval(() => {
      const open = !!document.querySelector('.bw-room-view');
      if (open) seen = true;
      else if (seen) {
        classicRoom.current = false;
        setClassic(false);
      }
    }, 250);
    return () => window.clearInterval(t);
  }, [classic]);

  // Web overlays over the list; polled because a sheet can come from anywhere in the DOM. Skipped inside a room,
  // which is full screen and owns the display.
  useEffect(() => {
    if (!handle || inPeek || classic || openTicker) {
      setOverlay(false);
      return;
    }
    let base: Set<Element> | null = null;
    const check = () => {
      const r = probe.current?.getBoundingClientRect();
      if (!r) return;
      const chains = samplePoints(r).map(([x, y]) => fixedChain(document.elementFromPoint(x, y)));
      if (!base) {
        base = new Set(chains.flat());
        return;
      }
      setOverlay(chains.some((c) => c.some((el) => !base!.has(el))));
    };
    check();
    const t = window.setInterval(check, 250);
    return () => window.clearInterval(t);
  }, [handle, inPeek, classic, openTicker]);

  const pushRoom = useCallback((ticker: string, u: RoomUpdate) => {
    const prev = sentRows.current.get(ticker) ?? [];
    const patch = diffRows(prev, u.rows) ?? { from: u.rows.length, rows: [] as NativeRow[] };
    sentRows.current.set(ticker, u.rows);
    void NativeChat.setRoom({
      ticker,
      from: patch.from,
      rowsJson: JSON.stringify(patch.rows),
      hasMore: u.hasMore,
      cacheable: u.cacheable,
      loading: u.loading,
      error: u.error,
      composerJson: JSON.stringify(u.composer),
    });
  }, []);

  const closeSession = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    setOpenTicker(null);
  }, []);

  /** Leave the native room for the WebView one. */
  const toClassic = useCallback(
    (ticker: string) => {
      closeSession();
      void NativeChat.popToList();
      classicRoom.current = true;
      setClassic(true);
      requestRoomLink({ ref: ticker, invite: null, door: null });
    },
    [closeSession],
  );

  const openRoom = useCallback(
    (ticker: string) => {
      const room = roomsRef.current?.find((r) => r.ticker === ticker);
      if (!room || !handle) return;
      sessionRef.current?.close();
      // A fresh session starts from the whole list again on the native side.
      sentRows.current.delete(ticker);
      const gate = roomTokenGate(room.metadata);
      const s = new NativeRoomSession({
        client,
        me: handle,
        room,
        viewerIsAdmin: String(room.created_by_handle ?? '') === handle,
        cache: { peek: peekThread, read: readThread, write: writeThread },
        blocked: blockedHandles,
        charge: gate
          ? () =>
              client
                .tokenRoom(gate.key)
                .then(parseLookup)
                .then((l) => l?.spendCharge ?? null)
          : undefined,
        emit: (u) => pushRoom(ticker, u),
        onAuthLost: () => {
          closeSession();
          void NativeChat.popToList();
          noteChatAuthLost(apiContext);
        },
        onLocked: () => toClassic(ticker),
        onClassic: () => toClassic(ticker),
      });
      sessionRef.current = s;
      setOpenTicker(ticker);
      setRooms((cur) => cur?.map((r) => (r.ticker === ticker ? { ...r, unread: 0 } : r)) ?? cur);
      void s.open();
    },
    [client, handle, apiContext, pushRoom, closeSession, toClassic],
  );

  const onAction = useCallback(
    (a: NativeChatAction) => {
      switch (a.type) {
        case 'open':
          return openRoom(a.ticker);
        case 'close':
          return closeSession();
        case 'send':
          return void sessionRef.current?.send(a.text);
        case 'retry':
          return sessionRef.current?.retry(a.localId);
        case 'older':
          return void sessionRef.current?.older();
        case 'classicRoom':
          return toClassic(a.ticker);
        case 'classicList':
          return setClassic(true);
        case 'swipe': {
          const key = roomKeyOf(a.ticker);
          const room = roomsRef.current?.find((r) => r.ticker === a.ticker);
          if (a.action === 'pin' || a.action === 'unpin') updatePrefs((p) => setPinned(p, key, a.action === 'pin'));
          else if (a.action === 'mute' || a.action === 'unmute')
            updatePrefs((p) => setMuted(p, key, a.action === 'mute'));
          else if (a.action === 'archive' && room) updatePrefs((p) => setArchived(p, key, true, roomActivity(room)));
          else if (a.action === 'unread') updatePrefs((p) => setMarked(p, key, true));
          else if (a.action === 'read') {
            updatePrefs((p) => (isMarked(p, key) ? setMarked(p, key, false) : p));
            setRooms((cur) => cur?.map((r) => (r.ticker === a.ticker ? { ...r, unread: 0 } : r)) ?? cur);
            void client.markRead(a.ticker).catch(() => {});
          }
          return;
        }
      }
    },
    [openRoom, closeSession, toClassic, updatePrefs, client],
  );
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;

  useEffect(() => {
    const h = NativeChat.addListener('action', (a) => onActionRef.current(a));
    return () => {
      void h.then((x) => x.remove());
    };
  }, []);

  useEffect(() => () => sessionRef.current?.close(), []);

  const openRoomRow = openTicker ? rooms?.find((r) => r.ticker === openTicker) : null;
  return (
    <>
      <div
        ref={probe}
        className="bw-between-bars"
        style={{ visibility: 'hidden', pointerEvents: 'none' }}
        aria-hidden
      />
      {/* Test builds only, until we know why the native list came back empty (owner, 9 Nov 2026). */}
      {nothingToDraw && !inPeek && !classic && !overlay && (
        <div
          className="fixed left-0 right-0 text-center text-[10px] pointer-events-none"
          style={{ bottom: 'calc(env(safe-area-inset-bottom) + 72px)', color: '#9a9a9a', zIndex: 40 }}
        >
          Native list: {rooms?.length ?? 0} received, 0 shown{roomsError ? `, ${roomsError}` : ''}
        </div>
      )}
      {openTicker && openRoomRow && sessionRef.current && (
        <RoomLive ticker={openTicker} roomId={openRoomRow.id} poll={sessionRef.current.poll} />
      )}
    </>
  );
};

export default NativeChatHost;
