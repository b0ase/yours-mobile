/**
 * bSpaces (docs/BSPACES-PLAN.md): the pure half. Parses bit-sign's rooms/[ticker]/space responses and
 * derives what the screen shows: the stage, the audience, the hand queue, and the moment you are
 * brought on stage. No React, no LiveKit, so it is unit-tested (model.test.ts).
 *
 * The server is the authority on roles: the stage is whatever the participant rows say, and the
 * LiveKit token is minted from your row. Nothing here grants anything.
 */

export type SpaceRole = 'host' | 'speaker' | 'listener';
export type SpaceMode = 'stage' | 'meeting';

export interface Space {
  id: string;
  title: string | null;
  host: string;
  transport: 'mesh' | 'sfu' | string;
  max: number;
  startedAt: string;
  /** 'meeting' once bit-sign has the column (plan Phase 2); 'stage' until then. */
  mode: SpaceMode;
}

export interface Participant {
  handle: string;
  role: SpaceRole;
  handRaisedAt: string | null;
}

export interface SpaceState {
  space: Space | null;
  participants: Participant[];
  me: Participant | null;
  /** A host-started recording is running: show "● Recording" to everyone. */
  recording?: boolean;
  /** When the recording started (bit-sign recording.started_at), if sent. */
  recordingSince?: string | null;
  /** I may start/stop a recording (room boss: host, room admin, named host). bit-sign decides. */
  mayRecord?: boolean;
}

export interface SpaceToken {
  token: string;
  url: string;
  role: SpaceRole;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const norm = (h: string) => h.trim().replace(/^\$/, '').toLowerCase();
const roleOf = (v: unknown): SpaceRole => (v === 'host' || v === 'speaker' ? v : 'listener');

const parseParticipant = (v: unknown): Participant | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const handle = str(o.handle);
  if (!handle) return null;
  return { handle: norm(handle), role: roleOf(o.role), handRaisedAt: str(o.hand_raised_at) };
};

const parseSpace = (v: unknown): Space | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const host = str(o.host_handle);
  if (!id || !host || o.status === 'ended') return null;
  return {
    id,
    title: str(o.title),
    host: norm(host),
    transport: str(o.transport) ?? 'mesh',
    max: typeof o.max_participants === 'number' ? o.max_participants : 0,
    startedAt: str(o.started_at) ?? '',
    mode: o.mode === 'meeting' ? 'meeting' : 'stage',
  };
};

/** GET / POST join responses → state. Anything malformed reads as "no live space". */
export const parseSpaceState = (data: unknown, me: string): SpaceState => {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const space = parseSpace(o.space);
  if (!space) return { space: null, participants: [], me: null };
  const participants = (Array.isArray(o.participants) ? o.participants : [])
    .map(parseParticipant)
    .filter((p): p is Participant => !!p);
  const mine = norm(me);
  const rec = o.recording && typeof o.recording === 'object' ? (o.recording as Record<string, unknown>) : null;
  return {
    space,
    participants,
    me: participants.find((p) => p.handle === mine) ?? null,
    recording: rec?.active === true,
    recordingSince: rec?.active === true ? str(rec.started_at) : null,
    mayRecord: o.may_record === true,
  };
};

// ── Green room (bit-sign rooms/[ticker]/space/green-room) ──────────────────────────────────

export const ANON_EXPLAINER = "While listening anonymously you won't be visible, can't speak or send reactions.";
export const RECORDING_NOTICE = 'This Space is being recorded';

export interface GreenRoom {
  live: boolean;
  title: string | null;
  listening: number;
  anonymous: number | null;
  stage: { handle: string; role: SpaceRole; avatar: string | null }[];
  recording: boolean;
  ticketed: boolean;
}

export const parseGreenRoom = (data: unknown): GreenRoom | null => {
  const o = (data && typeof data === 'object' ? data : null) as Record<string, unknown> | null;
  if (!o || o.live !== true) return null;
  const stage = (Array.isArray(o.stage) ? o.stage : [])
    .map((v) => {
      const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      const handle = str(p.handle);
      return handle ? { handle: norm(handle), role: roleOf(p.role), avatar: str(p.avatar_url) } : null;
    })
    .filter((p): p is GreenRoom['stage'][number] => !!p);
  const rec = o.recording && typeof o.recording === 'object' ? (o.recording as Record<string, unknown>) : null;
  return {
    live: true,
    title: str(o.title),
    listening: typeof o.listening === 'number' ? o.listening : 0,
    anonymous: typeof o.anonymous_listeners === 'number' ? o.anonymous_listeners : null,
    stage,
    recording: rec?.active === true,
    ticketed: o.ticketed === true,
  };
};

/** The green room's one button. A ticket still to buy outranks the anonymity choice. */
export const greenRoomPrimary = (o: { anonymous: boolean; needsTicket: boolean }) =>
  o.needsTicket ? 'Pay 1¢ to join' : o.anonymous ? 'Start listening anonymously' : 'Start listening';

