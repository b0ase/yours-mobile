import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, BellOff, BellRing, Check } from 'lucide-react';
import { loadSession } from '../chat/api';
import { useBackClose } from '../backStack';
import { ROOM_NOTIFY_OPTIONS, roomNotifyFor, type RoomNotify } from './logic';
import { PushApi } from './register';

/**
 * Chat room header bell: All / Mentions / Off for this group (PUT /v1/rooms/:ticker/prefs). Groups
 * default to Mentions; DMs always notify, so they get no bell.
 */
const GOLD = '#FFD24D';
const MUTED = '#8a8f98';
const PANEL = '#121316';
const LINE = '#1f2127';

// This session's room settings, fetched once (and dropped when the bChat session changes).
let cache: Record<string, RoomNotify> | null = null;
let cacheBearer: string | null = null;
let loading: Promise<Record<string, RoomNotify>> | null = null;
const loadRoomPrefs = (bearer: string) => {
  if (cacheBearer !== bearer) {
    cache = null;
    cacheBearer = bearer;
  }
  if (cache) return Promise.resolve(cache);
  loading ??= new PushApi(bearer)
    .roomPrefs()
    .then((r) => (cache = r.rooms ?? {}))
    .finally(() => (loading = null));
  return loading;
};

const Sheet = ({
  value,
  busy,
  error,
  onPick,
  onClose,
}: {
  value: RoomNotify;
  busy: boolean;
  error: string;
  onPick: (v: RoomNotify) => void;
  onClose: () => void;
}) => {
  useBackClose(true, onClose);
  return createPortal(
    <div
      className="fixed inset-0 z-[150] flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,.6)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl p-4"
        style={{
          background: PANEL,
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'max(env(safe-area-inset-bottom), 16px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-1 text-[15px] font-bold text-white">Notifications for this room</p>
        <p className="mb-3 text-xs" style={{ color: MUTED }}>
          Push notifications on this and your other devices.
        </p>
        {ROOM_NOTIFY_OPTIONS.map((o) => (
          <button
            key={o.id}
            disabled={busy}
            onClick={() => onPick(o.id)}
            className="mb-2 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left active:opacity-70"
            style={{ background: '#0b0b0b', border: `1px solid ${value === o.id ? GOLD : LINE}` }}
          >
            <div className="flex-1">
              <div className="text-sm font-semibold text-white">{o.label}</div>
              <div className="text-xs" style={{ color: MUTED }}>
                {o.note}
              </div>
            </div>
            {value === o.id && <Check size={18} color={GOLD} />}
          </button>
        ))}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    </div>,
    document.body,
  );
};

export const RoomBell = ({ ticker }: { ticker: string }) => {
  const bearer = loadSession()?.token ?? null;
  const [value, setValue] = useState<RoomNotify>(() => roomNotifyFor(cache, ticker));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!bearer) return;
    let live = true;
    loadRoomPrefs(bearer)
      .then((p) => live && setValue(roomNotifyFor(p, ticker)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bearer, ticker]);

  if (!bearer) return null;
  const pick = async (v: RoomNotify) => {
    setBusy(true);
    setError('');
    try {
      await new PushApi(bearer).putRoomPref(ticker, v);
      const t = ticker.replace(/^\$/, '').toUpperCase();
      cache = { ...(cache ?? {}), [t]: v };
      setValue(v);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  const Icon = value === 'all' ? BellRing : value === 'off' ? BellOff : Bell;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="p-2 rounded-full active:opacity-60"
        aria-label={`Notifications: ${ROOM_NOTIFY_OPTIONS.find((o) => o.id === value)?.label}`}
      >
        <Icon size={19} color={value === 'off' ? MUTED : GOLD} />
      </button>
      {open && (
        <Sheet value={value} busy={busy} error={error} onPick={(v) => void pick(v)} onClose={() => setOpen(false)} />
      )}
    </>
  );
};
