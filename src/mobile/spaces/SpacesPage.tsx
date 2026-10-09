/**
 * bSpaces home (Apps › bSpaces, /m/spaces): live spaces in the token rooms you're in, with Join, and
 * the rooms you run, with Start. bWalletX only (storeBuild.ts BSPACES_ENABLED).
 *
 * bit-sign has no "live spaces for me" endpoint yet, so this asks each of your token rooms (capped,
 * a few at a time). Plan: one GET /api/bitsign/spaces/live (docs/BSPACES-PLAN.md, Phase 2).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Radio, RefreshCw } from 'lucide-react';
import { isNative } from '../native';
import { BchatClient, defaultHttp, loadSession } from '../chat/api';
import { roomTitle, type ChatRoom } from '../chat/messages';
import { audienceCount, audienceLine, canHostRoom, parseSpaceState, roomSpaceOpen, stageOf, type SpaceState } from './model';
import { SpaceScreen } from './SpaceScreen';
import { DoorKeeper } from './DoorKeeper';
import { InviteCard, type SpaceLink } from './InviteCard';
import { isSpaceInviteCode, isSpaceSlug } from './invite';
import { inBatches, MAX_ROOMS } from './roomSpaces';

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';
const LINE = '#1f2127';
type Row = { room: ChatRoom; state: SpaceState };
const PARALLEL = 5;

const SpacesPage = () => {
  const navigate = useNavigate();
  const client = useMemo(() => new BchatClient(defaultHttp(isNative), loadSession()), []);
  const me = client.handle ?? '';
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<{
    ticker: string;
    name: string;
    start?: string;
    admin?: boolean;
    spaceOpen?: boolean;
    hostName?: string | null;
  } | null>(null);
  const openRoom = (room: ChatRoom, start?: string) =>
    setOpen({
      ticker: room.ticker,
      name: roomTitle(room, me),
      start,
      admin: canHostRoom({ me, createdBy: room.created_by_handle }),
      spaceOpen: roomSpaceOpen(room),
    });
  // A link (inviteLinks.ts) lands here as ?invite=<code> (ephemeral) or ?space=<slug> (the Space page).
  const [params, setParams] = useSearchParams();
  const inviteCode = params.get('invite') ?? '';
  const spaceSlug = params.get('space') ?? '';
  const spaceLink: SpaceLink | null = isSpaceInviteCode(inviteCode)
    ? { kind: 'invite', code: inviteCode }
    : isSpaceSlug(spaceSlug)
      ? { kind: 'space', slug: spaceSlug }
      : null;
  const clearInvite = () => {
    const next = new URLSearchParams(params);
    next.delete('invite');
    next.delete('space');
    setParams(next, { replace: true });
  };
  const showSpacePage = (slug: string) => {
    const next = new URLSearchParams(params);
    next.delete('invite');
    next.set('space', slug);
    setParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    if (!client.handle) return;
    setError('');
    try {
      const rooms = (await client.rooms()).slice(0, MAX_ROOMS);
      const got = await inBatches(rooms, PARALLEL, async (room) => ({
        room,
        state: parseSpaceState(await client.space(room.ticker).catch(() => null), me),
      }));
      setRows(got);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, [client, me]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  const live = (rows ?? []).filter((r) => r.state.space);
  const hostable = (rows ?? []).filter(
    (r) => !r.state.space && canHostRoom({ me, createdBy: r.room.created_by_handle, spaceOpen: roomSpaceOpen(r.room) }),
  );

  return (
    <div className="min-h-full flex flex-col" style={{ background: '#010101', color: '#fff' }}>
      <header className="flex items-center gap-2 px-2 py-2" style={{ borderBottom: `1px solid ${LINE}` }}>
        <button onClick={() => navigate(-1)} className="p-2" aria-label="Back">
          <ArrowLeft size={22} color={GOLD} />
        </button>
        <div className="flex-1">
          <div className="text-[17px] font-bold">bSpaces</div>
          <div className="text-[11px]" style={{ color: MUTED }}>
            Live audio and video in your token rooms
          </div>
        </div>
        <button onClick={() => void load()} className="p-2" aria-label="Refresh">
          <RefreshCw size={18} color={MUTED} />
        </button>
      </header>

      {spaceLink && (
        <InviteCard
          client={client}
          link={spaceLink}
          me={me}
          onJoin={(inv) => setOpen({ ticker: inv.ticker, name: inv.roomName, hostName: inv.kind === 'space' ? inv.hostName : null })}
          onOpenSpacePage={showSpacePage}
          onClose={clearInvite}
        />
      )}

      {!client.handle ? (
        <Empty>
          Open Chat once to sign in to rooms, then come back.
          <button
            onClick={() => navigate('/m/chat')}
            className="mt-4 rounded-full px-5 py-2 font-semibold"
            style={{ background: GOLD, color: '#010101' }}
          >
            Open Chat
          </button>
        </Empty>
      ) : rows === null ? (
        <Empty>
          <Radio size={28} color={GOLD} className="animate-pulse" />
        </Empty>
      ) : (
        <div className="flex-1 overflow-y-auto pb-24">
          <Label>Live now</Label>
          {live.length === 0 && (
            <p className="px-4 text-sm" style={{ color: MUTED }}>
              No live spaces in your rooms right now.
            </p>
          )}
          {live.map(({ room, state }) => (
            <button
              key={room.ticker}
              onClick={() => openRoom(room)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left"
              style={{ borderBottom: `1px solid ${LINE}` }}
            >
              <span
                className="h-11 w-11 rounded-full flex items-center justify-center"
                style={{ background: '#D92D20' }}
              >
                <Radio size={20} color="#fff" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block font-semibold truncate">{state.space?.title || roomTitle(room, me)}</span>
                <span className="block text-xs truncate" style={{ color: MUTED }}>
                  {roomTitle(room, me)} ·{' '}
                  {stageOf(state)
                    .map((p) => `$${p.handle}`)
                    .slice(0, 3)
                    .join(', ')}{' '}
                  · {audienceLine(audienceCount(state))}
                </span>
              </span>
              <span className="rounded-full px-3 py-1 text-xs font-bold" style={{ background: GOLD, color: '#010101' }}>
                Join
              </span>
            </button>
          ))}

          {hostable.length > 0 && <Label>Start one in a room you run</Label>}
          {hostable.map(({ room }) => (
            <div
              key={room.ticker}
              className="flex items-center gap-3 px-4 py-3"
              style={{ borderBottom: `1px solid ${LINE}` }}
            >
              <span className="flex-1 truncate">{roomTitle(room, me)}</span>
              <button
                onClick={() => openRoom(room, roomTitle(room, me))}
                className="rounded-full px-3 py-1 text-xs font-semibold"
                style={{ border: `1px solid ${GOLD}`, color: GOLD }}
              >
                Go live
              </button>
            </div>
          ))}
          <p className="px-4 pt-4 text-xs" style={{ color: MUTED }}>
            Token issuers can also start a space from their room’s chat. Only holders of a room’s token can join its
            space.
          </p>
          {error && (
            <p className="px-4 pt-2 text-xs" style={{ color: '#F97066' }}>
              {error}
            </p>
          )}
        </div>
      )}

      {open && <DoorKeeper client={client} ticker={open.ticker} me={me} />}
      {open && (
        <SpaceScreen
          client={client}
          ticker={open.ticker}
          roomName={open.name}
          me={me}
          startTitle={open.start}
          canInvite={open.admin}
          spaceOpen={open.spaceOpen}
          hostName={open.hostName}
          onClose={() => {
            setOpen(null);
            void load();
          }}
        />
      )}
    </div>
  );
};

const Label = ({ children }: { children: React.ReactNode }) => (
  <h2 className="px-4 pt-5 pb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: MUTED }}>
    {children}
  </h2>
);

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="flex-1 flex flex-col items-center justify-center px-8 text-center text-sm" style={{ color: MUTED }}>
    {children}
  </div>
);

export default SpacesPage;