/** Anonymous listeners have no participant row and no data channel: no hand. */
export const mayRaiseHand = (o: { anonymous: boolean; role: SpaceRole | null | undefined }) =>
  !o.anonymous && o.role === 'listener';

export const parseSpaceToken = (data: unknown): SpaceToken | null => {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const token = str(o.token);
  const url = str(o.url);
  return token && url ? { token, url, role: roleOf(o.role) } : null;
};

/** The wallet speaks LiveKit only. A 'mesh' space (no SFU on the server) needs bChat on the web. */
export const supportedTransport = (space: Space) => space.transport === 'sfu';

export const isOnStage = (role: SpaceRole | null | undefined) => role === 'host' || role === 'speaker';

/** Host first, then speakers in the server's order. */
export const stageOf = (s: SpaceState): Participant[] => {
  const on = s.participants.filter((p) => isOnStage(p.role));
  return [...on.filter((p) => p.role === 'host'), ...on.filter((p) => p.role !== 'host')];
};

/** Raised hands, oldest first (the server already sorts them first). */
export const handQueue = (s: SpaceState): Participant[] =>
  s.participants
    .filter((p) => p.role === 'listener' && p.handRaisedAt)
    .sort((a, b) => (a.handRaisedAt ?? '').localeCompare(b.handRaisedAt ?? ''));

export const audienceCount = (s: SpaceState) => s.participants.filter((p) => p.role === 'listener').length;

/**
 * What changed for me between two polls.
 * - 'invited': the host brought me on stage. The SFU already lets me publish; the wallet still asks
 *   before opening the mic or camera, and Decline steps down (bit-sign `step_down`).
 * - 'demoted': back to the audience. The SFU has already revoked publishing; switch devices off.
 * - 'ended': the space is over (or I was removed).
 */
export type MyChange = 'invited' | 'demoted' | 'ended' | null;
export const myChange = (prev: SpaceState | null, next: SpaceState): MyChange => {
  if (!prev?.space) return null;
  if (!next.space || next.space.id !== prev.space.id) return 'ended';
  const was = prev.me?.role;
  const now = next.me?.role;
  if (was === 'listener' && now === 'speaker') return 'invited';
  if (was === 'speaker' && now === 'listener') return 'demoted';
  return null;
};

/**
 * May this wallet start a space in this room? Product rule (owner, 8 Oct 2026): the token's issuer
 * or the room's admin. bit-sign lets any member start one; the wallet only offers it to these.
 */
export const canHostRoom = (opts: {
  me: string;
  createdBy?: string | null;
  youAreIssuer?: boolean;
  /** An open-stage room (roomSpaceOpen): any signed-in member may start its one Space. */
  spaceOpen?: boolean;
}) =>
  (!!opts.spaceOpen && !!norm(opts.me)) ||
  !!opts.youAreIssuer ||
  (!!opts.createdBy && norm(opts.createdBy) === norm(opts.me));

/** Rooms that always count as open stage, before bit-sign's `metadata.space_open` flag ships. */
export const OPEN_STAGE_TICKERS = ['LOUNGE'];

/**
 * Open stage (owner, 9 Oct 2026): "the lounge space is either open or not open". A room marked
 * `metadata.space_open` lets any member start a Space; still only one Space per room.
 */
export const roomSpaceOpen = (room: { ticker?: string | null; metadata?: unknown } | null | undefined): boolean => {
  if (!room) return false;
  const m = room.metadata as { space_open?: unknown; spaceOpen?: unknown } | null | undefined;
  if (m && (m.space_open === true || m.spaceOpen === true)) return true;
  return OPEN_STAGE_TICKERS.includes(String(room.ticker ?? '').replace(/^\$/, '').toUpperCase());
};

// ── Always-open rooms (bit-sign PR #117: always_open, room_host, host_label, always_here) ──────

/** A non-person always on stage (today only b, the bWalletX agent). Never a listener, never speaks. */
export interface AlwaysHere {
  handle: string;
  kind: 'agent' | string;
  label: string;
}

export interface RoomSpaceMeta {
  /** The room's Space never ends: Join, never "Start a Space"; Leave, never End. */
  alwaysOpen: boolean;
  /** "Hosted by …" for an always-open room (bWalletX for the Lounge). */
  hostLabel: string | null;
  alwaysHere: AlwaysHere[];
}

/** Rooms that are always open before bit-sign says so (the Lounge). */
export const ALWAYS_OPEN_TICKERS = ['LOUNGE'];
const tickerKey = (t: string | null | undefined) => String(t ?? '').replace(/^\$/, '').toUpperCase();
export const isAlwaysOpenTicker = (t: string | null | undefined) => ALWAYS_OPEN_TICKERS.includes(tickerKey(t));

/**
 * The room half of GET rooms/[ticker]/space, read even when `space` is null. Older servers send none
 * of it (all false/empty); a server with always_open but no host_label (pre #117) gets "bWalletX"
 * for the Lounge, whose room_host is 'bwalletx'.
 */
export const parseRoomSpaceMeta = (data: unknown, ticker?: string | null): RoomSpaceMeta => {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const alwaysOpen = o.always_open === true;
  let hostLabel = str(o.host_label);
  if (alwaysOpen && !hostLabel && (o.room_host === 'bwalletx' || isAlwaysOpenTicker(ticker))) hostLabel = 'bWalletX';
  const alwaysHere = (Array.isArray(o.always_here) ? o.always_here : [])
    .map((v): AlwaysHere | null => {
      const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      const handle = str(r.handle);
      return handle ? { handle: norm(handle), kind: str(r.kind) ?? 'agent', label: str(r.label) ?? norm(handle) } : null;
    })
    .filter((v): v is AlwaysHere => !!v);
  return { alwaysOpen, hostLabel: alwaysOpen ? hostLabel : null, alwaysHere: alwaysOpen ? alwaysHere : [] };
};

/** The always-open room's one bar: Join, whether or not anyone is on stage yet. */
export const alwaysOpenBarText = (ticker: string, roomName: string) =>
  `Join ${tickerKey(ticker) === 'LOUNGE' ? 'the Lounge' : roomName} · Open 24/7`;

/** The agent tile's caption (b on an always-open stage). */
export const alwaysHereCaption = (a: AlwaysHere) => (a.handle === 'b' ? 'bWalletX agent · always here' : `${a.label} · always here`);

/** Always-open rooms have no host to end it: whoever started is just on stage. */
export const mayEndSpace = (o: { isHost: boolean; alwaysOpen: boolean }) => o.isHost && !o.alwaysOpen;

/** "1 listening", "12 listening". */
export const audienceLine = (n: number) => `${n} listening`;

export const elapsed = (startedAt: string, now = Date.now()): string => {
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/**
 * The Chat tab's Spaces filter: rooms whose space is on, live ones first (bit-sign has no scheduled
 * spaces yet, so every row is live today), then the biggest audience, then the most recent start.
 */
export const roomsWithSpaces = <T extends { state: SpaceState }>(rows: T[]): T[] =>
  rows
    .filter((r) => r.state.space)
    .sort(
      (a, b) =>
        audienceCount(b.state) - audienceCount(a.state) ||
        (b.state.space?.startedAt ?? '').localeCompare(a.state.space?.startedAt ?? ''),
    );

// ── Moderation, join as speaker, room mute, screen awake (Lounge test, 9 Oct 2026) ──────────

/**
 * Who may mute / move / remove a speaker from the stage: the live host, or a room admin / named host
 * (the wallet knows the latter as `canInvite`). bit-sign checks again (space-moderation-rules.ts).
 */
export const mayModerate = (o: { isHost: boolean; roomBoss?: boolean }) => o.isHost || !!o.roomBoss;

/** Which stage tiles get the moderator menu: never yourself, never the live host. */
export const moderatable = (p: Participant, o: { me: string; spaceHost: string; moderator: boolean }) =>
  o.moderator && p.role === 'speaker' && p.handle !== norm(o.me) && p.handle !== norm(o.spaceHost);

/**
 * "Join as speaker": straight on stage in an open-stage room or for a room boss (mic muted until you
 * tap), otherwise a listener with the hand already up. bit-sign decides for real (`as: 'speaker'`).
 */
export const joinAsSpeakerOutcome = (o: { spaceOpen: boolean; roomBoss: boolean }): 'speaker' | 'hand' =>
  o.spaceOpen || o.roomBoss ? 'speaker' : 'hand';

/** The green room's default: hosts / room admins and open stages default to speaking. */
export const defaultJoinAs = (o: { spaceOpen: boolean; roomBoss: boolean }): 'speaker' | 'listener' =>
  o.roomBoss ? 'speaker' : 'listener';

/**
 * Keep the screen awake for anyone in a live Space — host, speaker or listener (owner: the phone
 * went to sleep mid-Space). Off once I leave or the Space is over; the ⋯ toggle can turn it off.
 */
export const wantsWakeLock = (o: { live: boolean; enabled: boolean }) => o.enabled && o.live;

/**
 * The participants reply to an action (`hand`, `role`, `mute`…) carries no space: keep ours and the
 * recording flags from the last full state, so a reply never drops "● Recording" or the Record button.
 * A reply without a participants array changes nothing (null).
 */
export const applyParticipantsReply = (cur: SpaceState, reply: unknown, me: string): SpaceState | null => {
  const o = reply && typeof reply === 'object' ? (reply as Record<string, unknown>) : null;
  if (!o || !Array.isArray(o.participants) || !cur.space) return null;
  const participants = o.participants.map(parseParticipant).filter((p): p is Participant => !!p);
  const mine = norm(me);
  return { ...cur, participants, me: participants.find((p) => p.handle === mine) ?? null };
};

/** "Ana ($ana)" when the host chose a display name, else "$ana". */
export const hostLabel = (handle: string, name: string | null | undefined) => {
  const n = (name ?? '').trim();
  return n && n.toLowerCase() !== handle.toLowerCase() ? n : `$${handle}`;
};
